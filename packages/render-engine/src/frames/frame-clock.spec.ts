import { describe, expect, it } from 'vitest';

import {
  clampToTimeline,
  containsFrame,
  frameCount,
  frameTimeMs,
  framesIn,
  fullRange,
  rangeLength,
} from './frame-clock';

describe('frameTimeMs', () => {
  it('is exact for whole seconds', () => {
    expect(frameTimeMs(0, 30)).toBe(0);
    expect(frameTimeMs(30, 30)).toBe(1000);
    expect(frameTimeMs(90, 30)).toBe(3000);
  });

  it('agrees with itself bit for bit however many times it is asked', () => {
    // The point of the function existing at all: two call sites computing the frame
    // time two ways is how a resumed render stops matching the one it resumed.
    for (const frame of [1, 7, 1801, 5399]) {
      expect(frameTimeMs(frame, 24)).toBe(frameTimeMs(frame, 24));
      expect(frameTimeMs(frame, 24)).toBe((frame * 1000) / 24);
    }
  });
});

describe('frameCount', () => {
  it('rounds rather than floors, so the last frame survives', () => {
    expect(frameCount(1000, 30)).toBe(30);
    expect(frameCount(3333, 30)).toBe(100);
  });

  it('never reports a timeline with no frames', () => {
    expect(frameCount(1, 1)).toBe(1);
    expect(frameCount(0, 30)).toBe(1);
  });
});

describe('ranges', () => {
  it('describes the whole timeline half-open', () => {
    expect(fullRange(4000, 25)).toEqual({ from: 0, to: 100 });
    expect(rangeLength({ from: 10, to: 40 })).toBe(30);
  });

  it('excludes the upper bound', () => {
    expect(containsFrame({ from: 10, to: 40 }, 39)).toBe(true);
    expect(containsFrame({ from: 10, to: 40 }, 40)).toBe(false);
    expect(containsFrame({ from: 10, to: 40 }, 9)).toBe(false);
  });

  it('enumerates ascending', () => {
    expect([...framesIn({ from: 3, to: 7 })]).toEqual([3, 4, 5, 6]);
  });
});

describe('clampToTimeline', () => {
  const timeline = { from: 0, to: 100 };

  it('treats null as the whole timeline', () => {
    const result = clampToTimeline(null, timeline);
    expect(result).toEqual({ ok: true, value: timeline });
  });

  it('accepts a sub-range', () => {
    const result = clampToTimeline({ from: 40, to: 60 }, timeline);
    expect(result.ok).toBe(true);
  });

  it('refuses a range that runs off the end', () => {
    // Frames past the end are extrapolated by the evaluator: visually plausible, and
    // not part of the film.
    const result = clampToTimeline({ from: 90, to: 120 }, timeline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
    expect(result.error.context).toMatchObject({ requested: { from: 90, to: 120 } });
  });

  it('refuses a range that starts before the beginning', () => {
    const result = clampToTimeline({ from: 0, to: 10 }, { from: 5, to: 100 });
    expect(result.ok).toBe(false);
  });
});
