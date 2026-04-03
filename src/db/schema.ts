import type Database from 'better-sqlite3';

const SCHEMA_SQL = `
-- ═══════════════════════════════════════════════════════════════
-- METADATA — schema versioning and project config
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS nous_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO nous_meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO nous_meta (key, value) VALUES ('created_at', datetime('now'));
INSERT OR IGNORE INTO nous_meta (key, value) VALUES ('project_name', '');

-- ═══════════════════════════════════════════════════════════════
-- KNOWLEDGE — single table, type-discriminated
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS knowledge (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL CHECK (type IN ('concept', 'decision', 'pattern')),
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    metadata    TEXT NOT NULL DEFAULT '{}',
    tags        TEXT NOT NULL DEFAULT '[]',
    scope       TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'manual',
    source_ref  TEXT,
    confidence  REAL NOT NULL DEFAULT 1.0
        CHECK (confidence >= 0.0 AND confidence <= 1.0),
    status      TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'deprecated', 'superseded')),
    superseded_by TEXT REFERENCES knowledge(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    accessed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge(scope);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge(created_at);

-- ═══════════════════════════════════════════════════════════════
-- FTS5 — full-text search on title + content + tags
-- ═══════════════════════════════════════════════════════════════
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    title,
    content,
    tags,
    content=knowledge,
    content_rowid=rowid,
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync with the knowledge table
CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
    INSERT INTO knowledge_fts(rowid, title, content, tags)
    VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
    INSERT INTO knowledge_fts(rowid, title, content, tags)
    VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
END;

-- ═══════════════════════════════════════════════════════════════
-- EMBEDDINGS — stored separately for re-embedding flexibility
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    knowledge_id TEXT PRIMARY KEY REFERENCES knowledge(id) ON DELETE CASCADE,
    embedding    BLOB NOT NULL,
    model        TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    embedded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════
-- RELATIONSHIPS — directed edges between knowledge entries
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS relationships (
    id            TEXT PRIMARY KEY,
    from_id       TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    to_id         TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    description   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_id, to_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relationships(to_id);
CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(relation_type);

-- ═══════════════════════════════════════════════════════════════
-- EXTRACTION LOG — dedup for auto-extracted knowledge
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS extraction_log (
    id            TEXT PRIMARY KEY,
    source_type   TEXT NOT NULL,
    source_ref    TEXT NOT NULL,
    content_hash  TEXT NOT NULL UNIQUE,
    extracted_ids TEXT NOT NULL DEFAULT '[]',
    processed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// sqlite-vec virtual table — must be created after the extension is loaded
const VEC_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_knowledge USING vec0(
    knowledge_id TEXT PRIMARY KEY,
    embedding float[1536]
);
`;

export function initializeSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);

  // Create the vec0 virtual table (requires sqlite-vec extension)
  try {
    db.exec(VEC_TABLE_SQL);
  } catch (err) {
    // vec0 table may already exist — that's fine
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('already exists')) {
      throw err;
    }
  }
}

export const EMBEDDING_DIMENSIONS = 1536;
