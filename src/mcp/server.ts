import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { getConnection, closeConnection } from '../db/connection.js';
import { KnowledgeRepository } from '../knowledge/repository.js';
import { KnowledgeSearch } from '../knowledge/search.js';
import { OpenAIEmbeddingEngine } from '../embeddings/api.js';
import { FallbackEmbeddingEngine } from '../embeddings/fallback.js';
import { findNousDir, loadConfig } from '../utils/config.js';
import type { KnowledgeType, RelationType } from '../knowledge/types.js';
import type { EmbeddingEngine } from '../embeddings/engine.js';

export function createMcpServer(): { server: McpServer; cleanup: () => void } {
  const nousDir = findNousDir();
  if (!nousDir) {
    throw new Error('No .nous/ directory found. Run `nous init` first.');
  }

  const config = loadConfig(nousDir);
  const dbPath = join(nousDir, 'knowledge.db');
  const db = getConnection(dbPath);
  const repo = new KnowledgeRepository(db);

  // Initialize embedding engine
  const apiKey = config.openai_api_key ?? process.env['OPENAI_API_KEY'];
  const embeddings: EmbeddingEngine = apiKey
    ? new OpenAIEmbeddingEngine(apiKey)
    : new FallbackEmbeddingEngine();
  const search = new KnowledgeSearch(db, embeddings);

  const server = new McpServer(
    { name: 'nous', version: '0.1.0' },
    {
      instructions:
        'Nous is the project knowledge brain. Query it to understand how things work, why decisions were made, and what patterns to follow. Teach it new knowledge from conversations.',
    },
  );

  // ── Tool 1: nous_query ──────────────────────────────────────
  server.tool(
    'nous_query',
    'Search the project brain using hybrid keyword + semantic search. Use this to find relevant knowledge about any topic.',
    {
      query: z.string().describe('What to search for (natural language)'),
      type: z.enum(['concept', 'decision', 'pattern']).optional().describe('Filter by knowledge type'),
      scope: z.string().optional().describe('Filter by scope (backend, frontend, infra, api)'),
      limit: z.number().optional().default(5).describe('Max results to return'),
    },
    async ({ query, type, scope, limit }) => {
      const results = await search.search({ query, type, scope, limit });
      return {
        content: [
          {
            type: 'text' as const,
            text: results.length === 0
              ? 'No knowledge found matching that query.'
              : results
                  .map(
                    (r) =>
                      `[${r.entry.type}] ${r.entry.title} (score: ${r.score.toFixed(3)}, source: ${r.source})\n${r.entry.content}\ntags: ${r.entry.tags.join(', ') || 'none'} | scope: ${r.entry.scope || 'general'} | id: ${r.entry.id}`,
                  )
                  .join('\n\n---\n\n'),
          },
        ],
      };
    },
  );

  // ── Tool 2: nous_teach ──────────────────────────────────────
  server.tool(
    'nous_teach',
    'Add new knowledge to the project brain. Use this when you learn something important about the project.',
    {
      type: z.enum(['concept', 'decision', 'pattern']).describe('concept = how something works, decision = why something was chosen, pattern = when/always/never rules'),
      title: z.string().describe('Short title for this knowledge'),
      content: z.string().describe('Full explanation (Markdown OK)'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      scope: z.string().optional().describe('Scope: backend, frontend, infra, api'),
      metadata: z.record(z.unknown()).optional().describe('Type-specific structured data'),
    },
    async ({ type, title, content, tags, scope, metadata }) => {
      const entry = repo.insert({
        type,
        title,
        content,
        tags: tags ?? [],
        scope: scope ?? '',
        metadata: metadata ?? {},
      });

      // Generate and store embedding
      if (embeddings.isAvailable()) {
        const vec = await embeddings.embed(`${title} ${content}`);
        if (vec) {
          search.storeEmbedding(entry.id, vec, embeddings.modelName());
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Learned ${entry.type}: "${entry.title}" (id: ${entry.id})`,
          },
        ],
      };
    },
  );

  // ── Tool 3: nous_recall ─────────────────────────────────────
  server.tool(
    'nous_recall',
    'Recall a specific knowledge entry by ID or exact title.',
    {
      id: z.string().optional().describe('Knowledge entry ID (ULID)'),
      title: z.string().optional().describe('Exact title to look up'),
    },
    async ({ id, title }) => {
      const entry = id ? repo.getById(id) : title ? repo.getByTitle(title) : null;

      if (!entry) {
        return { content: [{ type: 'text' as const, text: 'Entry not found.' }] };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `[${entry.type}] ${entry.title}\n\n${entry.content}\n\ntags: ${entry.tags.join(', ') || 'none'}\nscope: ${entry.scope || 'general'}\nconfidence: ${entry.confidence}\nsource: ${entry.source}\nid: ${entry.id}\ncreated: ${entry.created_at}`,
          },
        ],
      };
    },
  );

  // ── Tool 4: nous_update ─────────────────────────────────────
  server.tool(
    'nous_update',
    'Update an existing knowledge entry.',
    {
      id: z.string().describe('Knowledge entry ID to update'),
      title: z.string().optional().describe('New title'),
      content: z.string().optional().describe('New content'),
      tags: z.array(z.string()).optional().describe('New tags'),
      scope: z.string().optional().describe('New scope'),
      confidence: z.number().min(0).max(1).optional().describe('New confidence score'),
    },
    async ({ id, title, content, tags, scope, confidence }) => {
      const updated = repo.update(id, { title, content, tags, scope, confidence });

      if (!updated) {
        return { content: [{ type: 'text' as const, text: `Entry ${id} not found.` }] };
      }

      // Re-embed if content changed
      if ((title || content) && embeddings.isAvailable()) {
        const vec = await embeddings.embed(`${updated.title} ${updated.content}`);
        if (vec) {
          search.storeEmbedding(updated.id, vec, embeddings.modelName());
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated: "${updated.title}" (id: ${updated.id})`,
          },
        ],
      };
    },
  );

  // ── Tool 5: nous_relate ─────────────────────────────────────
  server.tool(
    'nous_relate',
    'Create or query relationships between knowledge entries.',
    {
      action: z.enum(['create', 'query']).describe('create a relationship or query existing ones'),
      from_id: z.string().optional().describe('Source entry ID (required for create)'),
      to_id: z.string().optional().describe('Target entry ID (required for create)'),
      relation_type: z.string().optional().describe('depends_on, implements, supersedes, related_to, requires, extends'),
      id: z.string().optional().describe('Entry ID to query relationships for'),
    },
    async ({ action, from_id, to_id, relation_type, id: entryId }) => {
      if (action === 'create') {
        if (!from_id || !to_id || !relation_type) {
          return { content: [{ type: 'text' as const, text: 'create requires from_id, to_id, and relation_type' }] };
        }
        const { generateId } = await import('../utils/id.js');
        const relId = generateId();
        try {
          db.prepare(
            'INSERT INTO relationships (id, from_id, to_id, relation_type) VALUES (?, ?, ?, ?)',
          ).run(relId, from_id, to_id, relation_type);
          return { content: [{ type: 'text' as const, text: `Relationship created: ${from_id} --[${relation_type}]--> ${to_id}` }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }

      // Query relationships for a given entry
      const queryId = entryId ?? from_id;
      if (!queryId) {
        return { content: [{ type: 'text' as const, text: 'Provide an id or from_id to query relationships.' }] };
      }

      const outgoing = db
        .prepare(
          `SELECT r.relation_type, k.title, k.type, k.id
           FROM relationships r JOIN knowledge k ON k.id = r.to_id
           WHERE r.from_id = ?`,
        )
        .all(queryId) as { relation_type: string; title: string; type: string; id: string }[];

      const incoming = db
        .prepare(
          `SELECT r.relation_type, k.title, k.type, k.id
           FROM relationships r JOIN knowledge k ON k.id = r.from_id
           WHERE r.to_id = ?`,
        )
        .all(queryId) as { relation_type: string; title: string; type: string; id: string }[];

      const lines: string[] = [];
      if (outgoing.length > 0) {
        lines.push('Outgoing:');
        for (const r of outgoing) lines.push(`  --[${r.relation_type}]--> [${r.type}] ${r.title} (${r.id})`);
      }
      if (incoming.length > 0) {
        lines.push('Incoming:');
        for (const r of incoming) lines.push(`  <--[${r.relation_type}]-- [${r.type}] ${r.title} (${r.id})`);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: lines.length > 0 ? lines.join('\n') : 'No relationships found.',
          },
        ],
      };
    },
  );

  // ── Tool 6: nous_forget ─────────────────────────────────────
  server.tool(
    'nous_forget',
    'Deprecate or delete a knowledge entry. Prefer deprecation over deletion.',
    {
      id: z.string().describe('Knowledge entry ID'),
      action: z.enum(['deprecate', 'delete']).describe('deprecate (recommended) or delete permanently'),
      reason: z.string().optional().describe('Why this entry is being removed'),
      superseded_by: z.string().optional().describe('ID of the replacement entry (for deprecation)'),
    },
    async ({ id, action, superseded_by }) => {
      if (action === 'delete') {
        const deleted = repo.delete(id);
        if (deleted) search.removeEmbedding(id);
        return {
          content: [{ type: 'text' as const, text: deleted ? `Deleted entry ${id}` : `Entry ${id} not found.` }],
        };
      }

      const deprecated = repo.deprecate(id, superseded_by);
      return {
        content: [
          {
            type: 'text' as const,
            text: deprecated
              ? `Deprecated: "${deprecated.title}" (id: ${id})`
              : `Entry ${id} not found.`,
          },
        ],
      };
    },
  );

  // ── Tool 7: nous_context ────────────────────────────────────
  server.tool(
    'nous_context',
    'Get all relevant knowledge for a task. Returns top concepts, decisions, and patterns. Call this before starting work on something.',
    {
      task: z.string().describe('Description of the task you are about to work on'),
      scope: z.string().optional().describe('Scope filter (backend, frontend, infra, api)'),
      limit: z.number().optional().default(10).describe('Max results per knowledge type'),
    },
    async ({ task, scope, limit }) => {
      const concepts = await search.search({ query: task, type: 'concept', scope, limit });
      const decisions = await search.search({ query: task, type: 'decision', scope, limit });
      const patterns = await search.search({ query: task, type: 'pattern', scope, limit });

      const sections: string[] = [];

      if (concepts.length > 0) {
        sections.push('## Relevant Concepts\n' + concepts.map((r) => `- **${r.entry.title}**: ${r.entry.content}`).join('\n'));
      }
      if (decisions.length > 0) {
        sections.push('## Relevant Decisions\n' + decisions.map((r) => `- **${r.entry.title}**: ${r.entry.content}`).join('\n'));
      }
      if (patterns.length > 0) {
        sections.push('## Patterns to Follow\n' + patterns.map((r) => `- **${r.entry.title}**: ${r.entry.content}`).join('\n'));
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: sections.length > 0 ? sections.join('\n\n') : 'No relevant knowledge found for this task.',
          },
        ],
      };
    },
  );

  // ── Tool 8: nous_extract ────────────────────────────────────
  server.tool(
    'nous_extract',
    'Extract knowledge from conversation text. Identifies concepts, decisions, and patterns using heuristic classification.',
    {
      text: z.string().describe('Conversation text to extract knowledge from'),
      source: z.string().optional().default('mcp').describe('Source identifier'),
      auto_save: z.boolean().optional().default(false).describe('Automatically save extracted knowledge (with lower confidence)'),
    },
    async ({ text, source, auto_save }) => {
      // Simple heuristic extraction (Phase 4 will have full classifier)
      const extracted: { type: KnowledgeType; title: string; content: string }[] = [];

      const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter((s) => s.length > 20);

      for (const sentence of sentences) {
        const lower = sentence.toLowerCase();
        if (/\b(we chose|decided to|because|opted for|tradeoff|instead of)\b/.test(lower)) {
          extracted.push({ type: 'decision', title: sentence.slice(0, 60), content: sentence });
        } else if (/\b(works by|the flow is|architecture|responsible for|handles|connects to)\b/.test(lower)) {
          extracted.push({ type: 'concept', title: sentence.slice(0, 60), content: sentence });
        } else if (/\b(always|never|convention|rule|pattern|make sure)\b/.test(lower)) {
          extracted.push({ type: 'pattern', title: sentence.slice(0, 60), content: sentence });
        }
      }

      if (extracted.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No knowledge extracted from the provided text.' }] };
      }

      if (auto_save) {
        const saved: string[] = [];
        for (const item of extracted) {
          const entry = repo.insert({
            ...item,
            source: 'extracted',
            source_ref: source,
            confidence: 0.6,
          });
          if (embeddings.isAvailable()) {
            const vec = await embeddings.embed(`${item.title} ${item.content}`);
            if (vec) search.storeEmbedding(entry.id, vec, embeddings.modelName());
          }
          saved.push(`[${entry.type}] ${entry.title} (${entry.id})`);
        }
        return { content: [{ type: 'text' as const, text: `Auto-saved ${saved.length} entries:\n${saved.join('\n')}` }] };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${extracted.length} potential entries:\n${extracted.map((e) => `[${e.type}] ${e.title}`).join('\n')}\n\nCall nous_teach to save them, or nous_extract with auto_save=true.`,
          },
        ],
      };
    },
  );

  // ── Tool 9: nous_recent ─────────────────────────────────────
  server.tool(
    'nous_recent',
    'List recently added or modified knowledge entries.',
    {
      days: z.number().optional().default(7).describe('Look back N days'),
      type: z.enum(['concept', 'decision', 'pattern']).optional().describe('Filter by type'),
      limit: z.number().optional().default(10).describe('Max results'),
    },
    async ({ days, type, limit }) => {
      const entries = repo.recent(days, { type, limit });

      if (entries.length === 0) {
        return { content: [{ type: 'text' as const, text: `No entries in the last ${days} days.` }] };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: entries
              .map((e) => `[${e.type}] ${e.title} (${e.created_at})\n  ${e.content.slice(0, 100)}...`)
              .join('\n\n'),
          },
        ],
      };
    },
  );

  // ── Tool 10: nous_status ────────────────────────────────────
  server.tool(
    'nous_status',
    'Get brain statistics: entry counts, embedding coverage, last activity.',
    {},
    async () => {
      const stats = repo.status();

      // Get DB file size
      let dbSize = 0;
      try {
        dbSize = statSync(dbPath).size;
      } catch {}

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Project: ${config.project_name}`,
              `Total entries: ${stats.total_entries}`,
              `  Concepts: ${stats.by_type.concept}`,
              `  Decisions: ${stats.by_type.decision}`,
              `  Patterns: ${stats.by_type.pattern}`,
              `Active: ${stats.by_status.active} | Deprecated: ${stats.by_status.deprecated}`,
              `Relationships: ${stats.total_relationships}`,
              `Embeddings: ${stats.total_embeddings} (${Math.round(stats.embedding_coverage * 100)}% coverage)`,
              `DB size: ${(dbSize / 1024).toFixed(0)} KB`,
              `Last activity: ${stats.last_activity ?? 'none'}`,
              `Embedding engine: ${embeddings.isAvailable() ? embeddings.modelName() : 'none (FTS5 only)'}`,
            ].join('\n'),
          },
        ],
      };
    },
  );

  return { server, cleanup: () => closeConnection() };
}

export async function startMcpServer(): Promise<void> {
  const { server } = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
