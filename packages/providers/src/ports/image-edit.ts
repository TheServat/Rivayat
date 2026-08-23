/**
 * Editing an existing image rather than generating a new one.
 *
 * Separate from `ImageGenerationPort` because the capability genuinely differs:
 * research §2 records Gemini image models as `text+image -> text+image`, while
 * `openai/gpt-5-image-mini` generates only. Folding the two together would let the
 * router send an edit to a model that can only start from scratch.
 */

import type { Size } from '@rv/contracts';
import type { AppError, Result } from '@rv/shared-kernel';

import type { ImagePayload } from './common';
import type { ImageResult } from './image-generation';

export interface ImageEditRequest {
  readonly base: ImagePayload;
  /** White = edit here. Omitted for a whole-image restyle. */
  readonly mask?: ImagePayload;
  readonly references?: readonly ImagePayload[];
  readonly instruction: string;
  readonly size?: Size;
  readonly seed?: number;
  /**
   * How far the edit may travel from the base, 0..1.
   *
   * Named after the diffusion parameter it maps to (`denoise`) rather than after an
   * abstraction, because every local workflow exposes exactly this dial and a
   * prettier name would only hide which number the user is actually turning.
   */
  readonly strength?: number;
  readonly signal?: AbortSignal;
}

export interface ImageEditPort {
  editImage(request: ImageEditRequest): Promise<Result<ImageResult, AppError>>;
}
