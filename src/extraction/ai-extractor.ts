import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { EmbeddingEngine } from '../embeddings/engine.js';
import { KnowledgeRepository } from '../knowledge/repository.js';
import { KnowledgeSearch } from '../knowledge/search.js';
import { checkDuplicate, logExtraction } from './deduplicator.js';
import { sha256 } from '../utils/hash.js';
import type { KnowledgeEntry, KnowledgeType } from '../knowledge/types.js';

interface ExtractedItem {
  type: KnowledgeType;
  title: string;
  content: string;
  tags: string[];
  scope: string;
  confidence: number;
}

export interface AiExtractionResult {
  saved: KnowledgeEntry[];
  skipped: { reason: string; title: string }[];
}

const EXTRACTION_PROMPT = `You are a knowledge extraction engine for a developer project brain called "nous".

Analyze the following conversation text and extract any valuable project knowledge. Only extract things that would be useful to remember across sessions — skip trivial, temporary, or obvious things.

Extract into three types:

**concept** — How something works, architecture, data flow, system behavior
  Example: "The payment flow starts with Stripe webhooks hitting PaymentController, which validates the signature, then dispatches to OrderService to update the order status"

**decision** — Why something was chosen, tradeoffs made, alternatives rejected
  Example: "We chose Redis over Memcached because we need pub/sub for real-time agent communication. The tradeoff is higher memory usage but it simplifies the message bus."

**pattern** — Rules, conventions, things to always/never do, coding standards
  Example: "All Livewire navigation must use wire:navigate. Never use traditional links or redirects — it breaks the SPA experience."

Rules:
- Only extract knowledge worth remembering. Skip greetings, debugging output, file listings, error messages.
- Write content in clear, standalone sentences. Someone reading this later should understand without the original conversation.
- Title should be short and descriptive (max 60 chars).
- Set confidence 0.6-0.9 based on how clearly the knowledge was stated (explicit statement = 0.9, inferred = 0.6).
- Tags: 1-3 relevant keywords.
- Scope: "backend", "frontend", "infra", "api", "devops", or "" for general.
- Return empty array if nothing worth extracting.

Respond with ONLY a JSON array, no markdown fences, no explanation:
[{"type":"concept","title":"...","content":"...","tags":["..."],"scope":"...","confidence":0.8}]`;

export class AiKnowledgeExtractor {
  private client: Anthropic;
  private repo: KnowledgeRepository;
  private search: KnowledgeSearch;

  constructor(
    private db: Database.Database,
    private embeddings: EmbeddingEngine,
    apiKey?: string,
  ) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env['ANTHROPIC_API_KEY'],
    });
    this.repo = new KnowledgeRepository(db);
    this.search = new KnowledgeSearch(db, embeddings);
  }

  async extract(
    text: string,
    options: { sourceRef?: string; autoSave?: boolean } = {},
  ): Promise<AiExtractionResult> {
    const { sourceRef = 'unknown', autoSave = true } = options;

    // Skip if already processed
    const contentHash = sha256(text);
    const { wasAlreadyProcessed } = await import('./deduplicator.js');
    if (wasAlreadyProcessed(this.db, contentHash)) {
      return { saved: [], skipped: [{ reason: 'already processed', title: contentHash.slice(0, 8) }] };
    }

    // Truncate to avoid huge API calls — last 4000 chars is usually enough
    const truncated = text.length > 6000 ? text.slice(-6000) : text;

    // Call Claude to extract knowledge
    let items: ExtractedItem[];
    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: `${EXTRACTION_PROMPT}\n\n---\n\n${truncated}`,
          },
        ],
      });

      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      items = this.parseResponse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[nous] AI extraction failed: ${message}`);
      return { saved: [], skipped: [{ reason: `AI error: ${message}`, title: 'extraction' }] };
    }

    if (items.length === 0) {
      logExtraction(this.db, 'ai', sourceRef, text, []);
      return { saved: [], skipped: [] };
    }

    // Dedup and save
    const result: AiExtractionResult = { saved: [], skipped: [] };
    const savedIds: string[] = [];

    for (const item of items) {
      const dedup = await checkDuplicate(this.db, this.embeddings, item.title, item.content);

      if (dedup.isDuplicate) {
        result.skipped.push({
          reason: `duplicate of "${dedup.similarTo?.title}"`,
          title: item.title,
        });
        continue;
      }

      if (dedup.similarTo && dedup.similarTo.similarity > 0.75) {
        result.skipped.push({
          reason: `similar to "${dedup.similarTo.title}" (${dedup.similarTo.similarity.toFixed(2)})`,
          title: item.title,
        });
        continue;
      }

      if (autoSave) {
        const entry = this.repo.insert({
          type: item.type,
          title: item.title,
          content: item.content,
          tags: item.tags,
          scope: item.scope,
          source: 'extracted',
          source_ref: sourceRef,
          confidence: item.confidence,
        });

        // Generate embedding
        if (this.embeddings.isAvailable()) {
          const vec = await this.embeddings.embed(`${entry.title} ${entry.content}`);
          if (vec) {
            this.search.storeEmbedding(entry.id, vec, this.embeddings.modelName());
          }
        }

        result.saved.push(entry);
        savedIds.push(entry.id);
      }
    }

    logExtraction(this.db, 'ai', sourceRef, text, savedIds);
    return result;
  }

  private parseResponse(text: string): ExtractedItem[] {
    // Try to parse as JSON array
    const trimmed = text.trim();

    // Remove markdown fences if present
    const cleaned = trimmed.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();

    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        (item: unknown): item is ExtractedItem =>
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          'title' in item &&
          'content' in item &&
          ['concept', 'decision', 'pattern'].includes((item as ExtractedItem).type),
      );
    } catch {
      // Try to find JSON array in the response
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            return parsed.filter(
              (item: unknown): item is ExtractedItem =>
                typeof item === 'object' &&
                item !== null &&
                'type' in item &&
                'title' in item &&
                'content' in item,
            );
          }
        } catch {}
      }
      return [];
    }
  }
}
