/**
 * The keyframe source, expressed as a provider.
 *
 * Nothing here is new machinery - keyframed tracks are the oldest thing in the IR. What
 * is new is that they now arrive through the same door as everything else, which is what
 * makes the door worth having: a mocap import, a model proposing keys and a timeline
 * drag are all this provider with a different caller, and none of them is a new concept
 * in the motion system.
 *
 * The work it does is exactly the gap between "keys somebody produced" and "a legal
 * `Track`":
 *
 *  - **Ordering.** `Track` refines its keyframes to be strictly increasing in time.
 *    Nothing that produces keys guarantees that: a drag moves a key past its neighbour,
 *    a model emits them in the order it thought of them, an importer emits them per
 *    channel.
 *  - **Collisions.** Two keys on one instant is not a track, it is a question. The later
 *    one wins, because the later one is the edit.
 *  - **Identity.** Track ids are derived from the request key and the target, so
 *    authoring the same curve twice produces the same record rather than a second one.
 */

import {
  UnsupportedCapabilityError,
  type AppError,
  type Result,
  at,
  err,
  ok,
} from '@rv/shared-kernel';
import type {
  AuthoredMotion,
  Keyframe,
  KeyframeCurve,
  MotionCapabilities,
  MotionProviderKind,
  MotionRequest,
  Track,
  TrackId,
} from '@rv/contracts';
import { AnimChannel } from '@rv/contracts';

import { deriveId } from './derive';
import type { MotionProvider } from './port';

export class KeyframeMotionProvider implements MotionProvider {
  readonly id: string;
  readonly kind: MotionProviderKind = 'keyframe';
  /** Every channel: a key is a number on a channel, and no channel is harder than another. */
  readonly capabilities: MotionCapabilities = {
    channels: [...AnimChannel.options],
    behaviours: [],
  };

  constructor(id = 'keyframe') {
    this.id = id;
  }

  author(request: MotionRequest): Promise<Result<AuthoredMotion, AppError>> {
    if (request.kind !== 'keyframe') {
      // The registry routes on kind, so reaching this means something bypassed it. Kept
      // as the last line of the same defence rather than an assertion: it is the caller's
      // mistake, and `Result` is how a caller's mistake is reported.
      return Promise.resolve(err(new UnsupportedCapabilityError(this.id, request.kind)));
    }

    const tracks = request.curves.map((curve, index) => toTrack(request.key, curve, index));
    return Promise.resolve(ok({ tracks, behaviours: [] }));
  }
}

function toTrack(key: string, curve: KeyframeCurve, index: number): Track {
  return {
    id: deriveId<TrackId>('trk', `${key}:${String(index)}:${curve.nodeId}:${curve.channel}`),
    nodeId: curve.nodeId,
    channel: curve.channel,
    keyframes: normalise(curve.keys),
    before: curve.before,
    after: curve.after,
    additive: curve.additive,
  };
}

/**
 * Keys sorted and de-collided, which is what `Track` requires and no producer supplies.
 *
 * A stable sort followed by "the last key at an instant wins" is the rule a timeline
 * behaves by: dropping a key on top of another replaces it. Doing it here rather than at
 * every call site means an LLM, an importer and the editor all get the same answer.
 */
function normalise(keys: readonly Keyframe[]): [Keyframe, ...Keyframe[]] {
  const sorted = [...keys].sort((left, right) => left.timeMs - right.timeMs);

  const out: Keyframe[] = [];
  for (const key of sorted) {
    const previous = out[out.length - 1];
    if (previous?.timeMs === key.timeMs) out.pop();
    out.push(key);
  }

  // `KeyframeCurve` requires at least one key and the loop above never empties the list,
  // so `at` is a loud restatement of an invariant rather than a branch this can take.
  return [at(out, 0, 'keyframe'), ...out.slice(1)];
}
