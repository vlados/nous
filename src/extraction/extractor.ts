import type Database from 'better-sqlite3';
import type { EmbeddingEngine } from '../embeddings/engine.js';
import type { KnowledgeEntry, KnowledgeSource } from '../knowledge/types.js';
import { KnowledgeRepository } from '../knowledge/repository.js';
import { KnowledgeSearch } from '../knowledge/search.js';
import { AiKnowledgeExtractor } from './ai-extractor.js';
import { classify, segment } from './classifier.js';
import { checkDuplicate, wasAlreadyProcessed, logExtraction } from './deduplicator.js';
import { sha256 } from '../utils/hash.js';

export interface ExtractionResult {
  saved: KnowledgeEntry[];
  skipped: { reason: string; title: string }[];
  proposed: { type: string; title: string; content: string; confidence: number }[];
  method: 'ai' | 'heuristic';
}

export class KnowledgeExtractor {
  private repo: KnowledgeRepository;
  private search: KnowledgeSearch;
  private aiExtractor: AiKnowledgeExtractor | null = null;

  constructor(
    private db: Database.Database,
    private embeddings: EmbeddingEngine,
    anthropicApiKey?: string,
  ) {
    this.repo = new KnowledgeRepository(db);
    this.search = new KnowledgeSearch(db, embeddings);

    // Use AI extraction if Anthropic key is available
    const key = anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (key) {
      this.aiExtractor = new AiKnowledgeExtractor(db, embeddings, key);
    }
  }

  /**
   * Extract knowledge from text.
   * Uses AI (Claude) when available, falls back to heuristic regex.
   */
  async extract(
    text: string,
    options: {
      source?: KnowledgeSource;
      sourceRef?: string;
      autoSave?: boolean;
    } = {},
  ): Promise<ExtractionResult> {
    const { sourceRef = 'unknown', autoSave = false } = options;

    // AI extraction path
    if (this.aiExtractor) {
      const aiResult = await this.aiExtractor.extract(text, { sourceRef, autoSave });
      return {
        saved: aiResult.saved,
        skipped: aiResult.skipped,
        proposed: [],
        method: 'ai',
      };
    }

    // Heuristic fallback
    return this.heuristicExtract(text, options);
  }

  /**
   * Heuristic extraction using regex patterns.
   * Used when no Anthropic API key is configured.
   */
  private async heuristicExtract(
    text: string,
    options: {
      source?: KnowledgeSource;
      sourceRef?: string;
      autoSave?: boolean;
    } = {},
  ): Promise<ExtractionResult> {
    const { source = 'extracted' as const, sourceRef = 'unknown', autoSave = false } = options;

    const contentHash = sha256(text);
    if (wasAlreadyProcessed(this.db, contentHash)) {
      return { saved: [], skipped: [{ reason: 'already processed', title: contentHash.slice(0, 8) }], proposed: [], method: 'heuristic' };
    }

    const segments = segment(text);
    const result: ExtractionResult = { saved: [], skipped: [], proposed: [], method: 'heuristic' };
    const savedIds: string[] = [];

    for (const seg of segments) {
      const classification = classify(seg);
      if (!classification) continue;

      const dedup = await checkDuplicate(this.db, this.embeddings, classification.title, classification.content);

      if (dedup.isDuplicate) {
        result.skipped.push({
          reason: `duplicate of "${dedup.similarTo?.title}"`,
          title: classification.title,
        });
        continue;
      }

      if (dedup.similarTo) {
        result.skipped.push({
          reason: `similar to "${dedup.similarTo.title}" (${dedup.similarTo.similarity.toFixed(2)})`,
          title: classification.title,
        });
        continue;
      }

      if (autoSave) {
        const entry = this.repo.insert({
          type: classification.type,
          title: classification.title,
          content: classification.content,
          source,
          source_ref: sourceRef,
          confidence: Math.min(classification.confidence, 0.6),
        });

        if (this.embeddings.isAvailable()) {
          const vec = await this.embeddings.embed(`${entry.title} ${entry.content}`);
          if (vec) {
            this.search.storeEmbedding(entry.id, vec, this.embeddings.modelName());
          }
        }

        result.saved.push(entry);
        savedIds.push(entry.id);
      } else {
        result.proposed.push({
          type: classification.type,
          title: classification.title,
          content: classification.content,
          confidence: classification.confidence,
        });
      }
    }

    logExtraction(this.db, source, sourceRef, text, savedIds);
    return result;
  }
}
