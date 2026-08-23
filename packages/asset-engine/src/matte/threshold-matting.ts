/**
 * Keying a neutral field, which is the case the parts-sheet lane actually produces.
 *
 * The prompt asks for "separated components on one flat neutral field", so the
 * background is a known, flat colour and the right tool is a key, not a learned matte.
 * A segmentation model asked to cut a flat field will happily eat a pale wing, and it
 * costs a model load to do it.
 *
 * Two details make this more than a colour compare:
 *
 * - **Flood fill from the border.** Only background-coloured pixels *connected to the
 *   edge* are removed. A white highlight in an eye, a grey rivet on a grey hull and the
 *   sky seen through a window survive, and those are exactly the holes a naive key
 *   punches.
 * - **A soft ramp.** Pixels between `tolerance` and `softTolerance` get partial alpha
 *   proportional to how far they are from the background colour, so the antialiased
 *   rim of a shape does not become a stair-step. The ramp is narrow on purpose:
 *   widening it is how a cutout gets a halo, and `alphaCleanliness` measures exactly
 *   that.
 */

import { type AppError, type Result, at, ok } from '@rv/shared-kernel';

import type { MatteRequest, MatteResult, MattingPort } from '../ports/matting-port';
import type { RgbaImage } from '../ports/raster-port';
import { at32, px } from '../raster/pixels';

export interface ThresholdMattingOptions {
  /** Squared RGB distance at or below which a pixel is certainly background. */
  readonly tolerance?: number;
  /** Squared RGB distance above which a pixel is certainly foreground. */
  readonly softTolerance?: number;
}

const DEFAULT_TOLERANCE = 18 * 18 * 3;
const DEFAULT_SOFT_TOLERANCE = 46 * 46 * 3;

export const THRESHOLD_ENGINE = 'threshold-key';

export class ThresholdMatting implements MattingPort {
  readonly engine = THRESHOLD_ENGINE;
  readonly #tolerance: number;
  readonly #softTolerance: number;

  constructor(options: ThresholdMattingOptions = {}) {
    this.#tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    this.#softTolerance = options.softTolerance ?? DEFAULT_SOFT_TOLERANCE;
  }

  matte(request: MatteRequest): Promise<Result<MatteResult, AppError>> {
    const source = request.image;
    const background = request.backgroundHint ?? sampleBackground(source);
    const alpha = keyAlpha(source, background, this.#tolerance, this.#softTolerance);

    const data = Uint8Array.from(source.data);
    for (let i = 0; i < source.width * source.height; i += 1) {
      // Multiply rather than replace: an input that already carried alpha (a re-matte,
      // or an RGBA generation) must not have its transparency resurrected.
      data[i * 4 + 3] = Math.round((px(data, i * 4 + 3) * px(alpha, i)) / 255);
    }

    return Promise.resolve(
      ok({
        image: { width: source.width, height: source.height, data },
        engine: this.engine,
        fallbacks: [],
      }),
    );
  }
}

/**
 * The background colour, taken as the median of the four corners.
 *
 * Median rather than mean: a corner that happens to clip a component drags a mean into
 * a colour that exists nowhere in the image, and the key then removes nothing.
 */
export function sampleBackground(image: RgbaImage): { r: number; g: number; b: number } {
  const { width, height, data } = image;
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  const channel = (offset: number): number => {
    const values = corners.map((index) => px(data, index * 4 + offset)).sort((a, b) => a - b);
    return Math.round((at(values, 1) + at(values, 2)) / 2);
  };
  return { r: channel(0), g: channel(1), b: channel(2) };
}

/** 0..255 keep-mask: 0 removes the pixel, 255 keeps it. */
function keyAlpha(
  image: RgbaImage,
  background: { r: number; g: number; b: number },
  tolerance: number,
  softTolerance: number,
): Uint8Array {
  const { width, height, data } = image;
  const count = width * height;
  const alpha = new Uint8Array(count).fill(255);

  const distance = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const dr = px(data, i * 4) - background.r;
    const dg = px(data, i * 4 + 1) - background.g;
    const db = px(data, i * 4 + 2) - background.b;
    distance[i] = dr * dr + dg * dg + db * db;
  }

  // Four-connected flood fill from every border pixel that looks like background.
  const queue: number[] = [];
  const visited = new Uint8Array(count);
  const push = (index: number): void => {
    if (visited[index] === 1) return;
    if (at32(distance, index) > softTolerance) return;
    visited[index] = 1;
    queue.push(index);
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  for (let head = 0; head < queue.length; head += 1) {
    const index = at(queue, head);
    const d = at32(distance, index);
    alpha[index] =
      d <= tolerance
        ? 0
        : Math.round((255 * (d - tolerance)) / Math.max(1, softTolerance - tolerance));

    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) push(index - 1);
    if (x + 1 < width) push(index + 1);
    if (y > 0) push(index - width);
    if (y + 1 < height) push(index + width);
  }

  return alpha;
}
