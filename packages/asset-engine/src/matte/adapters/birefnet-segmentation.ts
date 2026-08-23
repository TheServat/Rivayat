/**
 * BiRefNet through `@huggingface/transformers` - research §4's primary matting engine.
 *
 * It is illustration-tuned, which is the whole reason it is first: the 2026-07
 * "Lucida" fine-tune targets illustrations, glow/VFX and transparent objects, and this
 * pipeline generates nothing else. A person-segmentation model would cut a paper-cutout
 * fox out of a flat field by guessing.
 *
 * Two deliberate shapes:
 *
 * - **The module is loaded lazily and injectably.** `@huggingface/transformers` drags
 *   in `onnxruntime-node`, and paying that import cost on every process that touches an
 *   `AssetSpec` would make the CLI slow for no reason. The injection point is also what
 *   makes the adapter testable at all - CLAUDE.md §3 forbids a live model download in
 *   CI, so the tests substitute the loader and the *arithmetic* is what gets covered.
 * - **It returns a mask, not a matte.** Everything about how the mask becomes alpha
 *   lives in {@link ModelMatting}, where it is plain testable code.
 */

import { type AppError, type Result, ProviderError, ok } from '@rv/shared-kernel';

import type { MattingEngineId, SegmentationModel } from '../../ports/matting-port';
import type { RgbaImage } from '../../ports/raster-port';

/** The subset of `@huggingface/transformers` this adapter uses. */
export interface TransformersLike {
  pipeline(
    task: 'background-removal',
    model?: string,
    options?: Record<string, unknown>,
  ): Promise<BackgroundRemover>;
  RawImage: new (
    data: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    channels: 1 | 2 | 3 | 4,
  ) => RawImageLike;
}

export interface RawImageLike {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
}

export type BackgroundRemover = (image: RawImageLike) => Promise<RawImageLike | RawImageLike[]>;

export interface BiRefNetOptions {
  /**
   * Model id on the hub. Defaults to the illustration-tuned lite checkpoint.
   *
   * A parameter rather than a constant because the checkpoint is the thing most likely
   * to be tuned per project, and because `image.lane`-style settings are declared, not
   * hard-coded (architecture §7b).
   */
  readonly model?: string;
  /** Runtime options handed straight to the pipeline, e.g. `{ dtype: 'q8' }`. */
  readonly pipelineOptions?: Record<string, unknown>;
  /** Overridden in tests. Defaults to a dynamic import of the real package. */
  readonly load?: () => Promise<TransformersLike>;
}

export const BIREFNET_ENGINE = 'birefnet';
export const DEFAULT_BIREFNET_MODEL = 'onnx-community/BiRefNet_lite';

export class BiRefNetSegmentation implements SegmentationModel {
  readonly id: MattingEngineId = BIREFNET_ENGINE;
  readonly #model: string;
  readonly #pipelineOptions: Record<string, unknown>;
  readonly #load: () => Promise<TransformersLike>;
  #remover: Promise<BackgroundRemover> | undefined;

  constructor(options: BiRefNetOptions = {}) {
    this.#model = options.model ?? DEFAULT_BIREFNET_MODEL;
    this.#pipelineOptions = options.pipelineOptions ?? {};
    this.#load = options.load ?? loadTransformers;
  }

  async segment(image: RgbaImage): Promise<Result<Uint8Array, AppError>> {
    let cut: RawImageLike | RawImageLike[];
    let module: TransformersLike;
    try {
      module = await this.#load();
      this.#remover ??= module.pipeline('background-removal', this.#model, this.#pipelineOptions);
      const remover = await this.#remover;
      cut = await remover(new module.RawImage(image.data, image.width, image.height, 4));
    } catch (caught: unknown) {
      // The adapter boundary is where an exception becomes a `Result`, exactly once.
      // A model that will not load is a provider failure, not a programmer error - the
      // chain is supposed to fall through to the next engine.
      this.#remover = undefined;
      return err(caught, this.#model);
    }

    const first = Array.isArray(cut) ? cut[0] : cut;
    if (first === undefined) {
      return err(new Error('background-removal returned no image'), this.#model);
    }

    return ok(alphaChannel(first, image.width * image.height));
  }
}

/**
 * The alpha plane of the cut image, as one byte per pixel.
 *
 * The pipeline returns RGBA with the background already zeroed, so alpha *is* the
 * confidence mask. Reading it rather than re-deriving one from the colour keeps this
 * adapter from having an opinion about what the matte should look like.
 */
function alphaChannel(image: RawImageLike, expectedPixels: number): Uint8Array {
  const mask = new Uint8Array(expectedPixels);
  const channels = image.channels;
  for (let i = 0; i < expectedPixels; i += 1) {
    // A model that returned fewer channels than four has no alpha to read; treat every
    // returned pixel as foreground rather than inventing a gradient.
    mask[i] = channels >= 4 ? (image.data[i * channels + 3] ?? 0) : 255;
  }
  return mask;
}

function err(caught: unknown, model: string): Result<Uint8Array, AppError> {
  return {
    ok: false,
    error: new ProviderError({
      message: caught instanceof Error ? caught.message : 'BiRefNet segmentation failed',
      provider: `huggingface:${model}`,
      cause: caught,
      retryable: false,
    }),
  };
}

/* c8 ignore start -- loads a 100 MB ONNX runtime; CI runs the injected loader instead. */
async function loadTransformers(): Promise<TransformersLike> {
  const module: unknown = await import('@huggingface/transformers');
  return module as TransformersLike;
}
/* c8 ignore stop */
