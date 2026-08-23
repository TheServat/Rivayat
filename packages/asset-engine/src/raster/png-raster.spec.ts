import { describe, expect, it } from 'vitest';
import { isErr, unwrap } from '@rv/shared-kernel';

import { paintCutout, solid } from '../__fixtures__/images';
import { PngRaster } from './png-raster';

const raster = new PngRaster();

describe('PngRaster', () => {
  it('refuses a media type it does not read, rather than guessing', () => {
    const failed = raster.decode({ mimeType: 'image/webp', data: new Uint8Array(4) });
    expect(isErr(failed)).toBe(true);
  });

  it('decodes what it encoded', () => {
    const source = solid(4, 4, { r: 9, g: 8, b: 7, a: 255 });
    const round = unwrap(raster.decode(unwrap(raster.encode(source))));
    expect([...round.data]).toEqual([...source.data]);
  });

  it('finds the tight alpha bounds and returns null for an empty canvas', async () => {
    const image = await paintCutout(20, 20, [{ x: 5, y: 6, width: 4, height: 3 }]);
    expect(raster.trimBounds(image, 0)).toEqual({ x: 5, y: 6, width: 4, height: 3 });
    expect(raster.trimBounds(raster.blank({ width: 8, height: 8 }), 0)).toBeNull();
  });

  it('pads a crop that runs off the canvas instead of failing', async () => {
    const image = await paintCutout(10, 10, [{ x: 0, y: 0, width: 4, height: 4 }]);
    const cropped = unwrap(raster.crop(image, { x: -2, y: -2, width: 6, height: 6 }));

    expect(cropped.width).toBe(6);
    // Top-left is outside the source and therefore transparent, not clamped.
    expect(cropped.data[3]).toBe(0);
    // (2,2) in the crop is (0,0) in the source, which is opaque.
    expect(cropped.data[(2 * 6 + 2) * 4 + 3]).toBe(255);
  });

  it('rejects a crop with no area', () => {
    expect(
      isErr(
        raster.crop(solid(4, 4, { r: 0, g: 0, b: 0, a: 255 }), { x: 0, y: 0, width: 0, height: 4 }),
      ),
    ).toBe(true);
  });

  it('composites source-over without mutating the base', () => {
    const base = solid(4, 4, { r: 0, g: 0, b: 0, a: 255 });
    const top = solid(2, 2, { r: 255, g: 255, b: 255, a: 255 });
    const result = unwrap(raster.composite(base, top, 1, 1));

    expect(result.data[(1 * 4 + 1) * 4]).toBe(255);
    expect(base.data[(1 * 4 + 1) * 4]).toBe(0);
  });

  it('skips fully transparent source pixels and out-of-bounds placement', () => {
    const base = solid(4, 4, { r: 10, g: 10, b: 10, a: 255 });
    const clear = solid(2, 2, { r: 255, g: 0, b: 0, a: 0 });
    expect([...unwrap(raster.composite(base, clear, 0, 0)).data]).toEqual([...base.data]);

    const opaque = solid(2, 2, { r: 255, g: 0, b: 0, a: 255 });
    expect([...unwrap(raster.composite(base, opaque, 10, 10)).data]).toEqual([...base.data]);
    expect([...unwrap(raster.composite(base, opaque, -5, -5)).data]).toEqual([...base.data]);
  });

  it('blends a partially transparent overlay', () => {
    const base = solid(2, 2, { r: 0, g: 0, b: 0, a: 255 });
    const half = solid(2, 2, { r: 255, g: 255, b: 255, a: 128 });
    const result = unwrap(raster.composite(base, half, 0, 0));
    expect(result.data[0]).toBeGreaterThan(100);
    expect(result.data[0]).toBeLessThan(160);
    expect(result.data[3]).toBe(255);
  });

  it('makes a fully transparent canvas', () => {
    const blank = raster.blank({ width: 3, height: 2 });
    expect(blank.data.length).toBe(3 * 2 * 4);
    expect([...blank.data].every((byte) => byte === 0)).toBe(true);
  });
});
