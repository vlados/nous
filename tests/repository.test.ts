import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTestConnection } from '../src/db/connection.js';
import { KnowledgeRepository } from '../src/knowledge/repository.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let repo: KnowledgeRepository;

beforeEach(() => {
  db = getTestConnection();
  repo = new KnowledgeRepository(db);
});

afterEach(() => {
  db.close();
});

describe('insert', () => {
  it('creates a knowledge entry with ULID', () => {
    const entry = repo.insert({
      type: 'concept',
      title: 'Test Concept',
      content: 'This is a test concept',
    });

    expect(entry.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(entry.type).toBe('concept');
    expect(entry.title).toBe('Test Concept');
    expect(entry.content).toBe('This is a test concept');
    expect(entry.status).toBe('active');
    expect(entry.confidence).toBe(1.0);
    expect(entry.source).toBe('manual');
  });

  it('stores tags as JSON array', () => {
    const entry = repo.insert({
      type: 'decision',
      title: 'Test Decision',
      content: 'Chose X over Y',
      tags: ['architecture', 'database'],
    });

    expect(entry.tags).toEqual(['architecture', 'database']);
  });

  it('stores metadata as JSON object', () => {
    const entry = repo.insert({
      type: 'decision',
      title: 'Test Decision',
      content: 'Chose X',
      metadata: { alternatives: ['Y', 'Z'], rationale: 'performance' },
    });

    expect(entry.metadata).toEqual({ alternatives: ['Y', 'Z'], rationale: 'performance' });
  });

  it('respects optional fields', () => {
    const entry = repo.insert({
      type: 'pattern',
      title: 'Always use X',
      content: 'When doing Y, always use X',
      scope: 'backend',
      source: 'extracted',
      source_ref: 'conversation-123',
      confidence: 0.7,
    });

    expect(entry.scope).toBe('backend');
    expect(entry.source).toBe('extracted');
    expect(entry.source_ref).toBe('conversation-123');
    expect(entry.confidence).toBe(0.7);
  });
});

describe('getById', () => {
  it('returns entry by ID', () => {
    const created = repo.insert({
      type: 'concept',
      title: 'Findable',
      content: 'Should be found',
    });

    const found = repo.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Findable');
  });

  it('returns null for non-existent ID', () => {
    expect(repo.getById('nonexistent')).toBeNull();
  });
});

describe('getByTitle', () => {
  it('returns entry by exact title (case insensitive)', () => {
    repo.insert({
      type: 'concept',
      title: 'Payment Flow',
      content: 'How payments work',
    });

    const found = repo.getByTitle('payment flow');
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Payment Flow');
  });

  it('ignores deprecated entries', () => {
    const entry = repo.insert({
      type: 'concept',
      title: 'Old Pattern',
      content: 'Deprecated stuff',
    });
    repo.deprecate(entry.id);

    expect(repo.getByTitle('Old Pattern')).toBeNull();
  });
});

describe('update', () => {
  it('updates specific fields', () => {
    const entry = repo.insert({
      type: 'concept',
      title: 'Original',
      content: 'Original content',
    });

    const updated = repo.update(entry.id, {
      title: 'Updated',
      content: 'Updated content',
      tags: ['new-tag'],
    });

    expect(updated!.title).toBe('Updated');
    expect(updated!.content).toBe('Updated content');
    expect(updated!.tags).toEqual(['new-tag']);
  });

  it('returns null for non-existent ID', () => {
    expect(repo.update('nonexistent', { title: 'X' })).toBeNull();
  });
});

describe('delete', () => {
  it('removes entry', () => {
    const entry = repo.insert({
      type: 'concept',
      title: 'Delete Me',
      content: 'Will be deleted',
    });

    expect(repo.delete(entry.id)).toBe(true);
    expect(repo.getById(entry.id)).toBeNull();
  });

  it('returns false for non-existent ID', () => {
    expect(repo.delete('nonexistent')).toBe(false);
  });
});

describe('deprecate', () => {
  it('sets status to deprecated', () => {
    const entry = repo.insert({
      type: 'concept',
      title: 'Deprecatable',
      content: 'Will be deprecated',
    });

    const deprecated = repo.deprecate(entry.id);
    expect(deprecated!.status).toBe('deprecated');
  });

  it('sets superseded_by reference', () => {
    const old = repo.insert({ type: 'concept', title: 'Old', content: 'old' });
    const replacement = repo.insert({ type: 'concept', title: 'New', content: 'new' });

    const deprecated = repo.deprecate(old.id, replacement.id);
    expect(deprecated!.superseded_by).toBe(replacement.id);
  });
});

describe('list', () => {
  beforeEach(() => {
    repo.insert({ type: 'concept', title: 'C1', content: 'concept 1', scope: 'backend' });
    repo.insert({ type: 'concept', title: 'C2', content: 'concept 2', scope: 'frontend' });
    repo.insert({ type: 'decision', title: 'D1', content: 'decision 1' });
    repo.insert({ type: 'pattern', title: 'P1', content: 'pattern 1' });
  });

  it('lists all active entries by default', () => {
    const entries = repo.list();
    expect(entries).toHaveLength(4);
  });

  it('filters by type', () => {
    const concepts = repo.list({ type: 'concept' });
    expect(concepts).toHaveLength(2);
    expect(concepts.every((e) => e.type === 'concept')).toBe(true);
  });

  it('filters by scope', () => {
    const backend = repo.list({ scope: 'backend' });
    expect(backend).toHaveLength(1);
    expect(backend[0]!.title).toBe('C1');
  });

  it('respects limit', () => {
    const limited = repo.list({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('excludes deprecated by default', () => {
    const entry = repo.list()[0]!;
    repo.deprecate(entry.id);

    const entries = repo.list();
    expect(entries).toHaveLength(3);
  });
});

describe('recent', () => {
  it('returns entries created within N days', () => {
    repo.insert({ type: 'concept', title: 'Recent', content: 'just created' });

    const recent = repo.recent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.title).toBe('Recent');
  });
});

describe('status', () => {
  it('returns correct statistics', () => {
    repo.insert({ type: 'concept', title: 'C1', content: 'c1' });
    repo.insert({ type: 'concept', title: 'C2', content: 'c2' });
    repo.insert({ type: 'decision', title: 'D1', content: 'd1' });

    const deprecated = repo.insert({ type: 'pattern', title: 'P1', content: 'p1' });
    repo.deprecate(deprecated.id);

    const stats = repo.status();
    expect(stats.total_entries).toBe(4);
    expect(stats.by_type.concept).toBe(2);
    expect(stats.by_type.decision).toBe(1);
    expect(stats.by_type.pattern).toBe(1);
    expect(stats.by_status.active).toBe(3);
    expect(stats.by_status.deprecated).toBe(1);
    expect(stats.total_relationships).toBe(0);
    expect(stats.total_embeddings).toBe(0);
    expect(stats.embedding_coverage).toBe(0);
    expect(stats.last_activity).not.toBeNull();
  });
});
