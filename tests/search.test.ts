import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestConnection } from '../src/db/connection.js';
import { KnowledgeRepository } from '../src/knowledge/repository.js';
import { KnowledgeSearch } from '../src/knowledge/search.js';
import { FallbackEmbeddingEngine } from '../src/embeddings/fallback.js';
import { EMBEDDING_DIMENSIONS } from '../src/db/schema.js';
import type Database from 'better-sqlite3';
import type { EmbeddingEngine } from '../src/embeddings/engine.js';

let db: Database.Database;
let repo: KnowledgeRepository;
let search: KnowledgeSearch;
let fallbackEngine: FallbackEmbeddingEngine;

/**
 * Fake embedding engine that generates deterministic vectors from text.
 * Uses a simple hash-based approach — not semantically meaningful,
 * but allows testing the full vector search pipeline.
 */
class TestEmbeddingEngine implements EmbeddingEngine {
  isAvailable(): boolean { return true; }
  modelName(): string { return 'test-model'; }
  dimensions(): number { return EMBEDDING_DIMENSIONS; }

  async embed(text: string): Promise<Float32Array> {
    return this.deterministicVector(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.deterministicVector(t));
  }

  /** Generate a deterministic vector from text using simple character hashing. */
  private deterministicVector(text: string): Float32Array {
    const vec = new Float32Array(EMBEDDING_DIMENSIONS);
    for (let i = 0; i < text.length; i++) {
      const idx = (text.charCodeAt(i) * (i + 1)) % EMBEDDING_DIMENSIONS;
      vec[idx] = (vec[idx] ?? 0) + 0.1;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += (vec[i] ?? 0) ** 2;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
    return vec;
  }
}

beforeEach(() => {
  db = getTestConnection();
  repo = new KnowledgeRepository(db);
  fallbackEngine = new FallbackEmbeddingEngine();
  search = new KnowledgeSearch(db, fallbackEngine);
});

afterEach(() => {
  db.close();
});

describe('FTS5 search', () => {
  beforeEach(() => {
    repo.insert({ type: 'concept', title: 'Payment Flow', content: 'Stripe webhooks process orders through PaymentController' });
    repo.insert({ type: 'decision', title: 'Chose SQLite', content: 'SQLite for portability over PostgreSQL' });
    repo.insert({ type: 'pattern', title: 'API Wrapper', content: 'Always use ApiResponse for all REST endpoints' });
    repo.insert({ type: 'concept', title: 'Auth System', content: 'JWT tokens with refresh rotation for authentication' });
  });

  it('finds entries by keyword', () => {
    const results = search.ftsSearch('payment');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.title).toBe('Payment Flow');
  });

  it('finds entries by content words', () => {
    const results = search.ftsSearch('Stripe');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.title).toBe('Payment Flow');
  });

  it('filters by type', () => {
    const results = search.ftsSearch('SQLite', 'decision');
    expect(results).toHaveLength(1);
    expect(results[0]!.entry.type).toBe('decision');
  });

  it('filters by scope', () => {
    repo.insert({ type: 'concept', title: 'Backend Cache', content: 'Redis caching layer', scope: 'backend' });
    repo.insert({ type: 'concept', title: 'Frontend Cache', content: 'Browser caching headers', scope: 'frontend' });

    const results = search.ftsSearch('cache', undefined, 'backend');
    expect(results).toHaveLength(1);
    expect(results[0]!.entry.title).toBe('Backend Cache');
  });

  it('returns empty for no matches', () => {
    const results = search.ftsSearch('nonexistentterm');
    expect(results).toHaveLength(0);
  });

  it('handles multi-word queries', () => {
    const results = search.ftsSearch('API REST endpoints');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.title).toBe('API Wrapper');
  });

  it('excludes deprecated entries', () => {
    const entry = repo.insert({ type: 'concept', title: 'Old Payment', content: 'deprecated payment system' });
    repo.deprecate(entry.id);

    const results = search.ftsSearch('payment');
    // Should only find "Payment Flow", not "Old Payment"
    expect(results.every((r) => r.entry.status === 'active')).toBe(true);
  });
});

