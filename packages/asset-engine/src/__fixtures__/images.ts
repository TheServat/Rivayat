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
