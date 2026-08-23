/**
 * Normalised-rectangle arithmetic.
 *
 * Everything the reframer reasons about is a `NormRect` - fractions of a frame rather
 * than pixels - because a crop solved for a 1080x1920 delivery must be the same crop
 * for a 2160x3840 one. Working in pixels would make the solution resolution-dependent
 * and the 4K export subtly different from the 1080p export it was reviewed at.
 *
 * The functions are boring on purpose. Every one of them is used in a constraint
 * derivation in `solve-crop.ts`, where an off-by-one in `contains` is the difference
 * between "the face is inside the safe area" and "the face is one pixel outside it and
 * the test passes".
 */

import type { NormRect, Size, Vec2 } from '@rv/contracts';

/** Floating-point slack. One part in a million of a frame is a fifth of a 1080p pixel. */
export const EPSILON = 1e-6;

export const FULL: NormRect = { x: 0, y: 0, width: 1, height: 1 };

export function rectCentre(rect: NormRect): Vec2 {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function rectRight(rect: NormRect): number {
  return rect.x + rect.width;
}

export function rectBottom(rect: NormRect): number {
  return rect.y + rect.height;
}

/** True when `inner` lies wholly within `outer`, to within `epsilon`. */
export function contains(outer: NormRect, inner: NormRect, epsilon = EPSILON): boolean {
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    rectRight(inner) <= rectRight(outer) + epsilon &&
    rectBottom(inner) <= rectBottom(outer) + epsilon
  );
}

export function clamp(value: number, low: number, high: number): number {
  // `low` wins a crossed range: the caller has an infeasible constraint and the low
  // bound is the one derived from the composition's own edge, which is never negotiable.
  if (high < low) return low;
  return value < low ? low : value > high ? high : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** A rectangle clamped into the unit square, keeping its size where it can. */
export function clampRect(rect: NormRect): NormRect {
  const width = clamp(rect.width, 0, 1);
  const height = clamp(rect.height, 0, 1);
  return {
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
    width,
    height,
  };
}

/**
 * The largest rectangle of `targetAspect` that fits inside `composition`, as fractions.
 *
 * This is the *only* crop size the solver considers, and the reason is worth stating:
 * a smaller crop is a tighter zoom, and zooming in makes the safe-area constraint
 * strictly harder (the focus region occupies proportionally more of the frame) while
 * also being a framing decision the director did not make. So the biggest legal crop is
 * simultaneously the most likely to succeed and the least presumptuous.
 */
export function maximalCrop(composition: Size, target: Size): { width: number; height: number } {
  const targetAspect = target.width / target.height;
  const cropWidthPx = Math.min(composition.width, composition.height * targetAspect);
  const cropHeightPx = cropWidthPx / targetAspect;
  return { width: cropWidthPx / composition.width, height: cropHeightPx / composition.height };
}

/**
 * `composition` fitted whole inside `target`, with bars.
 *
 * Returns where the composition lands in the target frame, in target-frame fractions.
 * Used by the letterbox and pillarbox strategies, which keep everything the author
 * composed at the cost of black bars.
 */
export function containFit(composition: Size, target: Size): NormRect {
  const scale = Math.min(target.width / composition.width, target.height / composition.height);
  const width = (composition.width * scale) / target.width;
  const height = (composition.height * scale) / target.height;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

/**
 * Maps a rectangle from composition space into the target frame, given the crop.
 *
 * The one formula the whole safe-area check rests on.
 */
export function mapIntoCrop(rect: NormRect, crop: NormRect): NormRect {
  return {
    x: (rect.x - crop.x) / crop.width,
    y: (rect.y - crop.y) / crop.height,
    width: rect.width / crop.width,
    height: rect.height / crop.height,
  };
}

/** Maps a rectangle in composition space onto a letterboxed placement of the whole frame. */
export function mapIntoFit(rect: NormRect, fit: NormRect): NormRect {
  return {
    x: fit.x + rect.x * fit.width,
    y: fit.y + rect.y * fit.height,
    width: rect.width * fit.width,
    height: rect.height * fit.height,
  };
}

/** A closed interval, or `null` when the constraints cannot all be met. */
export interface Interval {
  readonly low: number;
  readonly high: number;
}

export function intersectIntervals(a: Interval, b: Interval): Interval | null {
  const low = Math.max(a.low, b.low);
  const high = Math.min(a.high, b.high);
  return high < low - EPSILON ? null : { low, high: Math.max(low, high) };
}

/**
 * Linear interpolation between two crops, eased.
 *
 * Smoothstep rather than linear because a pan that starts and stops instantaneously
 * reads as a camera jerk. It is also why the continuity bound in the test is
 * `1.5 x |delta| / frames`: smoothstep's derivative peaks at 1.5 in the middle of the
 * move, and a bound that assumed a linear ramp would fail on a correct pan.
 */
export function lerpRect(from: NormRect, to: NormRect, progress: number): NormRect {
  const t = clamp01(progress);
  const eased = t * t * (3 - 2 * t);
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
    width: from.width + (to.width - from.width) * eased,
    height: from.height + (to.height - from.height) * eased,
  };
}

/** Peak derivative of the smoothstep used by {@link lerpRect}. */
export const SMOOTHSTEP_PEAK_SLOPE = 1.5;
