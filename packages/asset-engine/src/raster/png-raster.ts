/**
 * The default {@link RasterPort}: PNG in, PNG out, arithmetic in between.
 *
 * Everything here is pure and synchronous, which is what lets the segmentation,
 * splitting and baking tests run on real pixels with no IO and no GPU. A faster
 * `sharp`-backed adapter is a drop-in replacement for the same interface and belongs
 * in the infrastructure layer (architecture §1); nothing in this package needs one.
 */

import { type AppError, type Result, ValidationError, err, ok } from '@rv/shared-kernel';
import type { Rect, Size } from '@rv/contracts';

import type { EncodedImage, RasterPort, RgbaImage } from '../ports/raster-port';
import { PNG_MIME, decodePng, encodePng } from './png';
import { px } from './pixels';

export class PngRaster implements RasterPort {
  decode(encoded: EncodedImage): Result<RgbaImage, AppError> {
    if (encoded.mimeType !== PNG_MIME) {
      return err(
        new ValidationError({
          message: `PngRaster reads ${PNG_MIME} only`,
          context: { mimeType: encoded.mimeType },
        }),
      );
    }
    return decodePng(encoded.data);
  }

  encode(image: RgbaImage): Result<EncodedImage, AppError> {
    return encodePng(image);
  }

  /**
   * Copies a sub-rectangle, transparent-padding anything outside the source.
   *
   * Padding rather than clamping or failing: a connected component whose bounding box
   * was grown by a one-pixel bleed margin routinely runs off the canvas edge, and the
   * caller wants the part, not an error about arithmetic it did not do.
   */
  crop(image: RgbaImage, rect: Rect): Result<RgbaImage, AppError> {
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width <= 0 || height <= 0) {
      return err(
        new ValidationError({
          message: 'crop rectangle has no area',
          context: { width, height },
        }),
      );
    }

    const x0 = Math.round(rect.x);
    const y0 = Math.round(rect.y);
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y += 1) {
      const sourceY = y0 + y;
      if (sourceY < 0 || sourceY >= image.height) continue;
      for (let x = 0; x < width; x += 1) {
        const sourceX = x0 + x;
        if (sourceX < 0 || sourceX >= image.width) continue;
        const from = (sourceY * image.width + sourceX) * 4;
        out.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
      }
    }

    return ok({ width, height, data: out });
  }

  trimBounds(image: RgbaImage, alphaThreshold: number): Rect | null {
    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        if (px(image.data, (y * image.width + x) * 4 + 3) <= alphaThreshold) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /** Straight-alpha source-over. `base` is never mutated. */
  composite(base: RgbaImage, top: RgbaImage, x: number, y: number): Result<RgbaImage, AppError> {
    const data = Uint8Array.from(base.data);

    for (let ty = 0; ty < top.height; ty += 1) {
      const by = y + ty;
      if (by < 0 || by >= base.height) continue;
      for (let tx = 0; tx < top.width; tx += 1) {
        const bx = x + tx;
        if (bx < 0 || bx >= base.width) continue;

        const s = (ty * top.width + tx) * 4;
        const alpha = px(top.data, s + 3) / 255;
        if (alpha === 0) continue;

        const d = (by * base.width + bx) * 4;
        const under = px(data, d + 3) / 255;
        const outAlpha = alpha + under * (1 - alpha);
        for (let c = 0; c < 3; c += 1) {
          const src = px(top.data, s + c);
          const dst = px(data, d + c);
          data[d + c] = Math.round((src * alpha + dst * under * (1 - alpha)) / outAlpha);
        }
        data[d + 3] = Math.round(outAlpha * 255);
      }
    }

    return ok({ width: base.width, height: base.height, data });
  }

  blank(size: Size): RgbaImage {
    return {
      width: size.width,
      height: size.height,
      data: new Uint8Array(size.width * size.height * 4),
    };
  }
}
