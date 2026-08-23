/**
 * Text (plus optional reference images) to pixels.
 *
 * `references` is not decoration: multi-reference conditioning is what buys character
 * consistency without training a LoRA (research §3), so it is part of the port rather
 * than a provider-specific extra.
 */

import type { Size } from '@rv/contracts';
import type { AppError, Result } from '@rv/shared-kernel';

import type { ImageArtifact, ImagePayload, ProviderCallResult } from './common';

export interface ImageGenerationRequest {
  readonly prompt: string;
  /** Ignored by providers that have no negative-prompt channel. */
  readonly negativePrompt?: string;
  readonly size?: Size;
  readonly count?: number;
  readonly seed?: number;
  /** Style anchors and character turnarounds, in priority order. */
  readonly references?: readonly ImagePayload[];
  readonly signal?: AbortSignal;
}

export interface ImageResult extends ProviderCallResult {
  readonly images: readonly ImageArtifact[];
}

export interface ImageGenerationPort {
  generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>>;
}
