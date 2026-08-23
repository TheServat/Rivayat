/**
 * Text to vectors, for the asset registry's semantic index.
 *
 * One method, one batch. Batching is in the port rather than left to the caller
 * because every provider bills and rate-limits per request, so a loop over singles is
 * a cost bug the port should not make easy to write.
 */

import type { AppError, Result } from '@rv/shared-kernel';

import type { ProviderCallResult } from './common';

export interface EmbeddingRequest {
  readonly texts: readonly string[];
  readonly signal?: AbortSignal;
}

export interface EmbeddingResult extends ProviderCallResult {
  /** One vector per input text, in the same order. */
  readonly vectors: readonly (readonly number[])[];
  /** Length of every vector. Recorded so a model swap that changes it is detectable. */
  readonly dimensions: number;
}

export interface EmbeddingPort {
  embed(request: EmbeddingRequest): Promise<Result<EmbeddingResult, AppError>>;
}
