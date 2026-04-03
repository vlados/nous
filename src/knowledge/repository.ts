import type Database from 'better-sqlite3';
import { generateId } from '../utils/id.js';
import type {
  KnowledgeEntry,
  CreateKnowledgeInput,
  UpdateKnowledgeInput,
  KnowledgeType,
  KnowledgeStatus,
  BrainStatus,
} from './types.js';

/** Map a raw SQLite row to a KnowledgeEntry. */
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
    status: row.status as KnowledgeStatus,
    superseded_by: (row.superseded_by as string) || null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    accessed_at: (row.accessed_at as string) || null,
  };
}

export class KnowledgeRepository {
  constructor(private db: Database.Database) {}

  insert(input: CreateKnowledgeInput): KnowledgeEntry {
    const id = generateId();
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '');

    this.db
      .prepare(
        `INSERT INTO knowledge (id, type, title, content, metadata, tags, scope, source, source_ref, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.title,
        input.content,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.tags ?? []),
        input.scope ?? '',
        input.source ?? 'manual',
        input.source_ref ?? null,
        input.confidence ?? 1.0,
        now,
        now,
      );

    return this.getById(id)!;
  }

  getById(id: string): KnowledgeEntry | null {
    const row = this.db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;

    // Update accessed_at
    this.db
      .prepare('UPDATE knowledge SET accessed_at = datetime(\'now\') WHERE id = ?')
      .run(id);

    return rowToEntry(row);
  }

  getByTitle(title: string): KnowledgeEntry | null {
    const row = this.db
      .prepare('SELECT * FROM knowledge WHERE title = ? COLLATE NOCASE AND status = \'active\'')
      .get(title) as Record<string, unknown> | undefined;

    return row ? rowToEntry(row) : null;
  }

  update(id: string, input: UpdateKnowledgeInput): KnowledgeEntry | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const fields: string[] = ['updated_at = datetime(\'now\')'];
    const values: unknown[] = [];

    if (input.title !== undefined) {
      fields.push('title = ?');
      values.push(input.title);
    }
    if (input.content !== undefined) {
      fields.push('content = ?');
      values.push(input.content);
    }
    if (input.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(JSON.stringify(input.metadata));
    }
    if (input.tags !== undefined) {
      fields.push('tags = ?');
      values.push(JSON.stringify(input.tags));
    }
    if (input.scope !== undefined) {
      fields.push('scope = ?');
      values.push(input.scope);
    }
    if (input.confidence !== undefined) {
      fields.push('confidence = ?');
      values.push(input.confidence);
    }
    if (input.status !== undefined) {
      fields.push('status = ?');
      values.push(input.status);
    }
    if (input.superseded_by !== undefined) {
      fields.push('superseded_by = ?');
      values.push(input.superseded_by);
    }

    values.push(id);

    this.db
      .prepare(`UPDATE knowledge SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM knowledge WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deprecate(id: string, supersededBy?: string): KnowledgeEntry | null {
    return this.update(id, {
      status: 'deprecated',
      superseded_by: supersededBy,
    });
  }

  list(options?: {
    type?: KnowledgeType;
    status?: KnowledgeStatus;
    scope?: string;
    limit?: number;
    offset?: number;
  }): KnowledgeEntry[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (options?.type) {
      conditions.push('type = ?');
      values.push(options.type);
    }
    if (options?.status) {
      conditions.push('status = ?');
      values.push(options.status);
    } else {
      // Default: only active entries
      conditions.push("status = 'active'");
    }
    if (options?.scope) {
      conditions.push('scope = ?');
      values.push(options.scope);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const rows = this.db
      .prepare(`SELECT * FROM knowledge ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as Record<string, unknown>[];

    return rows.map(rowToEntry);
  }

  recent(days: number = 7, options?: { type?: KnowledgeType; limit?: number }): KnowledgeEntry[] {
    const conditions: string[] = [
      "status = 'active'",
      `created_at >= datetime('now', '-${days} days')`,
    ];
    const values: unknown[] = [];

    if (options?.type) {
      conditions.push('type = ?');
      values.push(options.type);
    }

    const limit = options?.limit ?? 20;
    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = this.db
      .prepare(`SELECT * FROM knowledge ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, limit) as Record<string, unknown>[];

    return rows.map(rowToEntry);
  }

  status(): BrainStatus {
    const total = (
      this.db.prepare('SELECT COUNT(*) as count FROM knowledge').get() as { count: number }
    ).count;

    const byTypeRows = this.db
      .prepare('SELECT type, COUNT(*) as count FROM knowledge GROUP BY type')
      .all() as { type: string; count: number }[];
    const byType = { concept: 0, decision: 0, pattern: 0 } as Record<KnowledgeType, number>;
    for (const row of byTypeRows) {
      byType[row.type as KnowledgeType] = row.count;
    }

    const byStatusRows = this.db
      .prepare('SELECT status, COUNT(*) as count FROM knowledge GROUP BY status')
      .all() as { status: string; count: number }[];
    const byStatus = { active: 0, deprecated: 0, superseded: 0 } as Record<
      KnowledgeStatus,
      number
    >;
    for (const row of byStatusRows) {
      byStatus[row.status as KnowledgeStatus] = row.count;
    }

    const totalRelationships = (
      this.db.prepare('SELECT COUNT(*) as count FROM relationships').get() as { count: number }
    ).count;

    const totalEmbeddings = (
      this.db.prepare('SELECT COUNT(*) as count FROM knowledge_embeddings').get() as {
        count: number;
      }
    ).count;

    const lastRow = this.db
      .prepare("SELECT created_at FROM knowledge ORDER BY created_at DESC LIMIT 1")
      .get() as { created_at: string } | undefined;

    return {
      total_entries: total,
      by_type: byType,
      by_status: byStatus,
      total_relationships: totalRelationships,
      total_embeddings: totalEmbeddings,
      embedding_coverage: total > 0 ? totalEmbeddings / total : 0,
      db_size_bytes: 0, // Calculated by caller from file system
      last_activity: lastRow?.created_at ?? null,
    };
  }
}
