import { describe, expect, it } from 'vitest';
import type { Track } from '@rv/contracts';

import { buildEasingLibrary } from './easing';
import { foldTracks, valueAt } from './track';

const library = buildEasingLibrary([
  { name: 'linear', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } },
  { name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } },
]);

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 'trk_01J8ZQ4E7K9M2N4P6R8T0V2W4X',
    nodeId: 'nod_01J8ZQ4E7K9M2N4P6R8T0V2W4X',
    channel: 'rotation',
    keyframes: [
      { timeMs: 0, value: 0 },
      { timeMs: 1000, value: 10 },
    ],
    before: 'hold',
    after: 'hold',
    additive: false,
    ...overrides,
  };
}

describe('exactness at the keyframes', () => {
  it('returns the keyframe value when evaluated exactly on one', () => {
    const t = track({
      keyframes: [
        { timeMs: 0, value: 3 },
        { timeMs: 500, value: 7 },
        { timeMs: 1000, value: -2 },
      ],
    });
    expect(valueAt(t, 0, library)).toBe(3);
    expect(valueAt(t, 500, library)).toBe(7);
    expect(valueAt(t, 1000, library)).toBe(-2);
  });

  it('returns the only value for a single-keyframe track at any time', () => {
    const t = track({ keyframes: [{ timeMs: 400, value: 42 }] });
    for (const ms of [-1000, 0, 400, 99_999]) {
      expect(valueAt(t, ms, library)).toBe(42);
    }
  });
});

describe('interpolation', () => {
  it('interpolates linearly when no easing is set', () => {
    expect(valueAt(track(), 250, library)).toBe(2.5);
    expect(valueAt(track(), 750, library)).toBe(7.5);
  });

  it('applies the easing of the keyframe being *left*, not the one approached', () => {
    // An animator setting "ease out" on a pose means the motion away from that pose.
    const eased = track({
      keyframes: [
        { timeMs: 0, value: 0, easing: { kind: 'named', name: 'ease-in-out' } },
        { timeMs: 1000, value: 10 },
      ],
    });
    expect(valueAt(eased, 200, library)).toBeLessThan(2);
    expect(valueAt(eased, 800, library)).toBeGreaterThan(8);
    expect(valueAt(eased, 500, library)).toBeCloseTo(5, 4);
  });

  it('interpolates the correct segment in a multi-segment track', () => {
    const t = track({
      keyframes: [
        { timeMs: 0, value: 0 },
        { timeMs: 100, value: 100 },
        { timeMs: 200, value: 0 },
      ],
    });
    expect(valueAt(t, 50, library)).toBe(50);
    expect(valueAt(t, 150, library)).toBe(50);
  });

  it('handles a long track, which exercises the binary search', () => {
    const keyframes = Array.from({ length: 200 }, (_, i) => ({ timeMs: i * 10, value: i }));
    const t = track({ keyframes });
    expect(valueAt(t, 0, library)).toBe(0);
    expect(valueAt(t, 995, library)).toBeCloseTo(99.5, 9);
    expect(valueAt(t, 1990, library)).toBe(199);
  });
});

