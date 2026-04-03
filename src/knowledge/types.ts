export type KnowledgeType = 'concept' | 'decision' | 'pattern';
export type KnowledgeStatus = 'active' | 'deprecated' | 'superseded';
export type KnowledgeSource = 'manual' | 'extracted' | 'imported';
export type RelationType =
  | 'depends_on'
  | 'implements'
  | 'supersedes'
  | 'related_to'
  | 'requires'
  | 'extends';

export interface KnowledgeEntry {
  id: string;
  type: KnowledgeType;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  tags: string[];
  scope: string;
  source: KnowledgeSource;
  source_ref: string | null;
  confidence: number;
  status: KnowledgeStatus;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
}

export interface CreateKnowledgeInput {
  type: KnowledgeType;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  scope?: string;
  source?: KnowledgeSource;
  source_ref?: string;
  confidence?: number;
}

export interface UpdateKnowledgeInput {
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  scope?: string;
  confidence?: number;
  status?: KnowledgeStatus;
  superseded_by?: string;
}

export interface Relationship {
  id: string;
  from_id: string;
  to_id: string;
  relation_type: RelationType;
  description: string | null;
  created_at: string;
}

export interface CreateRelationshipInput {
  from_id: string;
  to_id: string;
  relation_type: RelationType;
  description?: string;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;
  source: 'fts' | 'vector' | 'hybrid';
}

export interface BrainStatus {
  total_entries: number;
  by_type: Record<KnowledgeType, number>;
  by_status: Record<KnowledgeStatus, number>;
  total_relationships: number;
  total_embeddings: number;
  embedding_coverage: number; // 0-1
  db_size_bytes: number;
  last_activity: string | null;
}
