/**
 * Pixels, and the one thing an exporter cannot do for itself.
 *
 * Two of the four formats carry imagery, so this package has to touch bitmaps. Almost
 * all of that work - compositing a frame into an atlas page, finding the transparent
 * margin to trim, copying a sub-rectangle - is arithmetic over four bytes per pixel,
 * and arithmetic belongs in the application layer where it can be tested without a
 * native library. What genuinely needs one is turning an RGBA plane into a `.png`, so
 * that, and only that, is a port.
 *
 * Architecture §1 puts `sharp` in the infrastructure row. The tests wire a `sharp`
 * adapter from `__fixtures__` (excluded from the dependency cruise); shipped code sees
 * nothing but {@link ImageEncoderPort}.
 */

import { type AppError, type Result, ValidationError, err, ok } from '@rv/shared-kernel';
import type { Rect, Size } from '@rv/contracts';

/**
 * A decoded bitmap: 8-bit RGBA, row-major, **non-premultiplied**.
 *
 * Non-premultiplied because trimming compares raw alpha against a threshold, and a
 * premultiplied plane makes a fully transparent red pixel indistinguishable from a
 * fully transparent black one - which is exactly the pixel a trim decision turns on.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes. */
  readonly data: Uint8Array;
}

/** An encoded image plus the media type it is encoded in. */
export interface EncodedImage {
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/**
 * The single outward capability the pixel-bearing exporters need.
 *
 * Deliberately one method. An atlas is only reproducible byte-for-byte if the encoder
 * is, so the contract is stricter than "produce a PNG": the same plane must encode to
 * the same bytes every time, on every machine. An adapter that lets a library pick a
 * filter or a compression level adaptively silently breaks
 * {@link ../atlas/atlas-exporter | atlas determinism}.
 */
export interface ImageEncoderPort {
  /** The media type `encode` produces, e.g. `image/png`. */
  readonly mediaType: string;
  encode(image: RgbaImage): Promise<Result<EncodedImage, AppError>>;
}

/** An all-transparent canvas. The starting point for every atlas page. */
export function blankImage(size: Size): RgbaImage {
  return {
    width: size.width,
    height: size.height,
    data: new Uint8Array(size.width * size.height * 4),
  };
}

/**
 * The tightest rectangle containing every pixel with `alpha > threshold`.
 *
 * `null` for a wholly transparent image. That is a legitimate input - a fade ends on
 * one - and the caller has to decide what a frame with no content should occupy,
 * because dropping it silently would shift every frame index after it.
 */
export function trimBounds(image: RgbaImage, alphaThreshold = 0): Rect | null {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) <= alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Copies a sub-rectangle, transparent-padding anything outside the source.
 *
 * Padding rather than failing: a caller that grew a trim box by a bleed margin wants
 * the pixels, not an error about arithmetic it did not do.
 */
export function cropImage(image: RgbaImage, rect: Rect): Result<RgbaImage, AppError> {
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

/**
 * Straight-alpha source-over of `top` onto a copy of `base` at `(x, y)`.
 *
 * `base` is never mutated: an atlas page is built by folding many of these, and a
 * mutating composite would make the result depend on how the caller shared the buffer.
 */
export function compositeImage(base: RgbaImage, top: RgbaImage, x: number, y: number): RgbaImage {
  const data = Uint8Array.from(base.data);

  for (let ty = 0; ty < top.height; ty += 1) {
    const by = y + ty;
    if (by < 0 || by >= base.height) continue;
    for (let tx = 0; tx < top.width; tx += 1) {
      const bx = x + tx;
      if (bx < 0 || bx >= base.width) continue;

      const s = (ty * top.width + tx) * 4;
      const alpha = (top.data[s + 3] ?? 0) / 255;
      if (alpha === 0) continue;

      const d = (by * base.width + bx) * 4;
      const under = (data[d + 3] ?? 0) / 255;
      const outAlpha = alpha + under * (1 - alpha);
      for (let c = 0; c < 3; c += 1) {
        const src = top.data[s + c] ?? 0;
        const dst = data[d + c] ?? 0;
        data[d + c] = Math.round((src * alpha + dst * under * (1 - alpha)) / outAlpha);
      }
      data[d + 3] = Math.round(outAlpha * 255);
    }
  }

  return { width: base.width, height: base.height, data };
}
