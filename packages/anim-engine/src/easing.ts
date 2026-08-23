/**
 * Easing evaluation.
 *
 * A cubic bezier easing curve is parametric: the authored control points give
 * `(x(t), y(t))`, but what an animator means is `y` **as a function of x**, where x is
 * normalised time. So evaluating one is a root-find - given x, solve for the parameter
 * t, then read y.
 *
 * The renderer, the sprite-sheet baker and the Lottie exporter all have to agree on
 * that number to the last bit, or a baked sheet drifts from its own live playback. So
 * the solver is here, once, with a fixed iteration budget rather than a
 * convergence-dependent loop - a solver that iterates "until close enough" makes the
 * result depend on floating-point luck.
 */

import { at, must } from '@rv/shared-kernel';
import type { Easing, EasingCurve } from '@rv/contracts';

/**
 * Newton-Raphson refinement passes, then bisection.
 *
 * Newton converges in 2-4 passes on a well-behaved curve and fails on the flat regions
 * that anticipation and overshoot curves deliberately contain, where the derivative
 * approaches zero. Bisection always converges. Running a fixed count of each makes the
 * cost and the answer both constant.
 */
const NEWTON_PASSES = 4;
const BISECTION_PASSES = 12;
const NEWTON_MIN_SLOPE = 1e-4;

/** Cubic bezier with implicit endpoints at (0,0) and (1,1). */
function bezier(t: number, p1: number, p2: number): number {
  const u = 1 - t;
  // 3u²t·p1 + 3ut²·p2 + t³   (the p0 term is zero, the p3 term is one)
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function bezierSlope(t: number, p1: number, p2: number): number {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/** Solves `x(t) = x` for t. */
function solveT(x: number, x1: number, x2: number): number {
  let t = x;

  for (let i = 0; i < NEWTON_PASSES; i += 1) {
    const slope = bezierSlope(t, x1, x2);
    if (Math.abs(slope) < NEWTON_MIN_SLOPE) break;
    t -= (bezier(t, x1, x2) - x) / slope;
  }

  // Bisection from a fresh bracket: Newton may have wandered outside [0,1].
  let low = 0;
  let high = 1;
  if (t < 0 || t > 1) t = x;
  for (let i = 0; i < BISECTION_PASSES; i += 1) {
    const value = bezier(t, x1, x2);
    if (value < x) low = t;
    else high = t;
    t = (low + high) / 2;
  }

  return t;
}

/**
 * Evaluates a cubic bezier easing at normalised time `x`.
 *
 * `y` is intentionally unclamped: values below 0 are anticipation and above 1 are
 * overshoot, both of which the style bible's motion principles ask for.
 */
export function cubicBezierAt(x: number, x1: number, y1: number, x2: number, y2: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // The identity curve; skip the solve so `linear` is exact rather than near-exact.
  if (x1 === y1 && x2 === y2) return x;
  return bezier(solveT(x, x1, x2), y1, y2);
}

/** Quantises `x` into `steps` jumps. */
export function steppedAt(x: number, steps: number, at_: 'start' | 'end'): number {
  if (x <= 0) return at_ === 'start' ? 1 / steps : 0;
  if (x >= 1) return 1;
  const index = Math.floor(x * steps);
  return (at_ === 'start' ? index + 1 : index) / steps;
}

/**
 * The curves an `Easing` of kind `named` can resolve against.
 *
 * Supplied by the active style bible, which is what makes "restyle the whole series'
 * feel by editing one curve" work.
 */
export type EasingLibrary = ReadonlyMap<string, EasingCurve>;

export function buildEasingLibrary(curves: readonly EasingCurve[]): EasingLibrary {
  const map = new Map<string, EasingCurve>();
  for (const curve of curves) map.set(curve.name, curve);
  return map;
}

/**
 * Applies an easing to normalised time.
 *
 * A named curve that is not in the library throws rather than silently falling back to
 * linear: a missing curve means the clip and the style bible disagree, and animating it
 * as linear hides that behind motion that merely looks slightly wrong.
 */
export function applyEasing(easing: Easing | undefined, x: number, library: EasingLibrary): number {
  if (easing === undefined) return x;

  switch (easing.kind) {
    case 'named': {
      const curve = must(library, easing.name, 'easing curve');
      return cubicBezierAt(x, curve.p1.x, curve.p1.y, curve.p2.x, curve.p2.y);
    }
    case 'cubic-bezier':
      return cubicBezierAt(x, easing.x1, easing.y1, easing.x2, easing.y2);
    case 'stepped':
      return steppedAt(x, easing.steps, easing.at);
  }
}

/**
 * Quantises a time to the frame grid a stepped cadence implies.
 *
 * `on-2s` holds each drawing for two frames, which is most of the difference between
 * "animated" and "interpolated by a computer". Applied to *time* rather than to each
 * value, so every channel of every node steps together - stepping them independently
 * produces a soup that reads as a glitch.
 */
export function quantiseToStep(
  timeMs: number,
  fps: number,
  stepMode: 'smooth' | 'on-2s' | 'on-3s' | 'on-4s',
): number {
  if (stepMode === 'smooth') return timeMs;
  const hold = at([2, 3, 4], ['on-2s', 'on-3s', 'on-4s'].indexOf(stepMode), 'step size');
  const frameMs = 1000 / fps;
  const frame = Math.floor(timeMs / frameMs);
  return Math.floor(frame / hold) * hold * frameMs;
}
