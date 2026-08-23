import { describe, expect, it } from 'vitest';

import {
  EPSILON,
  FULL,
  clamp,
  clamp01,
  clampRect,
  containFit,
  contains,
  intersectIntervals,
  lerpRect,
  mapIntoCrop,
  mapIntoFit,
  maximalCrop,
  rectBottom,
  rectCentre,
  rectRight,
} from './geometry';

describe('rectangles', () => {
  const rect = { x: 0.2, y: 0.1, width: 0.4, height: 0.6 };

  it('finds edges and centre', () => {
    expect(rectRight(rect)).toBeCloseTo(0.6, 10);
    expect(rectBottom(rect)).toBeCloseTo(0.7, 10);
    expect(rectCentre(rect).x).toBeCloseTo(0.4, 10);
    expect(rectCentre(rect).y).toBeCloseTo(0.4, 10);
  });

  it('contains a rectangle that touches its edge', () => {
    expect(contains(FULL, { x: 0, y: 0, width: 1, height: 1 })).toBe(true);
  });

  it('rejects a rectangle that pokes out by more than epsilon', () => {
    expect(contains(FULL, { x: 0, y: 0, width: 1 + EPSILON * 100, height: 1 })).toBe(false);
  });

  it('tolerates floating-point slack', () => {
    expect(contains(FULL, { x: -EPSILON / 2, y: 0, width: 1, height: 1 })).toBe(true);
  });

  it('clamps a rectangle into the unit square without changing its size', () => {
    expect(clampRect({ x: 0.9, y: -0.2, width: 0.3, height: 0.5 })).toEqual({
      x: 0.7,
      y: 0,
      width: 0.3,
      height: 0.5,
    });
  });
});

describe('clamp', () => {
  it('bounds a value', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('lets the low bound win a crossed range', () => {
    // The low bound is derived from the composition's own edge, which is not negotiable.
    expect(clamp(0.5, 0.8, 0.2)).toBe(0.8);
  });

  it('clamps to the unit interval', () => {
    expect(clamp01(1.4)).toBe(1);
    expect(clamp01(-0.2)).toBe(0);
  });
});

describe('maximalCrop', () => {
  it('takes the full height when cropping a 4:3 canvas to 9:16', () => {
    const crop = maximalCrop({ width: 2400, height: 1800 }, { width: 1080, height: 1920 });
    expect(crop.height).toBeCloseTo(1, 10);
    expect(crop.width).toBeCloseTo(1012.5 / 2400, 10);
  });

  it('takes the full width when cropping the same canvas to 16:9', () => {
    const crop = maximalCrop({ width: 2400, height: 1800 }, { width: 1920, height: 1080 });
    expect(crop.width).toBeCloseTo(1, 10);
    expect(crop.height).toBeCloseTo(0.75, 10);
  });

  it('is the whole frame when the aspects already agree', () => {
    const crop = maximalCrop({ width: 1920, height: 1080 }, { width: 3840, height: 2160 });
    expect(crop).toEqual({ width: 1, height: 1 });
  });
});

describe('containFit', () => {
  it('letterboxes a wide canvas into a tall frame', () => {
    const fit = containFit({ width: 2400, height: 1800 }, { width: 1080, height: 1920 });
    expect(fit.width).toBeCloseTo(1, 10);
    expect(fit.height).toBeCloseTo(0.421875, 10);
    expect(fit.y).toBeCloseTo((1 - 0.421875) / 2, 10);
  });

  it('pillarboxes a tall canvas into a wide frame', () => {
    const fit = containFit({ width: 1000, height: 2000 }, { width: 1920, height: 1080 });
    expect(fit.height).toBeCloseTo(1, 10);
    expect(fit.width).toBeLessThan(1);
  });
});

describe('mapping', () => {
  it('maps a rectangle into a crop', () => {
    const mapped = mapIntoCrop(
      { x: 0.5, y: 0.5, width: 0.1, height: 0.1 },
      { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
    );
    expect(mapped.x).toBeCloseTo(0.5, 10);
    expect(mapped.y).toBeCloseTo(0.5, 10);
    expect(mapped.width).toBeCloseTo(0.5, 10);
    expect(mapped.height).toBeCloseTo(0.5, 10);
  });

  it('maps a rectangle onto a letterboxed placement', () => {
    const mapped = mapIntoFit(
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0.25, width: 1, height: 0.5 },
    );
    expect(mapped).toEqual({ x: 0, y: 0.25, width: 1, height: 0.5 });
  });
});

describe('intersectIntervals', () => {
  it('overlaps', () => {
    expect(intersectIntervals({ low: 0, high: 0.5 }, { low: 0.3, high: 1 })).toEqual({
      low: 0.3,
      high: 0.5,
    });
  });

  it('returns null when they miss', () => {
    expect(intersectIntervals({ low: 0, high: 0.2 }, { low: 0.5, high: 1 })).toBeNull();
  });

  it('accepts a degenerate touch as a single point', () => {
    expect(intersectIntervals({ low: 0, high: 0.5 }, { low: 0.5, high: 1 })).toEqual({
      low: 0.5,
      high: 0.5,
    });
  });
});

describe('lerpRect', () => {
  it('returns the endpoints exactly', () => {
    const from = { x: 0, y: 0, width: 0.4, height: 1 };
    const to = { x: 0.6, y: 0, width: 0.4, height: 1 };
    expect(lerpRect(from, to, 0)).toEqual(from);
    expect(lerpRect(from, to, 1)).toEqual(to);
  });

  it('eases rather than ramping linearly', () => {
    // A pan that starts and stops instantaneously reads as a camera jerk.
    const from = { x: 0, y: 0, width: 0.4, height: 1 };
    const to = { x: 1, y: 0, width: 0.4, height: 1 };
    expect(lerpRect(from, to, 0.1).x).toBeLessThan(0.1);
    expect(lerpRect(from, to, 0.5).x).toBeCloseTo(0.5, 10);
    expect(lerpRect(from, to, 0.9).x).toBeGreaterThan(0.9);
  });

  it('clamps progress outside 0..1', () => {
    const from = { x: 0, y: 0, width: 1, height: 1 };
    const to = { x: 0.5, y: 0, width: 1, height: 1 };
    expect(lerpRect(from, to, 2)).toEqual(to);
    expect(lerpRect(from, to, -1)).toEqual(from);
  });
});
