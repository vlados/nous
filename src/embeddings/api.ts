import OpenAI from 'openai';
import type { EmbeddingEngine } from './engine.js';
import { EMBEDDING_DIMENSIONS } from '../db/schema.js';

export class OpenAIEmbeddingEngine implements EmbeddingEngine {
  private client: OpenAI | null = null;
  private apiKey: string | null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env['OPENAI_API_KEY'] ?? null;
    if (this.apiKey) {
      this.client = new OpenAI({ apiKey: this.apiKey });
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  modelName(): string {
    return 'text-embedding-3-small';
  }

  dimensions(): number {
    return EMBEDDING_DIMENSIONS;
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.client) return null;

    try {
      const response = await this.client.embeddings.create({
        model: this.modelName(),
        input: text,
        dimensions: this.dimensions(),
      });

      const embedding = response.data[0]?.embedding;
      if (!embedding) return null;

      return new Float32Array(embedding);
    } catch (err) {
      // Circuit breaker: degrade gracefully on API errors
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('429') || message.includes('5')) {
        console.warn(`[nous] Embedding API error, falling back to FTS5: ${message}`);
        return null;
      }
      throw err;
    }
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    if (!this.client) return texts.map(() => null);

    try {
      const response = await this.client.embeddings.create({
        model: this.modelName(),
        input: texts,
        dimensions: this.dimensions(),
      });

      return response.data.map((d) => new Float32Array(d.embedding));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[nous] Embedding batch API error: ${message}`);
      return texts.map(() => null);
    }
  }
}
