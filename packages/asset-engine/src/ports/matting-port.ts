/**
 * Cutout to clean alpha, behind an interface so the model is a wiring decision.
 *
 * Research §4 chose BiRefNet through `@huggingface/transformers` as primary because it
 * is illustration-tuned, with `@imgly/background-removal-node` as fallback. Both of
 * those are *engines*, and both will be wrong for some subject: a flat parts sheet on a
 * neutral field is better keyed than segmented, and a segmentation model asked to key a
 * flat field will happily eat a pale wing.
 *
 * So matting is a port with several implementations and an explicit chain
 * ({@link ChainedMattingPort}), and the engine that produced each cutout is recorded on
 * the result - RV-123 requires it, and "which engine matted this" is the first question
 * asked when a part comes back with a halo.
 */

import type { AppError, Result } from '@rv/shared-kernel';

import type { RgbaImage } from './raster-port';

/**
 * A stable name for one matting implementation.
 *
 * Free-form rather than an enum: an adapter that ships later must be namable without
 * editing this package, and the value is recorded for provenance rather than switched
 * on. Nothing in the engine branches on it.
 */
export type MattingEngineId = string;

export interface MatteRequest {
  readonly image: RgbaImage;
  /**
   * What the background is expected to look like, when the caller knows.
   *
   * A parts sheet is generated on a declared neutral field, so the caller does know,
   * and a keying implementation is both cheaper and sharper than a learned matte.
   * Segmentation implementations ignore it.
   */
  readonly backgroundHint?: { readonly r: number; readonly g: number; readonly b: number };
  /** Subject class, for engines that select a checkpoint by subject. */
  readonly subject?: string;
}

export interface MatteResult {
  readonly image: RgbaImage;
  /** Which implementation produced `image`. Recorded on the part's provenance. */
  readonly engine: MattingEngineId;
  /**
   * Engines tried before this one, with why each was skipped.
   *
   * Empty when the primary worked. Non-empty is not a failure - it is the record that
   * makes "why is this cutout soft" answerable without re-running the pipeline.
   */
  readonly fallbacks: readonly { readonly engine: MattingEngineId; readonly reason: string }[];
}

export interface MattingPort {
  readonly engine: MattingEngineId;
  matte(request: MatteRequest): Promise<Result<MatteResult, AppError>>;
}

/**
 * A learned foreground mask, separated from the matting port that consumes it.
 *
 * The split exists so the alpha arithmetic - applying the mask, feathering, deciding
 * what counts as background - lives in testable application code, and only the
 * "run a neural net" step sits behind a boundary that needs a model file to exercise.
 */
export interface SegmentationModel {
  readonly id: MattingEngineId;
  /**
   * Returns one 0..255 confidence byte per pixel, row-major, `width * height` long.
   *
   * Bytes rather than floats because that is what every ONNX post-process quantises to
   * anyway, and because a `Uint8Array` compares byte-for-byte in a determinism test.
   */
  segment(image: RgbaImage): Promise<Result<Uint8Array, AppError>>;
}
