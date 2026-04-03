import type Database from 'better-sqlite3';
import type { EmbeddingEngine } from '../embeddings/engine.js';
import { generateId } from '../utils/id.js';
import { sha256 } from '../utils/hash.js';

export interface DeduplicationResult {
  isDuplicate: boolean;
  /** If similar (not exact) to existing entry, returns the entry ID and similarity. */
  similarTo?: { id: string; title: string; similarity: number };
}

/**
 * Check if content has already been processed (exact hash match).
 */
export function wasAlreadyProcessed(db: Database.Database, contentHash: string): boolean {
  const row = db
    .prepare('SELECT id FROM extraction_log WHERE content_hash = ?')
    .get(contentHash);
  return !!row;
}

/**
 * Check if a knowledge entry with very similar content already exists.
 * Uses embedding cosine similarity if available, falls back to FTS5 title match.
 */
export async function checkDuplicate(
  db: Database.Database,
  embeddings: EmbeddingEngine,
  title: string,
  content: string,
): Promise<DeduplicationResult> {
  // Fast path: exact title match
  const exactMatch = db
    .prepare("SELECT id, title FROM knowledge WHERE title = ? COLLATE NOCASE AND status = 'active'")
    .get(title) as { id: string; title: string } | undefined;

  if (exactMatch) {
    return { isDuplicate: true, similarTo: { id: exactMatch.id, title: exactMatch.title, similarity: 1.0 } };
  }

  // If embeddings available, check cosine similarity
  if (embeddings.isAvailable()) {
    const queryVec = await embeddings.embed(`${title} ${content}`);
    if (queryVec) {
      const vecBuffer = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);

      try {
        const rows = db
          .prepare(
            `SELECT v.knowledge_id as id, v.distance, k.title
             FROM vec_knowledge v
             JOIN knowledge k ON k.id = v.knowledge_id
             WHERE v.embedding MATCH ? AND v.k = 1
             AND k.status = 'active'`,
          )
          .all(vecBuffer) as { id: string; distance: number; title: string }[];

        if (rows.length > 0) {
          const closest = rows[0]!;
          // L2 distance → approximate cosine similarity
          // For normalized vectors: cosine_sim ≈ 1 - (distance² / 2)
          const similarity = Math.max(0, 1 - (closest.distance ** 2) / 2);

          if (similarity > 0.92) {
            return { isDuplicate: true, similarTo: { id: closest.id, title: closest.title, similarity } };
          }

          if (similarity > 0.75) {
            return { isDuplicate: false, similarTo: { id: closest.id, title: closest.title, similarity } };
          }
        }
      } catch {
        // Vec search failed — fall through to "not duplicate"
      }
    }
  }

  return { isDuplicate: false };
}

/**
 * Log that content has been processed to prevent re-extraction.
 */
export function logExtraction(
  db: Database.Database,
  sourceType: string,
  sourceRef: string,
  content: string,
  extractedIds: string[],
): void {
  const contentHash = sha256(content);

  db.prepare(
    `INSERT OR IGNORE INTO extraction_log (id, source_type, source_ref, content_hash, extracted_ids)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(generateId(), sourceType, sourceRef, contentHash, JSON.stringify(extractedIds));
}
