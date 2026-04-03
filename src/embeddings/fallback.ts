import type { EmbeddingEngine } from './engine.js';

/**
 * No-op embedding engine used when no API key is configured.
 * Search degrades to FTS5-only mode — still fully functional for keyword search.
 */
export class FallbackEmbeddingEngine implements EmbeddingEngine {
  isAvailable(): boolean {
    return false;
  }

  modelName(): string {
    return 'none';
  }

  dimensions(): number {
    return 0;
  }

  async embed(): Promise<null> {
    return null;
  }

  async embedBatch(texts: string[]): Promise<null[]> {
    return texts.map(() => null);
  }
}
