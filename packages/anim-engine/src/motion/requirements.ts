/**
 * What one request needs of a provider.
 *
 * The other half of the capability declaration: a provider says what it can author,
 * this says what is being asked for, and the registry compares them *before* a call.
 * That ordering is the point - an adapter that fails on the far end has already been
 * selected, logged and, for anything that costs money, budgeted for.
 *
 * A `switch` with `assertNever` over a closed request union, which is the same shape
 * `dispatch` in `behaviours.ts` uses. It is not the forbidden kind: the rule in
 * CLAUDE.md §2 is that an *implementation* is never chosen by switching on a name -
 * that is the registry's `Map` - while deciding what a request means is exactly the
 * decision a fifth request kind must be forced to make.
 */

import { assertNever } from '@rv/shared-kernel';
import type { AnimChannel, BehaviourKind, MotionCapabilities, MotionRequest } from '@rv/contracts';

/**
 * Channels a physics bake writes.
 *
 * A solver produces a position and an orientation per body per frame, and nothing else -
 * it has no opinion about opacity or tint. Naming them here rather than leaving the
 * requirement empty is what lets a physics request be routed away from a provider that
 * only serves rotation.
 */
const PHYSICS_CHANNELS: readonly AnimChannel[] = ['position.x', 'position.y', 'rotation'];

export function motionRequirements(request: MotionRequest): MotionCapabilities {
  switch (request.kind) {
    case 'keyframe':
      return { channels: unique(request.curves.map((curve) => curve.channel)), behaviours: [] };
    case 'procedural':
      return { channels: [], behaviours: unique(request.plans.map((plan) => plan.kind)) };
    case 'physics':
      return { channels: [...PHYSICS_CHANNELS], behaviours: [] };
    case 'retargeted-library':
      // Genuinely unknowable here: what a library clip drives is a property of the
      // fragment, which is addressed by content hash and has not been loaded. Declaring
      // nothing means the request routes on kind alone and the provider reports what it
      // finds - which is honest, where inventing a requirement would be a guess that
      // routes correctly by luck.
      return { channels: [], behaviours: [] };
    default:
      return assertNever(request, 'motion request kind');
  }
}

function unique<T extends AnimChannel | BehaviourKind>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
