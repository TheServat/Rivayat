import { describe, expect, it } from 'vitest';

import {
  ALWAYS,
  DAWN,
  HORIZON,
  closeAt,
  coalesce,
  compareStoryTime,
  contains,
  earliest,
  encloses,
  interval,
  intersect,
  isAtOrBefore,
  isBefore,
  isWellFormed,
  latest,
  overlaps,
  span,
  storyTime,
} from './story-time';

const a = storyTime(10);
const b = storyTime(20);
const c = storyTime(30);

describe('points', () => {
  it('builds with and without a label, and the label is not part of the value', () => {
    expect(storyTime(5)).toEqual({ ordinal: 5 });
    expect(storyTime(5, 'first thaw')).toEqual({ ordinal: 5, label: 'first thaw' });
    // Labels are display only, so two moments with the same ordinal compare equal.
    expect(compareStoryTime(storyTime(5, 'x'), storyTime(5, 'y'))).toBe(0);
  });

  it('orders by ordinal', () => {
    expect(compareStoryTime(a, b)).toBeLessThan(0);
    expect(compareStoryTime(b, a)).toBeGreaterThan(0);
    expect([c, a, b].sort(compareStoryTime)).toEqual([a, b, c]);
  });

  it('compares', () => {
    expect(isBefore(a, b)).toBe(true);
    expect(isBefore(b, a)).toBe(false);
    expect(isBefore(a, a)).toBe(false);
    expect(isAtOrBefore(a, a)).toBe(true);
    expect(isAtOrBefore(b, a)).toBe(false);
  });

  it('picks extremes, preferring the first argument on a tie', () => {
    expect(earliest(a, b)).toBe(a);
    expect(earliest(b, a)).toBe(a);
    expect(latest(a, b)).toBe(b);
    expect(latest(b, a)).toBe(b);
    const tie = storyTime(10);
    expect(earliest(a, tie)).toBe(a);
    expect(latest(a, tie)).toBe(a);
  });

  it('bounds the whole timeline with sentinels', () => {
    expect(isBefore(DAWN, a)).toBe(true);
    expect(isBefore(a, HORIZON)).toBe(true);
  });
});

describe('well-formedness', () => {
  it('accepts a non-empty span and anything unbounded', () => {
    expect(isWellFormed(interval(a, b))).toBe(true);
    expect(isWellFormed(interval(null, b))).toBe(true);
    expect(isWellFormed(interval(a, null))).toBe(true);
    expect(isWellFormed(ALWAYS)).toBe(true);
  });

  it('rejects an inverted span', () => {
    expect(isWellFormed(interval(b, a))).toBe(false);
  });

  it('rejects an empty span - it means a fact was retracted as it was asserted', () => {
    expect(isWellFormed(interval(a, a))).toBe(false);
  });
});

describe('containment - half-open [from, until)', () => {
  const window = interval(a, c);

  it('includes the start and excludes the end', () => {
    expect(contains(window, a)).toBe(true);
    expect(contains(window, b)).toBe(true);
    expect(contains(window, c)).toBe(false);
  });

  it('excludes points outside', () => {
    expect(contains(window, storyTime(0))).toBe(false);
    expect(contains(window, storyTime(99))).toBe(false);
  });

  it('an unbounded interval contains everything', () => {
    expect(contains(ALWAYS, storyTime(Number.MIN_SAFE_INTEGER + 1))).toBe(true);
    expect(contains(ALWAYS, storyTime(0))).toBe(true);
  });
});

describe('overlap', () => {
  it('detects a shared span', () => {
    expect(overlaps(interval(a, c), interval(b, storyTime(40)))).toBe(true);
  });

  it('treats adjacency as no overlap, so a state change leaves no contradiction', () => {
    // [10,20) and [20,30) describe "before" and "after", not a conflict.
    expect(overlaps(interval(a, b), interval(b, c))).toBe(false);
  });

  it('detects no overlap when disjoint', () => {
    expect(overlaps(interval(a, b), interval(c, storyTime(40)))).toBe(false);
  });

  it('is symmetric', () => {
    const left = interval(a, c);
    const right = interval(b, storyTime(40));
    expect(overlaps(left, right)).toBe(overlaps(right, left));
  });

  it('an unbounded interval overlaps everything non-empty', () => {
    expect(overlaps(ALWAYS, interval(a, b))).toBe(true);
  });
});

