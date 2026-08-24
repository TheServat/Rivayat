/**
 * Where a track's motion comes from, and what an edit to it will actually do.
 *
 * `docs/universal_ai_animation_system.md` §17 treats motion as a *provider*: keyframes
 * and procedural behaviours are two sources among several, with physics, retargeted
 * library clips and AI motion to come. A timeline that assumes every track was hand
 * authored will mislead the moment the second kind arrives - and it already can,
 * because the IR carries both today.
 *
 * The evaluator's rule is the fact this module exists to surface. From `evaluate.ts`:
 *
 *   > Behaviours first and additively... Tracks last, and by default they **replace**.
 *   > A hand-placed keyframe is a deliberate statement about where something is; a
 *   > behaviour is ambient. `additive` opts a track into layering instead.
 *
 * So dragging a keyframe on a channel that a behaviour also drives is not a no-op and
 * it is not a merge: it *overrides* the behaviour, unless the track declared itself
 * additive, in which case the two sum. Both outcomes are surprising if nobody says
 * them, and the surprise lands after a render rather than during the drag.
 *
 * **Nothing here is invented.** Every value is read off the IR as it exists. When a
 * future IR declares a track's provider outright, `motionSourceFor` becomes a read of
 * that field, `MotionSourceKind` gains members, and the two components that render it
 * do not change - they already switch on a table.
 */

import type { AnimationIR, Behaviour, Track } from '@rv/contracts';

/**
 * What drives a track.
 *
 * Three members, because three are derivable. A fourth ("physics", "retargeted",
 * "ai-motion") would be a member no data can produce, which is a lie in the type
 * system - so the union grows when the contract does, and `unknown` is the honest
 * landing place for a source this build does not recognise.
 */
export type MotionSourceKind =
  'keyframe' | 'keyframe-over-procedural' | 'keyframe-with-procedural' | 'unknown';

export interface MotionSource {
  readonly kind: MotionSourceKind;
  /** Behaviours contending for the same channel on the same node, by kind. */
  readonly contenders: readonly Behaviour['kind'][];
  /**
   * Whether dragging a keyframe on this track does what it looks like it does.
   *
   * True for a plain keyframed track. False when a behaviour is also writing this
   * channel, because then the *result* is not the keyframe value - it is the keyframe
   * value replacing, or summing with, something the user did not author.
   */
  readonly editsAreLiteral: boolean;
}

export const MOTION_SOURCE_KEYS: Readonly<Record<MotionSourceKind, string>> = {
  keyframe: 'timeline.motion.keyframe',
  'keyframe-over-procedural': 'timeline.motion.keyframe-over-procedural',
  'keyframe-with-procedural': 'timeline.motion.keyframe-with-procedural',
  unknown: 'timeline.motion.unknown',
};

/** The consequence of moving a keyframe here, as a message key. `null` when there is none. */
export const MOTION_CONSEQUENCE_KEYS: Readonly<Record<MotionSourceKind, string | null>> = {
  keyframe: null,
  'keyframe-over-procedural': 'timeline.motion.consequence.replaces',
  'keyframe-with-procedural': 'timeline.motion.consequence.sums',
  unknown: null,
};

/**
 * Which channels a behaviour writes.
 *
 * Read from `@rv/anim-engine`'s behaviour implementations rather than guessed. A table
 * rather than a call to `evaluateBehaviour`, because the answer must be the same at
 * every `t` - a `blink` returns nothing between blinks, and a UI that asked the
 * evaluator at the current time would tell the user the channel is free for 4.1 seconds
 * out of every 4.2.
 */
const BEHAVIOUR_CHANNELS: Readonly<Record<Behaviour['kind'], readonly Track['channel'][]>> = {
  wind: ['rotation', 'position.x'],
  breathe: ['scale.y', 'scale.x'],
  blink: ['scale.y'],
  // `sway` writes the channel its `axis` names; resolved per behaviour below.
  sway: [],
  'walk-cycle': ['position.y', 'position.x', 'rotation'],
  flap: ['rotation'],
  orbit: ['position.x', 'position.y'],
  parallax: ['position.x', 'position.y'],
  boil: ['position.x', 'position.y', 'rotation'],
  // `spring` trails the channel its `follows` names; resolved per behaviour below.
  spring: [],
  'look-at': ['rotation'],
  'follow-path': ['position.x', 'position.y', 'rotation'],
  'lip-sync': ['text.reveal', 'fx.intensity'],
};

function channelsOf(behaviour: Behaviour): readonly Track['channel'][] {
  if (behaviour.kind === 'sway') return [behaviour.axis];
  if (behaviour.kind === 'spring') return [behaviour.follows];
  return BEHAVIOUR_CHANNELS[behaviour.kind];
}

export function motionSourceFor(ir: AnimationIR, track: Track): MotionSource {
  const contenders = ir.behaviours
    .filter(
      (behaviour) =>
        behaviour.enabled &&
        behaviour.nodeId === track.nodeId &&
        channelsOf(behaviour).includes(track.channel),
    )
    .map((behaviour) => behaviour.kind);

  if (contenders.length === 0) {
    return { kind: 'keyframe', contenders, editsAreLiteral: true };
  }
  return {
    kind: track.additive ? 'keyframe-with-procedural' : 'keyframe-over-procedural',
    contenders,
    editsAreLiteral: false,
  };
}
