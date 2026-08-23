/**
 * A learned matte: BiRefNet, RMBG or anything else that returns a confidence mask.
 *
 * The neural half sits behind {@link SegmentationModel} and the arithmetic sits here,
 * so everything that decides what the cutout *looks like* - the confidence floor, the
 * gamma on the ramp, what happens to alpha the generator already supplied - is plain
 * code with a test, and only "run the ONNX graph" needs a model file.
 *
 * Research §4 picked BiRefNet as primary because the 2026-07 "Lucida" fine-tune targets
 * illustrations, glow/VFX and transparent objects specifically, which is what this
 * pipeline generates. `@imgly/background-removal-node` is the documented fallback and
 * is a second implementation of this same interface.
 */

import { type AppError, type Result, ValidationError, err, isErr, ok } from '@rv/shared-kernel';

import type {
  MatteRequest,
  MatteResult,
  MattingPort,
  SegmentationModel,
} from '../ports/matting-port';
import { px } from '../raster/pixels';

export interface ModelMattingOptions {
  /**
   * Mask value below which a pixel is background outright.
   *
   * A floor rather than a straight copy of the mask: segmentation models emit a low,
   * non-zero confidence across the whole background, and copying it verbatim produces a
   * uniform 3 % veil that reads as a grey haze once the asset is composited.
   */
  readonly floor?: number;
  /** Mask value at or above which a pixel is fully opaque. */
  readonly ceiling?: number;
}

export class ModelMatting implements MattingPort {
  readonly engine: string;
  readonly #model: SegmentationModel;
  readonly #floor: number;
  readonly #ceiling: number;

  constructor(model: SegmentationModel, options: ModelMattingOptions = {}) {
    this.#model = model;
    this.engine = model.id;
    this.#floor = options.floor ?? 24;
    this.#ceiling = options.ceiling ?? 232;
  }

  async matte(request: MatteRequest): Promise<Result<MatteResult, AppError>> {
    const source = request.image;
    const mask = await this.#model.segment(source);
    if (isErr(mask)) return mask;

    const count = source.width * source.height;
    if (mask.value.length !== count) {
      return err(
        new ValidationError({
          message: 'segmentation mask does not match the image it was made from',
          context: { engine: this.engine, expected: count, actual: mask.value.length },
        }),
      );
    }

    const span = Math.max(1, this.#ceiling - this.#floor);
    const data = Uint8Array.from(source.data);
    for (let i = 0; i < count; i += 1) {
      const raw = px(mask.value, i);
      const scaled =
        raw <= this.#floor
          ? 0
          : raw >= this.#ceiling
            ? 255
            : Math.round((255 * (raw - this.#floor)) / span);
      data[i * 4 + 3] = Math.round((px(data, i * 4 + 3) * scaled) / 255);
    }

    return ok({
      image: { width: source.width, height: source.height, data },
      engine: this.engine,
      fallbacks: [],
    });
  }
}
