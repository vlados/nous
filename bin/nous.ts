#!/usr/bin/env node

import { Command } from 'commander';
import { join } from 'node:path';
import { init } from '../src/cli/init.js';
import { startMcpServer } from '../src/mcp/server.js';
import { findNousDir, loadConfig } from '../src/utils/config.js';
import { getConnection, closeConnection } from '../src/db/connection.js';
import { KnowledgeRepository } from '../src/knowledge/repository.js';
import type { KnowledgeType } from '../src/knowledge/types.js';

function requireNous(): { nousDir: string; db: ReturnType<typeof getConnection>; repo: KnowledgeRepository } {
  const nousDir = findNousDir();
  if (!nousDir) {
    console.error('No .nous/ directory found. Run `nous init` first.');
    process.exit(1);
  }
  const db = getConnection(join(nousDir, 'knowledge.db'));
  const repo = new KnowledgeRepository(db);
  return { nousDir, db, repo };
}

const program = new Command();

program
  .name('nous')
  .description('Per-project knowledge brain with auto-learning from AI conversations')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize nous in the current project')
  .option('-n, --name <name>', 'Project name (defaults to directory name)')
  .option('--hook', 'Install Claude Code hook for auto-learning')
  .action((options) => {
    const result = init(options);
    console.log(result);
  });

program
  .command('serve')
  .description('Start the MCP server (stdio transport)')
  .action(async () => {
    await startMcpServer();
  });

program
  .command('status')
  .description('Show brain statistics')
  .action(() => {
    const { nousDir, db, repo } = requireNous();
    const config = loadConfig(nousDir);
    const stats = repo.status();

    console.log(`\nnous brain: ${config.project_name}`);
    console.log('─────────────────────────────');
    console.log(`Entries:       ${stats.total_entries}`);
    console.log(`  Concepts:    ${stats.by_type.concept}`);
    console.log(`  Decisions:   ${stats.by_type.decision}`);
    console.log(`  Patterns:    ${stats.by_type.pattern}`);
    console.log(`Relationships: ${stats.total_relationships}`);
    console.log(`Embeddings:    ${stats.total_embeddings} (${Math.round(stats.embedding_coverage * 100)}% coverage)`);
    console.log(`Last activity: ${stats.last_activity ?? 'none'}`);

    closeConnection();
  });

program
  .command('teach <type> <title> <content>')
  .description('Teach nous something new (type: concept, decision, pattern)')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('-s, --scope <scope>', 'Scope (backend, frontend, infra, api)')
  .action((type: string, title: string, content: string, options: { tags?: string; scope?: string }) => {
    if (!['concept', 'decision', 'pattern'].includes(type)) {
      console.error('Type must be: concept, decision, or pattern');
      process.exit(1);
    }

    const { repo } = requireNous();

    const entry = repo.insert({
      type: type as KnowledgeType,
      title,
      content,
      tags: options.tags ? options.tags.split(',').map((t) => t.trim()) : [],
      scope: options.scope ?? '',
    });

    console.log(`Learned ${entry.type}: "${entry.title}" (${entry.id})`);
    closeConnection();
  });

program
  .command('ask <question>')
  .description('Search the brain')
  .option('-t, --type <type>', 'Filter by type (concept, decision, pattern)')
  .option('-l, --limit <limit>', 'Max results', '5')
  .action((question: string, options: { type?: string; limit: string }) => {
    const { db } = requireNous();
    const limit = parseInt(options.limit, 10);

    // Phase 1: FTS5 only. Phase 2 will add hybrid vector+FTS search.
    const conditions = ["knowledge_fts MATCH ?", "k.status = 'active'"];
    const params: unknown[] = [question];

    if (options.type) {
      conditions.push('k.type = ?');
      params.push(options.type);
    }
    params.push(limit);

    try {
      const rows = db
        .prepare(
          `SELECT k.*, rank
           FROM knowledge_fts fts
           JOIN knowledge k ON k.rowid = fts.rowid
           WHERE ${conditions.join(' AND ')}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(...params) as Record<string, unknown>[];

      if (rows.length === 0) {
        console.log('No results found.');
      } else {
        for (const row of rows) {
          console.log(`\n[${row.type}] ${row.title}`);
          console.log(`  ${(row.content as string).slice(0, 200)}`);
          console.log(`  id: ${row.id}  confidence: ${row.confidence}`);
        }
      }
    } catch {
      console.log('No results found.');
    }

    closeConnection();
  });

program
  .command('extract')
  .description('Extract knowledge from text (reads from stdin)')
  .option('--stdin', 'Read text from stdin')
  .option('--auto-save', 'Automatically save extracted knowledge')
  .option('--source <source>', 'Source identifier', 'cli')
  .action(async (options: { stdin?: boolean; autoSave?: boolean; source: string }) => {
    const { KnowledgeExtractor } = await import('../src/extraction/extractor.js');
    const { OpenAIEmbeddingEngine } = await import('../src/embeddings/api.js');
    const { FallbackEmbeddingEngine } = await import('../src/embeddings/fallback.js');

    const { nousDir, db } = requireNous();
    const config = loadConfig(nousDir);

    const apiKey = config.openai_api_key ?? process.env['OPENAI_API_KEY'];
    const embeddings = apiKey ? new OpenAIEmbeddingEngine(apiKey) : new FallbackEmbeddingEngine();
    const extractor = new KnowledgeExtractor(db, embeddings);

    let text = '';
    if (options.stdin) {
      // Read from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString('utf-8');
    } else {
      console.error('Use --stdin to pipe text, e.g.: echo "some text" | nous extract --stdin');
      process.exit(1);
    }

    if (!text.trim()) {
      console.log('No text to extract from.');
      closeConnection();
      return;
    }

    const result = await extractor.extract(text, {
      source: 'extracted' as const,
      sourceRef: `cli-${Date.now()}`,
      autoSave: options.autoSave ?? false,
    });

    if (result.saved.length > 0) {
      console.log(`Saved ${result.saved.length} entries:`);
      for (const entry of result.saved) {
        console.log(`  [${entry.type}] ${entry.title} (${entry.id})`);
      }
    }

    if (result.proposed.length > 0) {
      console.log(`Proposed ${result.proposed.length} entries:`);
      for (const p of result.proposed) {
        console.log(`  [${p.type}] ${p.title} (confidence: ${p.confidence.toFixed(2)})`);
      }
      console.log('\nRun with --auto-save to save automatically.');
    }

    if (result.skipped.length > 0) {
      console.log(`Skipped ${result.skipped.length}:`);
      for (const s of result.skipped) {
        console.log(`  ${s.title}: ${s.reason}`);
      }
    }

    if (result.saved.length === 0 && result.proposed.length === 0 && result.skipped.length === 0) {
      console.log('No knowledge extracted.');
    }

    closeConnection();
  });

program.parse();
