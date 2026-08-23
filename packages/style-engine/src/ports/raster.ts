/**
 * Reading actual pixels.
 *
 * Two jobs in this package need measurement rather than description: deriving a palette
 * from reference images, and scoring how well a generated image sticks to the locked
 * palette. Both are cheap, exact and deterministic if you can see the pixels - and both
 * become a language model's opinion if you cannot.
 *
 * Decoding a PNG needs a codec, and a codec is infrastructure. So the interface is
 * declared here, in the layer that uses it (architecture §1, dependency inversion), and
 * an adapter over `sharp` implements it in `@rv/providers`. Nothing in this package
 * imports an image library, and `pnpm arch:check` keeps it that way.
 *
 * Both consumers treat the port as **optional-but-preferred** where a fallback exists:
 * derivation still works from a described palette when no decoder is wired up, and says
 * so in its result. Scoring does not - a "palette adherence" number that came from a
 * model guessing is worse than no number at all.
 */

import type { ImagePayload } from '@rv/providers';
import type { AppError, Result } from '@rv/shared-kernel';

/**
 * Decoded pixels, straight RGBA, row-major, 8 bits per channel.
 *
 * Not premultiplied: the palette measurement skips transparent pixels entirely, and a
 * premultiplied buffer has already blended them toward black, which drags every
 * measured colour toward the shadow end of the palette.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, R,G,B,A per pixel. */
  readonly data: Uint8Array;
}

export interface RasterPort {
  decode(image: ImagePayload): Promise<Result<RgbaImage, AppError>>;
}
