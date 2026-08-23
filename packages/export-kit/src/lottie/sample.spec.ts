/**
 * The sampler is tested **against hand-written Lottie**, on purpose.
 *
 * `sampleLottieProperty` is what the exporter measures its own fidelity with, so if it
 * were only ever tested against the exporter's output the two could be wrong together.
 * These cases are keyframes written by hand from the format's documented semantics, with
 * values computed independently, so the sampler is pinned before anything relies on it.
 */

import { describe, expect, it } from 'vitest';
import { cubicBezierAt } from '@rv/anim-engine';

import {
  animatedProperty,
  authoredProperty,
  bakedProperty,
  keyframeCount,
  roundTo,
  sampleLottieProperty,
  simplifySamples,
  staticProperty,
} from './sample';

describe('roundTo', () => {
  it('rounds to the requested decimals', () => {
    expect(roundTo(1.23456789, 3)).toBe(1.235);
  });

  it('normalises negative zero, which would otherwise differ byte-for-byte', () => {
    expect(Object.is(roundTo(-0.0000001, 3), 0)).toBe(true);
  });
});

describe('sampleLottieProperty', () => {
  it('returns a static scalar as a one-element vector', () => {
    expect(sampleLottieProperty(staticProperty(42), 10)).toEqual([42]);
    expect(sampleLottieProperty(staticProperty([1, 2]), 10)).toEqual([1, 2]);
  });

  it('holds the first and last values outside the keyframe span', () => {
    const property = animatedProperty([
      { t: 10, s: [0] },
      { t: 20, s: [100] },
    ]);
    expect(sampleLottieProperty(property, 0)).toEqual([0]);
    expect(sampleLottieProperty(property, 40)).toEqual([100]);
  });

  it('interpolates linearly when a segment carries no handles', () => {
    const property = animatedProperty([
      { t: 0, s: [0, 10] },
      { t: 10, s: [100, 20] },
    ]);
    expect(sampleLottieProperty(property, 5)).toEqual([50, 15]);
  });

  it('eases through the out/in handles of the keyframe that starts the segment', () => {
    const property = animatedProperty([
      { t: 0, s: [0], o: { x: [0.42], y: [0] }, i: { x: [0.58], y: [1] } },
      { t: 10, s: [100] },
    ]);
    const expected = cubicBezierAt(0.3, 0.42, 0, 0.58, 1) * 100;
    expect(sampleLottieProperty(property, 3)[0]).toBeCloseTo(expected, 10);
  });

  it('applies per-dimension handles when they are supplied', () => {
    const property = animatedProperty([
      { t: 0, s: [0, 0], o: { x: [0.42, 0], y: [0, 0] }, i: { x: [0.58, 1], y: [1, 1] } },
      { t: 10, s: [100, 100] },
    ]);
    const sampled = sampleLottieProperty(property, 3);
    expect(sampled[0]).toBeCloseTo(cubicBezierAt(0.3, 0.42, 0, 0.58, 1) * 100, 10);
    expect(sampled[1]).toBeCloseTo(30, 10);
  });

  it('applies a single handle to every dimension when only one is supplied', () => {
    const property = animatedProperty([
      { t: 0, s: [0, 0], o: { x: [0.42], y: [0] }, i: { x: [0.58], y: [1] } },
      { t: 10, s: [100, 200] },
    ]);
    const sampled = sampleLottieProperty(property, 3);
    const eased = cubicBezierAt(0.3, 0.42, 0, 0.58, 1);
    expect(sampled[0]).toBeCloseTo(eased * 100, 10);
    expect(sampled[1]).toBeCloseTo(eased * 200, 10);
  });

  it('holds the start value across a segment marked h: 1', () => {
    const property = animatedProperty([
      { t: 0, s: [5], h: 1 },
      { t: 10, s: [50] },
    ]);
    expect(sampleLottieProperty(property, 9)).toEqual([5]);
    expect(sampleLottieProperty(property, 10)).toEqual([50]);
  });

  it('selects the right segment among several', () => {
    const property = animatedProperty([
      { t: 0, s: [0] },
      { t: 10, s: [10] },
      { t: 20, s: [30] },
    ]);
    expect(sampleLottieProperty(property, 15)).toEqual([20]);
    expect(sampleLottieProperty(property, 10)).toEqual([10]);
  });

  it('returns nothing for a property with no keyframes at all', () => {
    expect(sampleLottieProperty(animatedProperty([]), 3)).toEqual([]);
  });
});

