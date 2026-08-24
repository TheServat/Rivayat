/**
 * What each animated channel *measures*.
 *
 * The question this table answers is asked exactly once, by retargeting: when the same
 * clip is played on a taller skeleton, which numbers have to grow with it? A rotation
 * does not - a knee bends through the same angle on a child and on an adult - but a
 * stride does, and a clip whose stride was authored for a 512 px figure makes a 256 px
 * one skate across the floor. Getting that wrong is the single most visible retargeting
 * bug, and it is invisible in any test that only checks one rig.
 *
 * It is a **total** `Record<AnimChannel, ChannelMetric>` for the same reason
 * `IR_FEATURE_BY_CHANNEL` in `features.ts` is: adding a channel to `AnimChannel` without deciding
 * whether it scales is a compile error here, in the same package as the union, rather
 * than a silently unscaled value discovered by eye three episodes later.
 *
 * The five metrics are finer than retargeting strictly needs - `scalesWithRig` only
 * asks "is it a length?" - and that is deliberate. "Not a length" is not a decision; it
 * is the absence of one, and a table of eighteen `false`s records nothing about *why*.
 * Naming the unit forces the author of a new channel to say what the number means,
 * which is the same information a timeline UI needs to render a sensible axis.
 */

import { z } from 'zod';

import type { AnimChannel } from './ir';

/**
 * The unit a channel is expressed in.
 *
 * A schema rather than a bare union because it travels: a clip library entry can be
 * rejected for driving a channel the target rig cannot supply, and the reason names
 * the metric.
 */
export const ChannelMetric = z.enum([
  /** Scene or parent-local distance. The only metric retargeting scales. */
  'length',
  /** Degrees. Proportion-free: the same angle reads the same on any skeleton. */
  'angle',
  /** A multiplier around 1. Composes rather than adds, so scaling it would compound. */
  'ratio',
  /** Clamped 0..1. Scaling would drive it out of its own range. */
  'normalised',
  /** An index or a sort key. Arithmetic on it is meaningless. */
  'ordinal',
]);
export type ChannelMetric = z.infer<typeof ChannelMetric>;

/** Total over `AnimChannel`. A new channel must declare what it measures. */
export const CHANNEL_METRIC: Readonly<Record<AnimChannel, ChannelMetric>> = {
  'position.x': 'length',
  'position.y': 'length',
  rotation: 'angle',
  'scale.x': 'ratio',
  'scale.y': 'ratio',
  'skew.x': 'angle',
  'skew.y': 'angle',
  'anchor.x': 'normalised',
  'anchor.y': 'normalised',
  opacity: 'normalised',
  depth: 'ordinal',
  'tint.r': 'normalised',
  'tint.g': 'normalised',
  'tint.b': 'normalised',
  'clip.speed': 'ratio',
  'fx.intensity': 'normalised',
  'text.reveal': 'ordinal',
  'path.progress': 'normalised',
};

/** What `channel` measures. */
export function channelMetric(channel: AnimChannel): ChannelMetric {
  return CHANNEL_METRIC[channel];
}

/**
 * Whether a value on this channel has to be rescaled when the clip moves to another rig.
 *
 * The one question retargeting asks. Written as a predicate rather than inlined at the
 * call site so that "length" stays the single criterion - a second call site testing
 * `!== 'angle'` would quietly start scaling opacity.
 */
export function scalesWithRig(channel: AnimChannel): boolean {
  return CHANNEL_METRIC[channel] === 'length';
}
