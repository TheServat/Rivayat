/**
 * Pixels, as the application layer is allowed to see them.
 *
 * Architecture §1 puts `sharp` in the **infrastructure** row, and
 * `.dependency-cruiser.cjs` turns that into a build failure: an engine package that
 * imports `sharp` fails `pnpm arch:check`. So the engine states what it needs done to
 * a bitmap and someone else does it.
 *
 * The port is deliberately shaped around **raw RGBA planes**, not around file formats.
 * Everything the engine actually computes - alpha coverage, connected components, part
 * bounds, atlas composition - is arithmetic over four bytes per pixel, and a port that
 * spoke in encoded blobs would force a decode inside every one of those loops.
 */

import type { AppError, Result } from '@rv/shared-kernel';
import type { Rect, Size } from '@rv/contracts';

/**
 * A decoded bitmap: 8-bit RGBA, row-major, **non-premultiplied**.
 *
 * Non-premultiplied because every alpha metric in this package divides by 255 and
 * compares against a coverage threshold; premultiplied colour would make a fully
 * transparent red pixel indistinguishable from a fully transparent black one, and the
 * matting engines disagree about which they emit.
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

export interface RasterPort {
  /** Decodes an encoded image into RGBA. Missing alpha becomes 255. */
  decode(encoded: EncodedImage): Result<RgbaImage, AppError>;
  /** Encodes RGBA to PNG. Must be byte-deterministic for identical input. */
  encode(image: RgbaImage): Result<EncodedImage, AppError>;
  /** Copies a sub-rectangle. Areas outside the source are transparent, not an error. */
  crop(image: RgbaImage, rect: Rect): Result<RgbaImage, AppError>;
  /** Tightest rectangle containing every pixel with `alpha > threshold`. */
  trimBounds(image: RgbaImage, alphaThreshold: number): Rect | null;
  /** Source-over composite of `top` onto a copy of `base` at `(x, y)`. */
  composite(base: RgbaImage, top: RgbaImage, x: number, y: number): Result<RgbaImage, AppError>;
  /** An all-transparent canvas. The starting point for every atlas page. */
  blank(size: Size): RgbaImage;
}
