import { describe, expect, it } from 'vitest';
import { isErr, isOk, unwrap } from '@rv/shared-kernel';

import { blankImage, compositeImage, cropImage, trimBounds } from './pixels';
import { OPAQUE_GREEN, pixelAt, solid, withMargin } from './__fixtures__/images';

describe('blankImage', () => {
  it('is fully transparent', () => {
    const image = blankImage({ width: 4, height: 3 });
    expect(image.data).toHaveLength(4 * 3 * 4);
    expect([...image.data].every((byte) => byte === 0)).toBe(true);
  });
});

describe('trimBounds', () => {
  it('finds the tightest box around non-transparent pixels', () => {
    const image = withMargin({ width: 16, height: 12 }, { x: 3, y: 2, width: 6, height: 4 });
    expect(trimBounds(image)).toEqual({ x: 3, y: 2, width: 6, height: 4 });
  });

  it('returns null for a wholly transparent image, which is a legitimate frame', () => {
    expect(trimBounds(blankImage({ width: 5, height: 5 }))).toBeNull();
  });

  it('honours the alpha threshold, so a faint halo does not defeat the trim', () => {
    const faint = withMargin(
      { width: 8, height: 8 },
      { x: 1, y: 1, width: 6, height: 6 },
      { r: 0, g: 0, b: 0, a: 4 },
    );
    const strong = compositeImage(faint, solid(2, 2, OPAQUE_GREEN), 3, 3);
    expect(trimBounds(strong, 0)).toEqual({ x: 1, y: 1, width: 6, height: 6 });
    expect(trimBounds(strong, 8)).toEqual({ x: 3, y: 3, width: 2, height: 2 });
  });
});

describe('cropImage', () => {
  it('copies the sub-rectangle', () => {
    const image = withMargin({ width: 10, height: 10 }, { x: 2, y: 2, width: 3, height: 3 });
    const cropped = unwrap(cropImage(image, { x: 2, y: 2, width: 3, height: 3 }));
    expect(cropped.width).toBe(3);
    expect(pixelAt(cropped, 0, 0)).toEqual(OPAQUE_GREEN);
    expect(pixelAt(cropped, 2, 2)).toEqual(OPAQUE_GREEN);
  });

  it('transparent-pads a rectangle that runs off the source', () => {
    const image = solid(4, 4);
    const cropped = unwrap(cropImage(image, { x: -2, y: -2, width: 4, height: 4 }));
    expect(pixelAt(cropped, 0, 0).a).toBe(0);
    expect(pixelAt(cropped, 3, 3)).toEqual(OPAQUE_GREEN);
  });

  it('rejects a rectangle with no area rather than returning an empty buffer', () => {
    const result = cropImage(solid(4, 4), { x: 0, y: 0, width: 0, height: 3 });
    expect(isErr(result)).toBe(true);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('validation');
  });
});

describe('compositeImage', () => {
  it('does not mutate the base', () => {
    const base = blankImage({ width: 4, height: 4 });
    const before = Uint8Array.from(base.data);
    compositeImage(base, solid(2, 2), 1, 1);
    expect(base.data).toEqual(before);
  });

  it('places the top image at the offset and clips what falls outside', () => {
    const composed = compositeImage(blankImage({ width: 4, height: 4 }), solid(3, 3), 2, 2);
    expect(pixelAt(composed, 2, 2)).toEqual(OPAQUE_GREEN);
    expect(pixelAt(composed, 3, 3)).toEqual(OPAQUE_GREEN);
    expect(pixelAt(composed, 1, 1).a).toBe(0);
  });

  it('blends straight alpha rather than replacing', () => {
    const base = solid(2, 2, { r: 0, g: 0, b: 0, a: 255 });
    const composed = compositeImage(base, solid(2, 2, { r: 255, g: 255, b: 255, a: 128 }), 0, 0);
    const pixel = pixelAt(composed, 0, 0);
    expect(pixel.a).toBe(255);
    expect(pixel.r).toBeGreaterThan(120);
    expect(pixel.r).toBeLessThan(135);
  });

  it('leaves the base untouched where the top is fully transparent', () => {
    const base = solid(2, 2);
    const composed = compositeImage(base, blankImage({ width: 2, height: 2 }), 0, 0);
    expect(pixelAt(composed, 0, 0)).toEqual(OPAQUE_GREEN);
  });
});
