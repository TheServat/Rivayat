/**
 * Synthetic PNGs, built with `sharp` at test time.
 *
 * Two reasons they are made rather than committed. A fixture file is a binary blob
 * nobody can review, and a segmentation test whose input is opaque is a test whose
 * failure is unreadable - "three blobs at these coordinates, this size" is the whole
 * point of the assertion and it should be visible in the source. And building them with
 * a *real* encoder means the decoder in `raster/png.ts` is exercised against libvips
 * output rather than against its own encoder, which is the only way a codec test is
 * worth anything.
 *
 * `sharp` lives here and only here. Architecture §1 puts it in the infrastructure row
 * and `.dependency-cruiser.cjs` fails an engine package that imports it; `__fixtures__`
 * is excluded from the cruise, which is exactly the right boundary - test scaffolding
 * may reach for a native library, shipped engine code may not.
 */

import sharp from 'sharp';

import type { EncodedImage, RgbaImage } from '../ports/raster-port';

export interface Blob {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color?: { readonly r: number; readonly g: number; readonly b: number };
}

export const NEUTRAL_FIELD = { r: 200, g: 200, b: 200 };

/**
 * An opaque canvas of `background` with `blobs` painted on it - a parts sheet, near
 * enough. Returned as encoded PNG bytes, the way an image provider would hand it over.
 */
export async function paintSheet(
  width: number,
  height: number,
  blobs: readonly Blob[],
  background: { r: number; g: number; b: number } = NEUTRAL_FIELD,
): Promise<EncodedImage> {
  const canvas = sharp({
    create: { width, height, channels: 4, background: { ...background, alpha: 1 } },
  });

  const overlays = await Promise.all(
    blobs.map(async (blob) => ({
      input: await sharp({
        create: {
          width: blob.width,
          height: blob.height,
          channels: 4,
          background: { ...(blob.color ?? { r: 20, g: 90, b: 40 }), alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
      left: blob.x,
      top: blob.y,
    })),
  );

  const data = await canvas.composite(overlays).png().toBuffer();
  return { mimeType: 'image/png', data: new Uint8Array(data) };
}

/**
 * A sheet whose field is *graded*, which is the case a key cannot cut.
 *
 * Not a hypothetical, and not an approximation either - these are the numbers measured
 * off the take that failed: SD 1.5 drew `prop/lamp-cart/laden` on a studio backdrop
 * whose top corners read `(128,110,91)` and whose bottom corners read `(249,244,239)`.
 *
 * The mechanism that defeats the key is worth stating exactly, because it is not the
 * one the tolerances were designed against. `sampleBackground` takes the **median of
 * the four corners**, and with the corners 120 levels apart the median is
 * `(189,177,163)` - a colour that occurs nowhere in the picture. All four corners then
 * sit ~13000 squared units from it, past tier 1's soft tolerance of 6348, so no border
 * pixel ever enters the flood-fill queue and the matte removes nothing. Tier 2's wider
 * 15552 does admit them, but only at partial alpha (~212), so the corners are still not
 * transparent. Widening further starts eating the subject instead.
 */
export async function paintGradedSheet(
  width: number,
  height: number,
  blobs: readonly Blob[],
  ramp: { readonly top: number; readonly bottom: number } = { top: 128, bottom: 249 },
): Promise<EncodedImage> {
  const data = new Uint8Array(width * height * 4);
  const span = Math.max(1, height - 1);

  for (let y = 0; y < height; y += 1) {
    const level = Math.round(ramp.top + ((ramp.bottom - ramp.top) * y) / span);
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = level;
      data[at + 1] = level;
      data[at + 2] = level;
      data[at + 3] = 255;
    }
  }

  for (const blob of blobs) {
    const colour = blob.color ?? { r: 20, g: 90, b: 40 };
    for (let y = blob.y; y < Math.min(height, blob.y + blob.height); y += 1) {
      for (let x = blob.x; x < Math.min(width, blob.x + blob.width); x += 1) {
        const at = (y * width + x) * 4;
        data[at] = colour.r;
        data[at + 1] = colour.g;
        data[at + 2] = colour.b;
      }
    }
  }

  const encoded = await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  return { mimeType: 'image/png', data: new Uint8Array(encoded) };
}

/** The same, already matted: transparent field, opaque blobs. */
export async function paintCutout(
  width: number,
  height: number,
  blobs: readonly Blob[],
): Promise<RgbaImage> {
  const overlays = await Promise.all(
    blobs.map(async (blob) => ({
      input: await sharp({
        create: {
          width: blob.width,
          height: blob.height,
          channels: 4,
          background: { ...(blob.color ?? { r: 20, g: 90, b: 40 }), alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
      left: blob.x,
      top: blob.y,
    })),
  );

  const { data, info } = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(overlays)
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** Encodes RGBA through `sharp`, for decoding back with our own codec. */
export async function encodeWithSharp(
  image: RgbaImage,
  options: { readonly channels?: 1 | 3 | 4; readonly palette?: boolean } = {},
): Promise<EncodedImage> {
  let pipeline = sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  });
  if (options.channels === 3) pipeline = pipeline.removeAlpha();
  if (options.channels === 1) pipeline = pipeline.removeAlpha().grayscale().toColourspace('b-w');
  const data = await pipeline.png({ palette: options.palette ?? false }).toBuffer();
  return { mimeType: 'image/png', data: new Uint8Array(data) };
}

/** A flat RGBA rectangle, for the smallest possible round-trip. */
export function solid(
  width: number,
  height: number,
  colour: { r: number; g: number; b: number; a: number },
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = colour.r;
    data[i * 4 + 1] = colour.g;
    data[i * 4 + 2] = colour.b;
    data[i * 4 + 3] = colour.a;
  }
  return { width, height, data };
}
