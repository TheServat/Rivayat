/**
 * Synthetic bitmaps and a real PNG encoder.
 *
 * `sharp` lives here and only here. Architecture §1 puts it in the infrastructure row and
 * `__fixtures__` is excluded from the dependency cruise, which is the right boundary: test
 * scaffolding may reach for a native library, shipped code may not. Using a *real* encoder
 * also means the determinism test is measuring a determinism property of the whole
 * pipeline rather than of a toy encoder written to be deterministic.
 *
 * The bitmaps are built rather than committed. A binary fixture is a blob nobody can
 * review, and "a 6×4 opaque square at (3,2) inside a 16×12 transparent canvas" is the
 * whole content of a trim assertion - it belongs in the source, where a failure is
 * readable.
 */

import { type AppError, type Result, ok } from '@rv/shared-kernel';
import sharp from 'sharp';

import type { EncodedImage, ImageEncoderPort, RgbaImage } from '../pixels';

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export const OPAQUE_GREEN: Rgba = { r: 20, g: 90, b: 40, a: 255 };

/** A transparent canvas with one opaque rectangle painted on it. */
export function withMargin(
  canvas: { readonly width: number; readonly height: number },
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  colour: Rgba = OPAQUE_GREEN,
): RgbaImage {
  const data = new Uint8Array(canvas.width * canvas.height * 4);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
      const offset = (y * canvas.width + x) * 4;
      data[offset] = colour.r;
      data[offset + 1] = colour.g;
      data[offset + 2] = colour.b;
      data[offset + 3] = colour.a;
    }
  }
  return { width: canvas.width, height: canvas.height, data };
}

/** A flat rectangle with no transparent margin at all. */
export function solid(width: number, height: number, colour: Rgba = OPAQUE_GREEN): RgbaImage {
  return withMargin({ width, height }, { x: 0, y: 0, width, height }, colour);
}

/** Reads one pixel, so a test can assert where something landed. */
export function pixelAt(image: RgbaImage, x: number, y: number): Rgba {
  const offset = (y * image.width + x) * 4;
  return {
    r: image.data[offset] ?? 0,
    g: image.data[offset + 1] ?? 0,
    b: image.data[offset + 2] ?? 0,
    a: image.data[offset + 3] ?? 0,
  };
}

/**
 * The `ImageEncoderPort` the tests wire up.
 *
 * Compression and filter are pinned rather than left adaptive: `sharp` is deterministic
 * for identical input and options, and the atlas determinism test depends on that being
 * true rather than merely likely.
 */
export class SharpPngEncoder implements ImageEncoderPort {
  readonly mediaType = 'image/png';

  async encode(image: RgbaImage): Promise<Result<EncodedImage, AppError>> {
    const data = await sharp(Buffer.from(image.data), {
      raw: { width: image.width, height: image.height, channels: 4 },
    })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    return ok({ mimeType: this.mediaType, data: new Uint8Array(data) });
  }
}

/** Decodes PNG bytes back to RGBA, so a test can look at what was actually written. */
export async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
  const { data, info } = await sharp(Buffer.from(bytes))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}
