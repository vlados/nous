import type Database from 'better-sqlite3';
import { generateId } from '../utils/id.js';
import type { Relationship, CreateRelationshipInput, RelationType } from './types.js';

function rowToRelationship(row: Record<string, unknown>): Relationship {
  return {
    id: row.id as string,
    from_id: row.from_id as string,
    to_id: row.to_id as string,
    relation_type: row.relation_type as RelationType,
    description: (row.description as string) || null,
    created_at: row.created_at as string,
  };
}

export class RelationshipRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateRelationshipInput): Relationship {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO relationships (id, from_id, to_id, relation_type, description)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.from_id, input.to_id, input.relation_type, input.description ?? null);

    return this.getById(id)!;
  }

  getById(id: string): Relationship | null {
    const row = this.db.prepare('SELECT * FROM relationships WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRelationship(row) : null;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM relationships WHERE id = ?').run(id).changes > 0;
  }

  /** Get all outgoing relationships from an entry. */
  outgoing(fromId: string): (Relationship & { to_title: string; to_type: string })[] {
    return this.db
      .prepare(
        `SELECT r.*, k.title as to_title, k.type as to_type
         FROM relationships r
         JOIN knowledge k ON k.id = r.to_id
         WHERE r.from_id = ?`,
      )
      .all(fromId) as (Relationship & { to_title: string; to_type: string })[];
  }

  /** Get all incoming relationships to an entry. */
  incoming(toId: string): (Relationship & { from_title: string; from_type: string })[] {
    return this.db
      .prepare(
        `SELECT r.*, k.title as from_title, k.type as from_type
         FROM relationships r
         JOIN knowledge k ON k.id = r.from_id
         WHERE r.to_id = ?`,
      )
      .all(toId) as (Relationship & { from_title: string; from_type: string })[];
  }

  /**
   * BFS graph traversal from a starting node.
   * Returns all reachable entries within maxHops.
   */
  traverse(
    startId: string,
    options?: { maxHops?: number; relationType?: RelationType },
  ): { id: string; title: string; type: string; depth: number; via: string }[] {
    const maxHops = options?.maxHops ?? 3;
    const visited = new Set<string>([startId]);
    const result: { id: string; title: string; type: string; depth: number; via: string }[] = [];
    let frontier = [startId];

    for (let depth = 1; depth <= maxHops; depth++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const conditions = ['r.from_id = ?'];
        const params: unknown[] = [nodeId];

        if (options?.relationType) {
          conditions.push('r.relation_type = ?');
          params.push(options.relationType);
        }

        const neighbors = this.db
          .prepare(
            `SELECT r.to_id as id, k.title, k.type, r.relation_type as via
             FROM relationships r
             JOIN knowledge k ON k.id = r.to_id
             WHERE ${conditions.join(' AND ')}`,
          )
          .all(...params) as { id: string; title: string; type: string; via: string }[];

        for (const neighbor of neighbors) {
          if (!visited.has(neighbor.id)) {
            visited.add(neighbor.id);
            result.push({ ...neighbor, depth });
            nextFrontier.push(neighbor.id);
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return result;
  }

  /** Get full adjacency list for visualization. */
  graph(): { nodes: { id: string; title: string; type: string }[]; edges: Relationship[] } {
    const nodes = this.db
      .prepare(
        `SELECT DISTINCT k.id, k.title, k.type
         FROM knowledge k
         WHERE k.id IN (
           SELECT from_id FROM relationships
           UNION
           SELECT to_id FROM relationships
         )`,
      )
      .all() as { id: string; title: string; type: string }[];

    const edges = (this.db.prepare('SELECT * FROM relationships').all() as Record<string, unknown>[]).map(
      rowToRelationship,
    );

    return { nodes, edges };
  }
}
