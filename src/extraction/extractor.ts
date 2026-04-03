import type Database from 'better-sqlite3';
import type { EmbeddingEngine } from '../embeddings/engine.js';
import type { KnowledgeEntry, KnowledgeSource } from '../knowledge/types.js';
import { KnowledgeRepository } from '../knowledge/repository.js';
import { KnowledgeSearch } from '../knowledge/search.js';
import { classify, segment } from './classifier.js';
import { checkDuplicate, wasAlreadyProcessed, logExtraction } from './deduplicator.js';
import { sha256 } from '../utils/hash.js';

export interface ExtractionResult {
  saved: KnowledgeEntry[];
  skipped: { reason: string; title: string }[];
  proposed: { type: string; title: string; content: string; confidence: number }[];
}

export class KnowledgeExtractor {
  private repo: KnowledgeRepository;
  private search: KnowledgeSearch;

  constructor(
    private db: Database.Database,
    private embeddings: EmbeddingEngine,
  ) {
    this.repo = new KnowledgeRepository(db);
    this.search = new KnowledgeSearch(db, embeddings);
  }

  /**
   * Extract knowledge from text.
   * If autoSave=true, saves entries directly with confidence=0.6.
   * If autoSave=false, returns proposed entries for review.
   */
  async extract(
    text: string,
    options: {
      source?: KnowledgeSource;
      sourceRef?: string;
      autoSave?: boolean;
    } = {},
  ): Promise<ExtractionResult> {
    const { source = 'extracted' as const, sourceRef = 'unknown', autoSave = false } = options;

    // Check if this exact text was already processed
    const contentHash = sha256(text);
    if (wasAlreadyProcessed(this.db, contentHash)) {
      return { saved: [], skipped: [{ reason: 'already processed', title: contentHash.slice(0, 8) }], proposed: [] };
    }

    // Segment the text into meaningful chunks
    const segments = segment(text);

    const result: ExtractionResult = { saved: [], skipped: [], proposed: [] };
    const savedIds: string[] = [];

    for (const seg of segments) {
      // Classify the segment
      const classification = classify(seg);
      if (!classification) continue;

      // Check for duplicates
      const dedup = await checkDuplicate(this.db, this.embeddings, classification.title, classification.content);

      if (dedup.isDuplicate) {
        result.skipped.push({
          reason: `duplicate of "${dedup.similarTo?.title}" (similarity: ${dedup.similarTo?.similarity.toFixed(2)})`,
          title: classification.title,
        });
        continue;
      }

      if (dedup.similarTo) {
        result.skipped.push({
          reason: `similar to "${dedup.similarTo.title}" (${dedup.similarTo.similarity.toFixed(2)}) — consider updating existing entry ${dedup.similarTo.id}`,
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

        // Generate embedding
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

    // Log extraction
    logExtraction(this.db, source, sourceRef, text, savedIds);

    return result;
  }
}