describe('keyframeCount', () => {
  it('counts only animated properties', () => {
    expect(keyframeCount(staticProperty(1))).toBe(0);
    expect(
      keyframeCount(
        animatedProperty([
          { t: 0, s: [0] },
          { t: 1, s: [1] },
        ]),
      ),
    ).toBe(2);
  });
});

describe('simplifySamples', () => {
  it('keeps both ends of a two-point run untouched', () => {
    expect(simplifySamples([0, 1], [[0], [1]], 0)).toEqual([0, 1]);
  });

  it('drops points that lie on the line the reader will interpolate anyway', () => {
    const times = [0, 1, 2, 3, 4];
    const values = [[0], [10], [20], [30], [40]];
    expect(simplifySamples(times, values, 1e-9)).toEqual([0, 4]);
  });

  it('keeps a point that leaves the line by more than the tolerance', () => {
    const times = [0, 1, 2];
    const values = [[0], [10], [0]];
    expect(simplifySamples(times, values, 1e-9)).toEqual([0, 1, 2]);
  });

  it('bounds the error it introduces by the tolerance it was given', () => {
    const times = [0, 1, 2];
    const values = [[0], [1.5], [4]];
    // The midpoint sits 0.5 below the straight line, so a 0.4 budget must keep it and a
    // 0.6 budget may drop it.
    expect(simplifySamples(times, values, 0.4)).toEqual([0, 1, 2]);
    expect(simplifySamples(times, values, 0.6)).toEqual([0, 2]);
  });

  it('checks every dimension, not only the first', () => {
    const times = [0, 1, 2];
    const values = [
      [0, 0],
      [1, 9],
      [2, 2],
    ];
    expect(simplifySamples(times, values, 1e-9)).toEqual([0, 1, 2]);
  });
});

describe('bakedProperty', () => {
  const options = { tolerance: 1e-9, precision: 6 };

  it('collapses an unchanging channel to a static property', () => {
    const property = bakedProperty([0, 1, 2], [[5], [5], [5]], options);
    expect(property).toEqual({ a: 0, k: 5 });
  });

  it('collapses an unchanging vector channel without unwrapping it', () => {
    const property = bakedProperty(
      [0, 1],
      [
        [100, 100],
        [100, 100],
      ],
      options,
    );
    expect(property).toEqual({ a: 0, k: [100, 100] });
  });

  it('writes dense keyframes for a channel that moves', () => {
    const property = bakedProperty([0, 1, 2], [[0], [7], [1]], options);
    expect(property.a).toBe(1);
    expect(keyframeCount(property)).toBe(3);
  });

  it('rounds emitted values to the requested precision', () => {
    const property = bakedProperty([0, 1], [[0], [1 / 3]], { tolerance: 0, precision: 3 });
    expect(sampleLottieProperty(property, 1)).toEqual([0.333]);
  });
});

describe('authoredProperty', () => {
  const ease = { kind: 'bezier' as const, out: { x: [0.42], y: [0] }, in: { x: [0.58], y: [1] } };

  it('collapses a single authored keyframe to a static property', () => {
    expect(authoredProperty([{ frame: 0, value: [3] }], [ease], 6)).toEqual({ a: 0, k: 3 });
  });

  it('keeps a single vector keyframe as a vector rather than unwrapping it', () => {
    expect(authoredProperty([{ frame: 0, value: [3, 4] }], [ease], 6)).toEqual({ a: 0, k: [3, 4] });
  });

  it('carries the handles onto the keyframe that starts each segment', () => {
    const property = authoredProperty(
      [
        { frame: 0, value: [0] },
        { frame: 30, value: [100] },
      ],
      [ease, ease],
      6,
    );
    expect(property.a).toBe(1);
    if (property.a !== 1) return;
    expect(property.k[0]?.o).toEqual({ x: [0.42], y: [0] });
    expect(property.k[0]?.i).toEqual({ x: [0.58], y: [1] });
    // The last keyframe ends the animation; it eases nothing.
    expect(property.k[1]?.o).toBeUndefined();
  });

  it('marks a held segment rather than writing handles for it', () => {
    const property = authoredProperty(
      [
        { frame: 0, value: [0] },
        { frame: 10, value: [1] },
      ],
      [{ kind: 'hold' }, { kind: 'hold' }],
      6,
    );
    if (property.a !== 1) throw new Error('expected an animated property');
    expect(property.k[0]?.h).toBe(1);
  });
});
