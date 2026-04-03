import type Database from 'better-sqlite3';
import type { EmbeddingEngine } from '../embeddings/engine.js';
import type { KnowledgeEntry, KnowledgeType, SearchResult } from './types.js';

/** Float32Array → Buffer for sqlite-vec binding */
function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function rowToEntry(row: Record<string, unknown>): KnowledgeEntry {
  return {
    id: row.id as string,
    type: row.type as KnowledgeType,
    title: row.title as string,
    content: row.content as string,
    metadata: JSON.parse((row.metadata as string) || '{}'),
    tags: JSON.parse((row.tags as string) || '[]'),
    scope: (row.scope as string) || '',
    source: (row.source as string) as KnowledgeEntry['source'],
    source_ref: (row.source_ref as string) || null,
    confidence: row.confidence as number,
    status: row.status as KnowledgeEntry['status'],
    superseded_by: (row.superseded_by as string) || null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    accessed_at: (row.accessed_at as string) || null,
  };
}

export interface SearchOptions {
  query: string;
  type?: KnowledgeType;
  scope?: string;
  limit?: number;
}

export class KnowledgeSearch {
  constructor(
    private db: Database.Database,
    private embeddings: EmbeddingEngine,
  ) {}

  /**
   * Hybrid search: FTS5 (keyword) + sqlite-vec (semantic) + RRF reranking.
   * Falls back to FTS5-only when embeddings are unavailable.
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const { query, type, scope, limit = 10 } = options;
    const candidateLimit = 20; // Fetch more candidates for reranking

    // Stage 1: FTS5 keyword search
    const ftsResults = this.ftsSearch(query, type, scope, candidateLimit);

    // Stage 2: Vector semantic search (if embeddings available)
    let vecResults: { id: string; distance: number }[] = [];
    if (this.embeddings.isAvailable()) {
      const queryEmbedding = await this.embeddings.embed(query);
      if (queryEmbedding) {
        vecResults = this.vectorSearch(queryEmbedding, type, scope, candidateLimit);
      }
    }

    // Stage 3: Reciprocal Rank Fusion
    if (vecResults.length === 0) {
      // FTS5-only mode
      return ftsResults.slice(0, limit).map((r) => ({
        entry: r.entry,
        score: r.score,
        source: 'fts' as const,
      }));
    }

    return this.reciprocalRankFusion(ftsResults, vecResults, limit);
  }

  /**
   * FTS5 keyword search with BM25 ranking.
   */
  ftsSearch(
    query: string,
    type?: KnowledgeType,
    scope?: string,
    limit: number = 20,
  ): { entry: KnowledgeEntry; score: number }[] {
    const conditions = ["k.status = 'active'"];
    const params: unknown[] = [];

    if (type) {
      conditions.push('k.type = ?');
      params.push(type);
    }
    if (scope) {
      conditions.push('k.scope = ?');
      params.push(scope);
    }

    const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    // Sanitize the query for FTS5: wrap each token in quotes to avoid syntax errors
    const sanitized = query
      .replace(/['"]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token}"`)
      .join(' OR ');

    if (!sanitized) return [];

    try {
      const rows = this.db
        .prepare(
          `SELECT k.*, rank as fts_rank
           FROM knowledge_fts fts
           JOIN knowledge k ON k.rowid = fts.rowid
           WHERE knowledge_fts MATCH ?
           ${whereClause}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(sanitized, ...params, limit) as (Record<string, unknown> & { fts_rank: number })[];

      return rows.map((row) => ({
        entry: rowToEntry(row),
        // BM25 rank is negative (more negative = better match), normalize to 0-1
        score: Math.min(1, Math.max(0, -row.fts_rank / 10)),
      }));
    } catch {
      // FTS5 match can fail on malformed queries
      return [];
    }
  }

  /**
   * Vector similarity search via sqlite-vec.
   */
  vectorSearch(
    queryEmbedding: Float32Array,
    type?: KnowledgeType,
    scope?: string,
    limit: number = 20,
  ): { id: string; distance: number }[] {
    // sqlite-vec uses `k = ?` instead of LIMIT for the vec0 virtual table.
    // We join with knowledge table to apply type/scope filters post-retrieval.
    try {
      const vecBuffer = vecToBuffer(queryEmbedding);

      if (type || scope) {
        // Fetch extra candidates to account for post-filtering
        const fetchLimit = limit * 3;
        const conditions: string[] = ["k.status = 'active'"];
        const filterParams: unknown[] = [];

        if (type) {
          conditions.push('k.type = ?');
          filterParams.push(type);
        }
        if (scope) {
          conditions.push('k.scope = ?');
          filterParams.push(scope);
        }

        const rows = this.db
          .prepare(
            `SELECT v.knowledge_id as id, v.distance
             FROM vec_knowledge v
             JOIN knowledge k ON k.id = v.knowledge_id
             WHERE v.embedding MATCH ? AND v.k = ?
             AND ${conditions.join(' AND ')}`,
          )
          .all(vecBuffer, fetchLimit, ...filterParams) as { id: string; distance: number }[];

        return rows.slice(0, limit);
      }

      // No filters — simple vec search
      const rows = this.db
        .prepare(
          `SELECT knowledge_id as id, distance
           FROM vec_knowledge
           WHERE embedding MATCH ? AND k = ?`,
        )
        .all(vecBuffer, limit) as { id: string; distance: number }[];

      return rows;
    } catch {
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion: merge FTS5 and vector results.
   * RRF score = sum(1 / (k + rank_per_source))
   * Entries found by both methods get a boosted score.
   */
  private reciprocalRankFusion(
    ftsResults: { entry: KnowledgeEntry; score: number }[],
    vecResults: { id: string; distance: number }[],
    limit: number,
  ): SearchResult[] {
    const k = 60; // Standard RRF constant
    const scoreMap = new Map<string, { rrfScore: number; entry?: KnowledgeEntry; sources: Set<string> }>();

    // Add FTS5 results
    for (let i = 0; i < ftsResults.length; i++) {
      const result = ftsResults[i]!;
      scoreMap.set(result.entry.id, {
        rrfScore: 1 / (k + i + 1),
        entry: result.entry,
        sources: new Set(['fts']),
      });
    }

    // Add vector results
    for (let i = 0; i < vecResults.length; i++) {
      const result = vecResults[i]!;
      const existing = scoreMap.get(result.id);

      if (existing) {
        // Found in both — add RRF scores
        existing.rrfScore += 1 / (k + i + 1);
        existing.sources.add('vector');
      } else {
        // Vector-only result — need to fetch the entry
        const entry = this.fetchEntry(result.id);
        if (entry) {
          scoreMap.set(result.id, {
            rrfScore: 1 / (k + i + 1),
            entry,
            sources: new Set(['vector']),
          });
        }
      }
    }

    // Sort by RRF score (descending) and take top N
    return Array.from(scoreMap.values())
      .filter((v) => v.entry)
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, limit)
      .map((v) => ({
        entry: v.entry!,
        score: v.rrfScore,
        source: v.sources.size > 1 ? ('hybrid' as const) : (v.sources.values().next().value as 'fts' | 'vector'),
      }));
  }

  private fetchEntry(id: string): KnowledgeEntry | null {
    const row = this.db
      .prepare("SELECT * FROM knowledge WHERE id = ? AND status = 'active'")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToEntry(row) : null;
  }

  /**
   * Store an embedding for a knowledge entry.
   */
  storeEmbedding(knowledgeId: string, embedding: Float32Array, model: string): void {
    const embeddingBuffer = vecToBuffer(embedding);

    // Store in knowledge_embeddings table
    this.db
      .prepare(
        `INSERT OR REPLACE INTO knowledge_embeddings (knowledge_id, embedding, model, embedded_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(knowledgeId, embeddingBuffer, model);

    // Also store in vec0 virtual table for search
    try {
      this.db
        .prepare('INSERT OR REPLACE INTO vec_knowledge (knowledge_id, embedding) VALUES (?, ?)')
        .run(knowledgeId, embeddingBuffer);
    } catch {
      // vec_knowledge insert can fail if dimensions mismatch
    }
  }

  /**
   * Remove embedding when knowledge entry is deleted.
   */
  removeEmbedding(knowledgeId: string): void {
    this.db.prepare('DELETE FROM knowledge_embeddings WHERE knowledge_id = ?').run(knowledgeId);
    try {
      this.db.prepare('DELETE FROM vec_knowledge WHERE knowledge_id = ?').run(knowledgeId);
    } catch {
      // Ignore vec_knowledge errors
    }
  }
}
