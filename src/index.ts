export { getConnection, closeConnection, getTestConnection } from './db/connection.js';
export { EMBEDDING_DIMENSIONS } from './db/schema.js';
export { KnowledgeRepository } from './knowledge/repository.js';
export type {
  KnowledgeEntry,
  CreateKnowledgeInput,
  UpdateKnowledgeInput,
  KnowledgeType,
  KnowledgeStatus,
  KnowledgeSource,
  Relationship,
  CreateRelationshipInput,
  RelationType,
  SearchResult,
  BrainStatus,
} from './knowledge/types.js';
export { KnowledgeSearch } from './knowledge/search.js';
export { OpenAIEmbeddingEngine } from './embeddings/api.js';
export { FallbackEmbeddingEngine } from './embeddings/fallback.js';
export type { EmbeddingEngine } from './embeddings/engine.js';
export { createMcpServer, startMcpServer } from './mcp/server.js';
export { findNousDir, getDbPath, loadConfig, saveConfig } from './utils/config.js';
export { generateId } from './utils/id.js';
