/**
 * Story-time algebra.
 *
 * Fiction has its own clock. What the continuity engine needs from it is not a
 * calendar but a **total order** plus interval arithmetic, so it can answer "was this
 * true then" and "do these two facts overlap".
 *
 * Intervals are **half-open**: `[from, until)`. A fact that becomes false at ordinal
 * 50 and another that becomes true at 50 do not overlap, which is what lets a state
 * change be expressed without an off-by-one gap. `null` on either end means unbounded.
 */

import { at } from '@rv/shared-kernel';
import type { StoryInterval, StoryTime } from '@rv/contracts';

/** Everything before the story starts. */
export const DAWN: StoryTime = Object.freeze({ ordinal: Number.MIN_SAFE_INTEGER });
/** Everything after it ends. */
export const HORIZON: StoryTime = Object.freeze({ ordinal: Number.MAX_SAFE_INTEGER });

/** The interval that contains every moment. */
export const ALWAYS: StoryInterval = Object.freeze({ from: null, until: null });

export function storyTime(ordinal: number, label?: string): StoryTime {
  return label === undefined ? { ordinal } : { ordinal, label };
}

/** Negative, zero or positive - suitable for `Array.prototype.sort`. */
export function compareStoryTime(a: StoryTime, b: StoryTime): number {
  return a.ordinal - b.ordinal;
}

export function isBefore(a: StoryTime, b: StoryTime): boolean {
  return a.ordinal < b.ordinal;
}

export function isAtOrBefore(a: StoryTime, b: StoryTime): boolean {
  return a.ordinal <= b.ordinal;
}

export function earliest(a: StoryTime, b: StoryTime): StoryTime {
  return a.ordinal <= b.ordinal ? a : b;
}

export function latest(a: StoryTime, b: StoryTime): StoryTime {
  return a.ordinal >= b.ordinal ? a : b;
}

// ── intervals ───────────────────────────────────────────────────────────────

/** Resolves an unbounded end to its sentinel, so comparisons need no special cases. */
function lowerBound(interval: StoryInterval): StoryTime {
  return interval.from ?? DAWN;
}

function upperBound(interval: StoryInterval): StoryTime {
  return interval.until ?? HORIZON;
}

export function interval(from: StoryTime | null, until: StoryTime | null): StoryInterval {
  return { from, until };
}

/**
 * Whether the interval is coherent.
 *
 * An empty interval (`from === until`) is rejected rather than tolerated: it usually
 * means a fact was retracted at the instant it was asserted, which is a bug in the
 * caller, not a legitimate state.
 */
export function isWellFormed(candidate: StoryInterval): boolean {
  return lowerBound(candidate).ordinal < upperBound(candidate).ordinal;
}

/** Half-open containment: `from <= point < until`. */
export function contains(candidate: StoryInterval, point: StoryTime): boolean {
  return (
    lowerBound(candidate).ordinal <= point.ordinal && point.ordinal < upperBound(candidate).ordinal
  );
}

/**
 * Whether two intervals share any moment.
 *
 * This is the primitive the contradiction detector runs on: two incompatible facts
 * that overlap in story time are a continuity error.
 */
export function overlaps(a: StoryInterval, b: StoryInterval): boolean {
  return (
    lowerBound(a).ordinal < upperBound(b).ordinal && lowerBound(b).ordinal < upperBound(a).ordinal
  );
}

/** The shared span, or `undefined` when they do not meet. */
export function intersect(a: StoryInterval, b: StoryInterval): StoryInterval | undefined {
  if (!overlaps(a, b)) return undefined;
  const from = latest(lowerBound(a), lowerBound(b));
  const until = earliest(upperBound(a), upperBound(b));
  return {
    from: from === DAWN ? null : from,
    until: until === HORIZON ? null : until,
  };
}

/** True when `outer` covers every moment of `inner`. */
export function encloses(outer: StoryInterval, inner: StoryInterval): boolean {
  return (
    lowerBound(outer).ordinal <= lowerBound(inner).ordinal &&
    upperBound(inner).ordinal <= upperBound(outer).ordinal
  );
}

/**
 * Closes an open interval at `point`.
 *
 * This is how a fact stops being true: a belief is not deleted when it is disproved,
 * it is *bounded*. Deleting it would erase the ability to ask what a character
 * believed before the reveal, which is the whole reason the graph is temporal.
 */
export function closeAt(open: StoryInterval, point: StoryTime): StoryInterval {
  return { from: open.from, until: point };
}

/**
 * Merges intervals that touch or overlap, leaving the rest.
 *
 * Used when compacting a fact's history: three consecutive assertions of the same
 * thing should read as one span, not three.
 */
export function coalesce(intervals: readonly StoryInterval[]): StoryInterval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => lowerBound(a).ordinal - lowerBound(b).ordinal);

  const merged: StoryInterval[] = [at(sorted, 0)];
  for (let i = 1; i < sorted.length; i += 1) {
    const next = at(sorted, i);
    const last = at(merged, merged.length - 1);

    // Touching counts as mergeable: `[0,10)` and `[10,20)` describe one continuous span.
    if (lowerBound(next).ordinal <= upperBound(last).ordinal) {
      const until = latest(upperBound(last), upperBound(next));
      merged[merged.length - 1] = {
        from: last.from,
        until: until === HORIZON ? null : until,
      };
    } else {
      merged.push(next);
    }
  }

  return merged;
}

/** Total length, with `Infinity` for anything unbounded. */
export function span(candidate: StoryInterval): number {
  if (candidate.from === null || candidate.until === null) return Number.POSITIVE_INFINITY;
  return candidate.until.ordinal - candidate.from.ordinal;
}
