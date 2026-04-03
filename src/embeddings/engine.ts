export interface EmbeddingEngine {
  /** Generate an embedding vector for the given text. Returns null if unavailable. */
  embed(text: string): Promise<Float32Array | null>;

  /** Generate embeddings for multiple texts in batch. */
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;

  /** Whether the engine is ready (e.g., API key configured). */
  isAvailable(): boolean;

  /** The model name used for embeddings. */
  modelName(): string;

  /** The dimensionality of output vectors. */
  dimensions(): number;
}