describe('intersection', () => {
  it('returns the shared span', () => {
    expect(intersect(interval(a, c), interval(b, storyTime(40)))).toEqual({
      from: b,
      until: c,
    });
  });

  it('returns undefined when they do not meet', () => {
    expect(intersect(interval(a, b), interval(c, storyTime(40)))).toBeUndefined();
  });

  it('normalises a sentinel bound back to null', () => {
    expect(intersect(ALWAYS, ALWAYS)).toEqual({ from: null, until: null });
    expect(intersect(ALWAYS, interval(a, null))).toEqual({ from: a, until: null });
  });
});

describe('enclosure', () => {
  it('detects full coverage, including equal bounds', () => {
    expect(encloses(interval(a, c), interval(b, c))).toBe(true);
    expect(encloses(interval(a, c), interval(a, c))).toBe(true);
    expect(encloses(ALWAYS, interval(a, b))).toBe(true);
  });

  it('rejects partial coverage', () => {
    expect(encloses(interval(a, b), interval(a, c))).toBe(false);
    expect(encloses(interval(b, c), ALWAYS)).toBe(false);
  });
});

describe('closeAt', () => {
  it('bounds an open interval instead of deleting the fact', () => {
    // A disproved belief is bounded, not erased - otherwise you cannot ask what a
    // character believed before the reveal.
    expect(closeAt(interval(a, null), c)).toEqual({ from: a, until: c });
  });

  it('leaves the start alone, including an unbounded one', () => {
    expect(closeAt(ALWAYS, c)).toEqual({ from: null, until: c });
  });
});

describe('coalesce', () => {
  it('returns nothing for nothing', () => {
    expect(coalesce([])).toEqual([]);
  });

  it('leaves disjoint intervals alone and sorts them', () => {
    expect(coalesce([interval(c, storyTime(40)), interval(a, b)])).toEqual([
      { from: a, until: b },
      { from: c, until: storyTime(40) },
    ]);
  });

  it('merges overlapping intervals', () => {
    expect(coalesce([interval(a, c), interval(b, storyTime(40))])).toEqual([
      { from: a, until: storyTime(40) },
    ]);
  });

  it('merges touching intervals - three assertions of one fact read as one span', () => {
    expect(coalesce([interval(a, b), interval(b, c)])).toEqual([{ from: a, until: c }]);
  });

  it('absorbs an interval fully inside another', () => {
    expect(coalesce([interval(a, storyTime(40)), interval(b, c)])).toEqual([
      { from: a, until: storyTime(40) },
    ]);
  });

  it('collapses to a single unbounded interval when one swallows the rest', () => {
    expect(coalesce([interval(a, b), ALWAYS, interval(c, null)])).toEqual([
      { from: null, until: null },
    ]);
  });

  it('normalises a merged unbounded end back to null', () => {
    expect(coalesce([interval(a, b), interval(b, null)])).toEqual([{ from: a, until: null }]);
  });

  it('does not mutate its input', () => {
    const source = [interval(c, storyTime(40)), interval(a, b)];
    const copy = structuredClone(source);
    coalesce(source);
    expect(source).toEqual(copy);
  });
});

describe('span', () => {
  it('measures a bounded interval', () => {
    expect(span(interval(a, c))).toBe(20);
  });

  it('reports infinity for anything unbounded', () => {
    expect(span(interval(a, null))).toBe(Number.POSITIVE_INFINITY);
    expect(span(interval(null, c))).toBe(Number.POSITIVE_INFINITY);
    expect(span(ALWAYS)).toBe(Number.POSITIVE_INFINITY);
  });
});
