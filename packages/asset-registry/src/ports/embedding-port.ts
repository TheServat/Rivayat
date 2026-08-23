/**
 * Text → vector, for "find it before you make it".
 *
 * Declared locally rather than imported from `@rv/providers`: a port belongs to the
 * layer that *needs* the capability, and importing one from the infrastructure package
 * would point the dependency arrow outward. When `@rv/providers` ships its Ollama
 * embedding adapter it implements this interface; nothing here changes.
 */

import type { Result } from '@rv/shared-kernel';

export interface EmbeddingPort {
  /**
   * Which model produced the vectors.
   *
   * Recorded with every stored embedding, because vectors from two models share a
   * number space but not a meaning - comparing across them produces confident nonsense.
   */
  readonly model: string;
  readonly dimensions: number;
  /** Batched: one call per query would make indexing a library O(n) round trips. */
  embed(texts: readonly string[]): Promise<Result<readonly (readonly number[])[]>>;
}
