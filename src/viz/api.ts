import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { KnowledgeRepository } from '../knowledge/repository.js';
import { KnowledgeSearch } from '../knowledge/search.js';
import { RelationshipRepository } from '../knowledge/relationships.js';
import type { EmbeddingEngine } from '../embeddings/engine.js';
import type { KnowledgeType } from '../knowledge/types.js';

export class BrainApi {
  private repo: KnowledgeRepository;
  private search: KnowledgeSearch;
  private relationships: RelationshipRepository;

  constructor(
    private db: Database.Database,
    embeddings: EmbeddingEngine,
  ) {
    this.repo = new KnowledgeRepository(db);
    this.search = new KnowledgeSearch(db, embeddings);
    this.relationships = new RelationshipRepository(db);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      if (path === '/api/stats') return this.handleStats(res);
      if (path === '/api/entries') return this.handleEntries(url, res);
      if (path === '/api/graph') return this.handleGraph(res);
      if (path === '/api/search') return await this.handleSearch(url, res);
      if (path === '/api/entry' && req.method === 'GET') return this.handleEntry(url, res);
      if (path === '/api/relationships') return this.handleRelationships(url, res);

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
    }
  }

  private handleStats(res: ServerResponse): void {
    const stats = this.repo.status();
    this.json(res, stats);
  }

  private handleEntries(url: URL, res: ServerResponse): void {
    const type = url.searchParams.get('type') as KnowledgeType | null;
    const scope = url.searchParams.get('scope') ?? undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);

    const entries = this.repo.list({
      type: type ?? undefined,
      scope,
      limit,
    });

    this.json(res, entries);
  }

  private handleGraph(res: ServerResponse): void {
    // Get all active entries as nodes + all relationships as edges
    const entries = this.repo.list({ limit: 10000 });
    const graph = this.relationships.graph();

    const nodes = entries.map((e) => ({
      id: e.id,
      title: e.title,
      type: e.type,
      scope: e.scope,
      tags: e.tags,
      confidence: e.confidence,
      content: e.content.slice(0, 200),
      created_at: e.created_at,
      // Check if this node has any relationships
      connected: graph.edges.some((edge) => edge.from_id === e.id || edge.to_id === e.id),
    }));

    const edges = graph.edges.map((e) => ({
      source: e.from_id,
      target: e.to_id,
      type: e.relation_type,
      description: e.description,
    }));

    this.json(res, { nodes, edges });
  }

  private async handleSearch(url: URL, res: ServerResponse): Promise<void> {
    const query = url.searchParams.get('q') ?? '';
    const type = url.searchParams.get('type') as KnowledgeType | null;
    const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);

    if (!query) {
      this.json(res, []);
      return;
    }

    const results = await this.search.search({
      query,
      type: type ?? undefined,
      limit,
    });

    this.json(
      res,
      results.map((r) => ({
        ...r.entry,
        score: r.score,
        search_source: r.source,
      })),
    );
  }

  private handleEntry(url: URL, res: ServerResponse): void {
    const id = url.searchParams.get('id');
    if (!id) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'id required' }));
      return;
    }

    const entry = this.repo.getById(id);
    if (!entry) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const outgoing = this.relationships.outgoing(id);
    const incoming = this.relationships.incoming(id);

    this.json(res, { ...entry, outgoing, incoming });
  }

  private handleRelationships(url: URL, res: ServerResponse): void {
    const id = url.searchParams.get('id');
    if (!id) {
      const graph = this.relationships.graph();
      this.json(res, graph);
      return;
    }

    const outgoing = this.relationships.outgoing(id);
    const incoming = this.relationships.incoming(id);
    this.json(res, { outgoing, incoming });
  }

  private json(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
