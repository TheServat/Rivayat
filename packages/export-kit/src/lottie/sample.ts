/**
 * Building Lottie properties, and reading them back.
 *
 * The reading half is not a convenience. An exporter that only writes has no way to know
 * whether what it wrote means what it intended, so this module implements Lottie's
 * documented interpolation once - **through `cubicBezierAt` from `@rv/anim-engine`, the
 * renderer's own solver** - and the exporter uses it to measure its own output against
 * `evaluate(ir, t)` before returning. That measurement is what turns "the export matches
 * its preview" from a claim into a number on the result.
 */

import { at } from '@rv/shared-kernel';
import { cubicBezierAt } from '@rv/anim-engine';

import type {
  LottieAnimatedProperty,
  LottieKeyframe,
  LottieProperty,
  LottieStaticProperty,
} from './types';
import type { LottieSegmentEase } from './easing';

/**
 * Rounds for the file.
 *
 * Emitted numbers are rounded rather than written at full precision for two reasons: a
 * 17-digit float per component triples the size of a baked track, and `-0` and
 * exponent-form literals both make byte-identical re-exports harder than they need to
 * be. Six decimals is a thousandth of a pixel at 4K.
 */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function staticProperty(value: number | readonly number[]): LottieStaticProperty {
  return { a: 0, k: value };
}

export function animatedProperty(keyframes: readonly LottieKeyframe[]): LottieAnimatedProperty {
  return { a: 1, k: keyframes };
}

/** How many keyframes a property carries. Static properties carry none. */
export function keyframeCount(property: LottieProperty): number {
  return property.a === 1 ? property.k.length : 0;
}

// ── sampling a property back out ────────────────────────────────────────────

/**
 * The value of a Lottie property at a frame, per the format's own rules.
 *
 * Segment `[k_i, k_{i+1}]` interpolates linearly from `k_i.s` to `k_{i+1}.s`, with the
 * parameter eased by the cubic bezier whose control points are `k_i.o` and `k_i.i`. A
 * keyframe carrying `h: 1` holds its own value for the whole segment. Outside the
 * keyframe span the first and last values hold - Lottie has no extrapolation, which is
 * why the IR's `loop` and `ping-pong` modes cannot survive the trip.
 *
 * Handles may carry one entry per dimension; a single entry applies to all of them.
 */
export function sampleLottieProperty(property: LottieProperty, frame: number): readonly number[] {
  if (property.a === 0) return typeof property.k === 'number' ? [property.k] : property.k;

  const keys = property.k;
  if (keys.length === 0) return [];

  const first = at(keys, 0);
  if (frame <= first.t) return first.s;

  const last = at(keys, keys.length - 1);
  if (frame >= last.t) return last.s;

  let index = 0;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (at(keys, i + 1).t > frame) break;
    index = i + 1;
  }

  const from = at(keys, index);
  const to = at(keys, index + 1);
  if (from.h === 1) return from.s;

  const span = to.t - from.t;
  // Guaranteed positive: the scan only lands on a segment whose end is strictly past
  // `frame`, and builders never emit two keyframes at the same time.
  const progress = (frame - from.t) / span;

  const out: number[] = [];
  for (let dimension = 0; dimension < from.s.length; dimension += 1) {
    const start = from.s[dimension] ?? 0;
    const end = to.s[dimension] ?? start;
    const eased = easeAt(from, dimension, progress);
    out.push(start + (end - start) * eased);
  }
  return out;
}

function easeAt(keyframe: LottieKeyframe, dimension: number, progress: number): number {
  const outHandle = keyframe.o;
  const inHandle = keyframe.i;
  if (outHandle === undefined || inHandle === undefined) return progress;

  const x1 = outHandle.x[dimension] ?? outHandle.x[0] ?? 0;
  const y1 = outHandle.y[dimension] ?? outHandle.y[0] ?? 0;
  const x2 = inHandle.x[dimension] ?? inHandle.x[0] ?? 1;
  const y2 = inHandle.y[dimension] ?? inHandle.y[0] ?? 1;
  return cubicBezierAt(progress, x1, y1, x2, y2);
}

// ── building a baked property ───────────────────────────────────────────────