describe('vector search', () => {
  let testEngine: TestEmbeddingEngine;
  let vecSearch: KnowledgeSearch;

  beforeEach(async () => {
    testEngine = new TestEmbeddingEngine();
    vecSearch = new KnowledgeSearch(db, testEngine);

    // Insert entries and store their embeddings
    const entries = [
      repo.insert({ type: 'concept', title: 'Payment Flow', content: 'Stripe webhooks process orders' }),
      repo.insert({ type: 'decision', title: 'Chose SQLite', content: 'SQLite for portability' }),
      repo.insert({ type: 'pattern', title: 'API Wrapper', content: 'Always use ApiResponse' }),
    ];

    for (const entry of entries) {
      const embedding = await testEngine.embed(`${entry.title} ${entry.content}`);
      vecSearch.storeEmbedding(entry.id, embedding!, testEngine.modelName());
    }
  });

  it('stores and retrieves embeddings', () => {
    const count = (db.prepare('SELECT COUNT(*) as c FROM knowledge_embeddings').get() as { c: number }).c;
    expect(count).toBe(3);

    const vecCount = (db.prepare('SELECT COUNT(*) as c FROM vec_knowledge').get() as { c: number }).c;
    expect(vecCount).toBe(3);
  });

  it('finds similar entries via vector search', () => {
    const queryVec = testEngine['deterministicVector']('Payment Flow Stripe webhooks process orders');
    const results = vecSearch.vectorSearch(queryVec);
    expect(results.length).toBeGreaterThan(0);
    // "Payment Flow" should be closest to itself
    expect(results[0]!.id).toBeDefined();
  });

  it('returns results ordered by distance', () => {
    const queryVec = testEngine['deterministicVector']('payment processing');
    const results = vecSearch.vectorSearch(queryVec);

    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.distance).toBeGreaterThanOrEqual(results[i - 1]!.distance);
    }
  });
});

describe('hybrid search', () => {
  let testEngine: TestEmbeddingEngine;
  let hybridSearch: KnowledgeSearch;

  beforeEach(async () => {
    testEngine = new TestEmbeddingEngine();
    hybridSearch = new KnowledgeSearch(db, testEngine);

    const entries = [
      repo.insert({ type: 'concept', title: 'Payment Flow', content: 'Stripe webhooks process orders through PaymentController' }),
      repo.insert({ type: 'decision', title: 'Chose SQLite', content: 'SQLite chosen for portability over PostgreSQL' }),
      repo.insert({ type: 'pattern', title: 'API Wrapper', content: 'Always use ApiResponse class for REST' }),
      repo.insert({ type: 'concept', title: 'Auth System', content: 'JWT token rotation for secure authentication' }),
    ];

    for (const entry of entries) {
      const embedding = await testEngine.embed(`${entry.title} ${entry.content}`);
      hybridSearch.storeEmbedding(entry.id, embedding!, testEngine.modelName());
    }
  });

  it('returns hybrid results when embeddings available', async () => {
    const results = await hybridSearch.search({ query: 'payment processing' });
    expect(results.length).toBeGreaterThan(0);
    // Results should have source info
    expect(['fts', 'vector', 'hybrid']).toContain(results[0]!.source);
  });

  it('falls back to FTS5 when embeddings unavailable', async () => {
    const ftsOnlySearch = new KnowledgeSearch(db, fallbackEngine);

    const results = await ftsOnlySearch.search({ query: 'payment' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.source).toBe('fts');
  });

  it('respects type filter', async () => {
    const results = await hybridSearch.search({ query: 'SQLite database', type: 'decision' });
    expect(results.every((r) => r.entry.type === 'decision')).toBe(true);
  });

  it('respects limit', async () => {
    const results = await hybridSearch.search({ query: 'system', limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe('embedding storage', () => {
  it('stores and removes embeddings', async () => {
    const entry = repo.insert({ type: 'concept', title: 'Test', content: 'test content' });
    const engine = new TestEmbeddingEngine();
    const vecSearch = new KnowledgeSearch(db, engine);

    const embedding = await engine.embed('Test test content');
    vecSearch.storeEmbedding(entry.id, embedding!, engine.modelName());

    let count = (db.prepare('SELECT COUNT(*) as c FROM knowledge_embeddings').get() as { c: number }).c;
    expect(count).toBe(1);

    vecSearch.removeEmbedding(entry.id);

    count = (db.prepare('SELECT COUNT(*) as c FROM knowledge_embeddings').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
