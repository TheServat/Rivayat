/**
 * How different do two frames *look*?
 *
 * A sha256 answers "are these the same bytes", which is the right question for
 * determinism and the wrong one for regression: an anti-aliasing change of one grey
 * level in one pixel fails a hash and matters to nobody. RV-169 asks for a perceptual
 * comparison instead, and this is it - a downscaled greyscale signature and the mean
 * absolute difference between two of them.
 *
 * Downscaling first is what makes it perceptual rather than pedantic. Averaging into a
 * small grid discards exactly the sub-pixel noise that differs between Skia and
 * Chromium, and keeps the structure that differs when a layer is missing or a character
 * is in the wrong place.
 *
 * The arithmetic runs on raw RGBA and needs nothing installed. `sharp` enters only when
 * the input is an *encoded* image (the browser backend returns PNG-shaped payloads in
 * some configurations), and it arrives injected, for the same reason as the Playwright
 * launcher: `.dependency-cruiser.cjs` forbids the import from an engine package.
 */

import {
  ValidationError,
  err,
  ok,
  toAppError,
  type AppError,
  type Result,
} from '@rv/shared-kernel';

import type { SharpLike } from '../ports/browser';
import type { FrameBuffer } from '../ports/frame-renderer';

/** The default grid. 16x16 is 256 samples - enough for structure, blind to noise. */
export const SIGNATURE_SIZE = 16;

export interface PerceptualSignature {
  readonly size: number;
  /** Row-major luminance, 0-255. */
  readonly values: Float64Array;
}

/**
 * Box-filtered greyscale, at `size x size`.
 *
 * Rec. 709 luma coefficients rather than a flat mean: the eye is roughly seven times
 * more sensitive to green than to blue, and a flat mean rates a blue shift as a bigger
 * change than a green one.
 */
export function perceptualSignature(
  frame: FrameBuffer,
  size = SIGNATURE_SIZE,
): PerceptualSignature {
  const values = new Float64Array(size * size);
  const counts = new Float64Array(size * size);

  for (let y = 0; y < frame.height; y += 1) {
    const cellY = Math.min(size - 1, Math.floor((y / frame.height) * size));
    for (let x = 0; x < frame.width; x += 1) {
      const cellX = Math.min(size - 1, Math.floor((x / frame.width) * size));
      const offset = (y * frame.width + x) * 4;
      const alpha = (frame.data[offset + 3] ?? 0) / 255;
      // Alpha-weighted: a transparent pixel's colour is meaningless, and treating it as
      // black would make two identical cut-outs on different backgrounds look different.
      const luma =
        0.2126 * (frame.data[offset] ?? 0) +
        0.7152 * (frame.data[offset + 1] ?? 0) +
        0.0722 * (frame.data[offset + 2] ?? 0);
      const index = cellY * size + cellX;
      values[index] = (values[index] ?? 0) + luma * alpha;
      counts[index] = (counts[index] ?? 0) + 1;
    }
  }

  for (let index = 0; index < values.length; index += 1) {
    const count = counts[index] ?? 0;
    if (count > 0) values[index] = (values[index] ?? 0) / count;
  }

  return { size, values };
}

/**
 * Mean absolute difference, normalised to 0..1.
 *
 * 0 is identical. Roughly 0.01 is invisible; above 0.05 something moved.
 */
export function perceptualDistance(
  left: PerceptualSignature,
  right: PerceptualSignature,
): Result<number, AppError> {
  if (left.size !== right.size) {
    return err(
      new ValidationError({
        message: `signatures are ${String(left.size)} and ${String(right.size)} wide; they cannot be compared`,
      }),
    );
  }
  let total = 0;
  for (let index = 0; index < left.values.length; index += 1) {
    total += Math.abs((left.values[index] ?? 0) - (right.values[index] ?? 0));
  }
  return ok(total / left.values.length / 255);
}

/** Convenience: signature both frames and compare. */
export function compareFrames(
  left: FrameBuffer,
  right: FrameBuffer,
  size = SIGNATURE_SIZE,
): Result<number, AppError> {
  return perceptualDistance(perceptualSignature(left, size), perceptualSignature(right, size));
}

/**
 * Decodes an encoded image to RGBA through an injected `sharp`.
 *
 * The only reason this package knows `sharp` exists. Everything above it works on
 * `FrameBuffer`, so a caller with raw frames never loads it at all.
 */
export async function decodeWithSharp(
  sharp: SharpLike,
  encoded: Uint8Array,
  width: number,
  height: number,
): Promise<Result<FrameBuffer, AppError>> {
  try {
    const data = await sharp(encoded).resize(width, height).raw().toBuffer();
    if (data.length !== width * height * 4 && data.length !== width * height * 3) {
      return err(
        new ValidationError({
          message: `decoded ${String(data.length)} bytes for a ${String(width)}x${String(height)} image`,
        }),
      );
    }
    // Three-channel output means the source had no alpha; widen it rather than reject a
    // perfectly good opaque JPEG.
    if (data.length === width * height * 3) {
      const rgba = new Uint8Array(width * height * 4);
      for (let pixel = 0; pixel < width * height; pixel += 1) {
        rgba[pixel * 4] = data[pixel * 3] ?? 0;
        rgba[pixel * 4 + 1] = data[pixel * 3 + 1] ?? 0;
        rgba[pixel * 4 + 2] = data[pixel * 3 + 2] ?? 0;
        rgba[pixel * 4 + 3] = 255;
      }
      return ok({ width, height, data: rgba });
    }
    return ok({ width, height, data: Uint8Array.from(data) });
  } catch (caught: unknown) {
    return err(toAppError(caught, 'sharp could not decode the image'));
  }
}