/**
 * Drops samples that lie on the straight line between the ones that survive.
 *
 * A bounded reduction, not a heuristic: a point is only removed when every point it
 * would leave behind stays within `tolerance` of the line the reader will interpolate
 * instead, so the error this introduces is at most `tolerance` and the caller sets it.
 * With the default it removes exactly the runs that are genuinely collinear - which on a
 * scene of forty swaying trees is most of the `scale` and `opacity` channels, and none
 * of the `rotation` ones.
 */
export function simplifySamples(
  times: readonly number[],
  values: readonly (readonly number[])[],
  tolerance: number,
): readonly number[] {
  if (times.length <= 2) return times.map((_, index) => index);

  const kept: number[] = [0];
  let anchor = 0;

  for (let candidate = 1; candidate < times.length - 1; candidate += 1) {
    if (withinTolerance(times, values, anchor, candidate + 1, tolerance)) continue;
    kept.push(candidate);
    anchor = candidate;
  }

  kept.push(times.length - 1);
  return kept;
}

function withinTolerance(
  times: readonly number[],
  values: readonly (readonly number[])[],
  anchor: number,
  end: number,
  tolerance: number,
): boolean {
  const startTime = at(times, anchor);
  const endTime = at(times, end);
  const startValue = at(values, anchor);
  const endValue = at(values, end);
  const span = endTime - startTime;

  for (let index = anchor + 1; index < end; index += 1) {
    const progress = (at(times, index) - startTime) / span;
    const actual = at(values, index);
    for (let dimension = 0; dimension < actual.length; dimension += 1) {
      const a = startValue[dimension] ?? 0;
      const b = endValue[dimension] ?? a;
      const predicted = a + (b - a) * progress;
      if (Math.abs((actual[dimension] ?? 0) - predicted) > tolerance) return false;
    }
  }
  return true;
}

/**
 * A property from dense samples.
 *
 * Collapses to a static property when nothing moves - the common case for `scale` and
 * `opacity` on a node that only ever rotates, and the difference between a readable file
 * and one where every layer carries three thousand identical keyframes.
 */
export function bakedProperty(
  frames: readonly number[],
  values: readonly (readonly number[])[],
  options: { readonly tolerance: number; readonly precision: number },
): LottieProperty {
  const rounded = values.map((value) =>
    value.map((component) => roundTo(component, options.precision)),
  );

  const firstValue = at(rounded, 0);
  const constant = rounded.every((value) =>
    value.every((component, dimension) => component === (firstValue[dimension] ?? 0)),
  );
  if (constant) return staticProperty(firstValue.length === 1 ? at(firstValue, 0) : firstValue);

  const kept = simplifySamples(frames, rounded, options.tolerance);
  const keyframes: LottieKeyframe[] = kept.map((index) => ({
    t: at(frames, index),
    s: at(rounded, index),
  }));
  return animatedProperty(keyframes);
}

/**
 * A property from authored keyframes, preserving their easing.
 *
 * The sparse path: no sampling, no baking, one Lottie keyframe per IR keyframe and the
 * bezier handles carried across. A three-second move is four keyframes here and ninety
 * under {@link bakedProperty}, which is the whole argument for keeping behaviours
 * declarative in the IR and only baking what a format forces us to.
 */
export function authoredProperty(
  entries: readonly { readonly frame: number; readonly value: readonly number[] }[],
  eases: readonly LottieSegmentEase[],
  precision: number,
): LottieProperty {
  if (entries.length === 1) {
    const only = at(entries, 0).value.map((component) => roundTo(component, precision));
    return staticProperty(only.length === 1 ? at(only, 0) : only);
  }

  const keyframes: LottieKeyframe[] = entries.map((entry, index) => {
    const base = {
      t: entry.frame,
      s: entry.value.map((component) => roundTo(component, precision)),
    };
    // The last keyframe ends the last segment; it eases nothing.
    if (index === entries.length - 1) return base;

    const ease = at(eases, index);
    return ease.kind === 'hold' ? { ...base, h: 1 } : { ...base, o: ease.out, i: ease.in };
  });

  return animatedProperty(keyframes);
}
