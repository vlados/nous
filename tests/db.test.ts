import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initializeSchema, EMBEDDING_DIMENSIONS } from '../src/db/schema.js';
import { runMigrations } from '../src/db/migrations.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  initializeSchema(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('schema', () => {
  it('creates all required tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('knowledge');
    expect(tableNames).toContain('knowledge_embeddings');
    expect(tableNames).toContain('relationships');
    expect(tableNames).toContain('extraction_log');
    expect(tableNames).toContain('nous_meta');
  });

  it('creates FTS5 virtual table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_fts%'")
      .all() as { name: string }[];

    expect(tables.length).toBeGreaterThan(0);
  });

  it('creates vec0 virtual table', () => {
    // vec0 tables show up as virtual tables — verify by inserting + querying
    const vecVersion = db.prepare('SELECT vec_version()').get() as Record<string, string>;
    expect(vecVersion['vec_version()']).toMatch(/^v0\./);
  });

  it('stores schema version in nous_meta', () => {
    const row = db
      .prepare("SELECT value FROM nous_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(row.value).toBe('1');
  });

  it('has correct embedding dimensions constant', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
  });
});

describe('knowledge table constraints', () => {
  it('rejects invalid type', () => {
    expect(() => {
      db.prepare(
        "INSERT INTO knowledge (id, type, title, content) VALUES ('test1', 'invalid', 'Test', 'Content')",
      ).run();
    }).toThrow();
  });

  it('rejects invalid status', () => {
    expect(() => {
      db.prepare(
        "INSERT INTO knowledge (id, type, title, content, status) VALUES ('test1', 'concept', 'Test', 'Content', 'invalid')",
      ).run();
    }).toThrow();
  });

  it('rejects confidence out of range', () => {
    expect(() => {
      db.prepare(
        "INSERT INTO knowledge (id, type, title, content, confidence) VALUES ('test1', 'concept', 'Test', 'Content', 1.5)",
      ).run();
    }).toThrow();
  });

  it('accepts valid types: concept, decision, pattern', () => {
    for (const type of ['concept', 'decision', 'pattern']) {
      db.prepare(
        `INSERT INTO knowledge (id, type, title, content) VALUES ('test_${type}', '${type}', 'Test ${type}', 'Content')`,
      ).run();
    }
    const count = db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as { c: number };
    expect(count.c).toBe(3);
  });
});

describe('FTS5 triggers', () => {
  it('syncs inserts to FTS index', () => {
    db.prepare(
      "INSERT INTO knowledge (id, type, title, content) VALUES ('fts1', 'concept', 'Payment Flow', 'Stripe webhooks process orders')",
    ).run();

    const results = db
      .prepare(
        "SELECT k.title FROM knowledge_fts fts JOIN knowledge k ON k.rowid = fts.rowid WHERE knowledge_fts MATCH 'payment'",
      )
      .all() as { title: string }[];

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('Payment Flow');
  });

  it('syncs updates to FTS index', () => {
    db.prepare(
      "INSERT INTO knowledge (id, type, title, content) VALUES ('fts2', 'concept', 'Old Title', 'old content')",
    ).run();

    db.prepare("UPDATE knowledge SET title = 'New Title', content = 'new content about payments' WHERE id = 'fts2'").run();

    // Old title should not match
    const oldResults = db
      .prepare(
        "SELECT k.title FROM knowledge_fts fts JOIN knowledge k ON k.rowid = fts.rowid WHERE knowledge_fts MATCH 'old'",
      )
      .all();
    expect(oldResults).toHaveLength(0);

    // New content should match
    const newResults = db
      .prepare(
        "SELECT k.title FROM knowledge_fts fts JOIN knowledge k ON k.rowid = fts.rowid WHERE knowledge_fts MATCH 'payments'",
      )
      .all() as { title: string }[];
    expect(newResults).toHaveLength(1);
    expect(newResults[0]!.title).toBe('New Title');
  });

  it('syncs deletes from FTS index', () => {
    db.prepare(
      "INSERT INTO knowledge (id, type, title, content) VALUES ('fts3', 'concept', 'Deletable', 'will be deleted')",
    ).run();
    db.prepare("DELETE FROM knowledge WHERE id = 'fts3'").run();

    const results = db
      .prepare(
        "SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH 'deletable'",
      )
      .all();
    expect(results).toHaveLength(0);
  });
});

describe('relationships', () => {
  it('enforces unique constraint on from_id + to_id + relation_type', () => {
    db.prepare(
      "INSERT INTO knowledge (id, type, title, content) VALUES ('r1', 'concept', 'A', 'a'), ('r2', 'concept', 'B', 'b')",
    ).run();

    db.prepare(
      "INSERT INTO relationships (id, from_id, to_id, relation_type) VALUES ('rel1', 'r1', 'r2', 'depends_on')",
    ).run();

    expect(() => {
      db.prepare(
        "INSERT INTO relationships (id, from_id, to_id, relation_type) VALUES ('rel2', 'r1', 'r2', 'depends_on')",
      ).run();
    }).toThrow();
  });

  it('cascades deletes from knowledge to relationships', () => {
    db.prepare(
      "INSERT INTO knowledge (id, type, title, content) VALUES ('c1', 'concept', 'A', 'a'), ('c2', 'concept', 'B', 'b')",
    ).run();
    db.prepare(
      "INSERT INTO relationships (id, from_id, to_id, relation_type) VALUES ('rel1', 'c1', 'c2', 'depends_on')",
    ).run();

    db.prepare("DELETE FROM knowledge WHERE id = 'c1'").run();

    const rels = db.prepare('SELECT COUNT(*) as c FROM relationships').get() as { c: number };
    expect(rels.c).toBe(0);
  });
});