describe('extrapolation', () => {
  const base = track({
    keyframes: [
      { timeMs: 100, value: 0 },
      { timeMs: 300, value: 20 },
    ],
  });

  it('holds the nearest keyframe by default', () => {
    expect(valueAt(base, 0, library)).toBe(0);
    expect(valueAt(base, 9999, library)).toBe(20);
  });

  it('loops forwards', () => {
    const looping = { ...base, after: 'loop' as const };
    // 300 is the end; 400 is 100 into the next cycle, i.e. halfway.
    expect(valueAt(looping, 400, library)).toBe(10);
    // 700 is exactly three whole cycles past the start, so it lands back on the start.
    expect(valueAt(looping, 700, library)).toBe(0);
  });

  it('loops backwards, correcting for JS remainder keeping the dividend sign', () => {
    const looping = { ...base, before: 'loop' as const };
    // 0 is half a span before the start, so it wraps to the midpoint of the cycle.
    expect(valueAt(looping, 0, library)).toBe(10);
    // -100 and -300 are whole spans before the start, so both land on the start value.
    expect(valueAt(looping, -100, library)).toBe(0);
    expect(valueAt(looping, -300, library)).toBe(0);
  });

  it('ping-pongs, reversing on odd cycles', () => {
    const pinging = { ...base, after: 'ping-pong' as const };
    expect(valueAt(pinging, 300, library)).toBe(20);
    expect(valueAt(pinging, 400, library)).toBe(10); // first reverse cycle, halfway back
    expect(valueAt(pinging, 500, library)).toBeCloseTo(0, 9);
    expect(valueAt(pinging, 600, library)).toBeCloseTo(10, 9); // forwards again
  });

  it('ping-pongs backwards too', () => {
    const pinging = { ...base, before: 'ping-pong' as const };
    // The first cycle before the start runs backwards, so 0 - half a span reads as the
    // midpoint, and a whole span before the start reads as the *end* value.
    expect(valueAt(pinging, 0, library)).toBeCloseTo(10, 9);
    expect(valueAt(pinging, -100, library)).toBeCloseTo(20, 9);
  });

  it('falls back to holding when the span is zero', () => {
    const degenerate = track({
      keyframes: [
        { timeMs: 500, value: 1 },
        { timeMs: 500 + Number.EPSILON, value: 9 },
      ],
      before: 'loop',
      after: 'loop',
    });
    expect(Number.isFinite(valueAt(degenerate, 100_000, library))).toBe(true);
  });
});

describe('purity - the property everything else rests on', () => {
  it('gives the same answer however it is reached', () => {
    // Scrubbing backwards, playing forwards, and a cold seek must all agree. A cursor
    // or a cached segment inside the evaluator would break exactly this.
    const t = track({
      keyframes: [
        { timeMs: 0, value: 0, easing: { kind: 'named', name: 'ease-in-out' } },
        { timeMs: 700, value: 30 },
        { timeMs: 1400, value: -5 },
      ],
      after: 'loop',
    });

    const cold = valueAt(t, 913, library);

    for (let ms = 0; ms <= 1400; ms += 7) valueAt(t, ms, library);
    const afterForwards = valueAt(t, 913, library);

    for (let ms = 1400; ms >= 0; ms -= 7) valueAt(t, ms, library);
    const afterBackwards = valueAt(t, 913, library);

    expect(afterForwards).toBe(cold);
    expect(afterBackwards).toBe(cold);
  });
});

describe('foldTracks', () => {
  it('folds several channels into one map', () => {
    const folded = foldTracks(
      [track({ channel: 'rotation' }), track({ channel: 'opacity' })],
      500,
      library,
    );
    expect(folded.get('rotation')).toBe(5);
    expect(folded.get('opacity')).toBe(5);
  });

  it('replaces by default, so the last track on a channel wins', () => {
    const folded = foldTracks(
      [
        track({ channel: 'rotation', keyframes: [{ timeMs: 0, value: 1 }] }),
        track({ channel: 'rotation', keyframes: [{ timeMs: 0, value: 9 }] }),
      ],
      0,
      library,
    );
    expect(folded.get('rotation')).toBe(9);
  });

  it('sums an additive track onto what came before', () => {
    const folded = foldTracks(
      [
        track({ channel: 'rotation', keyframes: [{ timeMs: 0, value: 1 }] }),
        track({ channel: 'rotation', keyframes: [{ timeMs: 0, value: 9 }], additive: true }),
      ],
      0,
      library,
    );
    expect(folded.get('rotation')).toBe(10);
  });

  it('folds into a caller-supplied map', () => {
    const seed = new Map<string, number>([['rotation', 100]]);
    const folded = foldTracks(
      [track({ channel: 'rotation', keyframes: [{ timeMs: 0, value: 5 }], additive: true })],
      0,
      library,
      seed,
    );
    expect(folded).toBe(seed);
    expect(folded.get('rotation')).toBe(105);
  });

  it('treats an additive track on an untouched channel as starting from zero', () => {
    const folded = foldTracks(
      [track({ channel: 'opacity', keyframes: [{ timeMs: 0, value: 7 }], additive: true })],
      0,
      library,
    );
    expect(folded.get('opacity')).toBe(7);
  });

  it('returns an empty map for no tracks', () => {
    expect(foldTracks([], 0, library).size).toBe(0);
  });
});
