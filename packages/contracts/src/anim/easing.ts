/**
 * Easing.
 *
 * A curve is either a **named** reference into the style bible's `easings` - so the
 * whole series shares a feel and changing one curve restyles every motion - or an
 * **inline** cubic bezier for the one-off case.
 *
 * `step-start` / `step-end` are separate from the beziers because they are genuinely
 * discontinuous, and because holding a value is how a stepped, hand-drawn cadence is
 * expressed at the keyframe level.
 */

import { z } from 'zod';

import { Slug, Unit01 } from '../primitives/common';

/**
 * Cubic bezier easing, `x` clamped to 0..1 and `y` unbounded.
 *
 * `y` outside 0..1 is not a mistake: that is what produces anticipation (dipping
 * below the start) and overshoot (passing the target and settling back), which the
 * style bible's motion principles explicitly ask for.
 */
export const CubicBezierEasing = z.object({
  kind: z.literal('cubic-bezier'),
  x1: Unit01,
  y1: z.number().min(-4).max(4),
  x2: Unit01,
  y2: z.number().min(-4).max(4),
});
export type CubicBezierEasing = z.infer<typeof CubicBezierEasing>;

export const NamedEasing = z.object({
  kind: z.literal('named'),
  name: Slug.describe('Must exist in the active style bible’s `motion.easings`'),
});
export type NamedEasing = z.infer<typeof NamedEasing>;

/** Jump at the start or the end of the interval. No interpolation at all. */
export const SteppedEasing = z.object({
  kind: z.literal('stepped'),
  at: z.enum(['start', 'end']).default('end'),
  /** Number of discrete jumps across the interval. 1 is a plain hold-then-jump. */
  steps: z.number().int().min(1).max(64).default(1),
});
export type SteppedEasing = z.infer<typeof SteppedEasing>;

export const Easing = z.discriminatedUnion('kind', [NamedEasing, CubicBezierEasing, SteppedEasing]);
export type Easing = z.infer<typeof Easing>;

/**
 * The curves every style bible starts with.
 *
 * Kept as data rather than hard-coded in the evaluator so that a style can override
 * any of them by name and every existing clip changes with it.
 */
export const STANDARD_EASINGS = [
  { name: 'linear', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } },
  { name: 'ease-in', p1: { x: 0.42, y: 0 }, p2: { x: 1, y: 1 } },
  { name: 'ease-out', p1: { x: 0, y: 0 }, p2: { x: 0.58, y: 1 } },
  { name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } },
  { name: 'ease-out-quart', p1: { x: 0.25, y: 1 }, p2: { x: 0.5, y: 1 } },
  { name: 'ease-out-expo', p1: { x: 0.16, y: 1 }, p2: { x: 0.3, y: 1 } },
  // Overshoots past 1 then settles - the classic "snap into place".
  { name: 'back-out', p1: { x: 0.34, y: 1.56 }, p2: { x: 0.64, y: 1 } },
  // Dips below 0 first - anticipation before a move.
  { name: 'back-in', p1: { x: 0.36, y: 0 }, p2: { x: 0.66, y: -0.56 } },
  { name: 'anticipate-overshoot', p1: { x: 0.68, y: -0.6 }, p2: { x: 0.32, y: 1.6 } },
] as const satisfies readonly {
  name: string;
  p1: { x: number; y: number };
  p2: { x: number; y: number };
}[];

export const DEFAULT_EASING: Easing = { kind: 'named', name: 'ease-in-out' };
