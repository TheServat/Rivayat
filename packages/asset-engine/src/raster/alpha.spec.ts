import { describe, expect, it } from 'vitest';

import { paintCutout, solid } from '../__fixtures__/images';
import { alphaCleanliness, alphaCoverage, cornersAreTransparent } from './alpha';

describe('alpha metrics', () => {
  it('reports coverage as the fraction of non-transparent pixels', async () => {
    const image = await paintCutout(10, 10, [{ x: 0, y: 0, width: 5, height: 10 }]);
    expect(alphaCoverage(image)).toBeCloseTo(0.5, 5);
  });

  it('reports zero coverage for an empty buffer', () => {
    expect(alphaCoverage({ width: 0, height: 0, data: new Uint8Array(0) })).toBe(0);
  });

  it('scores a hard-edged cutout as perfectly clean', async () => {
    const image = await paintCutout(16, 16, [{ x: 4, y: 4, width: 8, height: 8 }]);
    expect(alphaCleanliness(image)).toBe(1);
  });

  it('penalises semi-transparency far from the silhouette', async () => {
    const image = await paintCutout(24, 24, [{ x: 8, y: 8, width: 8, height: 8 }]);
    // A veil in the empty field: not antialiasing, so it must cost.
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        image.data[(y * 24 + x) * 4 + 3] = 40;
      }
    }
    expect(alphaCleanliness(image)).toBeLessThan(1);
  });

  it('forgives semi-transparency inside the edge band', async () => {
    const image = await paintCutout(24, 24, [{ x: 8, y: 8, width: 8, height: 8 }]);
    // One pixel just inside the silhouette boundary - ordinary antialiasing.
    image.data[(8 * 24 + 8) * 4 + 3] = 128;
    expect(alphaCleanliness(image)).toBe(1);
  });

  it('reads corner transparency, the cheapest matting sanity check', async () => {
    const cut = await paintCutout(8, 8, [{ x: 2, y: 2, width: 4, height: 4 }]);
    expect(cornersAreTransparent(cut)).toBe(true);
    expect(cornersAreTransparent(solid(8, 8, { r: 0, g: 0, b: 0, a: 255 }))).toBe(false);
  });
});
