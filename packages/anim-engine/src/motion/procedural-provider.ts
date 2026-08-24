/**
 * The procedural source, expressed as a provider.
 *
 * The thirteen behaviours are unchanged - this authors the records, it does not evaluate
 * them, and `behaviours.ts` is untouched. What the provider adds is the thing the IR's
 * own docstring asks for and nothing enforced: **"derive [the seed] from the node id,
 * never at random."** A caller cannot supply a seed here, because `BehaviourPlan` has no
 * field for one; the seed is derived from the request's root seed, the request key, the
 * plan and the node.
 *
 * That derivation is what makes a forest one request. Forty trees swaying convincingly
 * is one plan applied to forty nodes, each gusting differently because its seed came from
 * its own id, and the whole request replaying identically because nothing came from a
 * clock. Forty hand-authored tracks would cost forty edits; forty generated videos would
 * cost money.
 */

import { UnsupportedCapabilityError, type AppError, type Result, err, ok } from '@rv/shared-kernel';
import type {
  AuthoredMotion,
  Behaviour,
  BehaviourId,
  BehaviourPlan,
  MotionCapabilities,
  MotionProviderKind,
  MotionRequest,
  NodeId,
} from '@rv/contracts';
import { BehaviourKind } from '@rv/contracts';

import { deriveId, deriveSeed } from './derive';
import type { MotionProvider } from './port';

export class ProceduralMotionProvider implements MotionProvider {
  readonly id: string;
  readonly kind: MotionProviderKind = 'procedural';
  /**
   * All thirteen. A future physics-backed procedural provider will declare a subset -
   * that is what the declaration is for - and this one, being closed-form arithmetic,
   * genuinely serves every kind.
   */
  readonly capabilities: MotionCapabilities = {
    channels: [],
    behaviours: [...BehaviourKind.options],
  };

  constructor(id = 'procedural') {
    this.id = id;
  }

  author(request: MotionRequest): Promise<Result<AuthoredMotion, AppError>> {
    if (request.kind !== 'procedural') {
      return Promise.resolve(err(new UnsupportedCapabilityError(this.id, request.kind)));
    }

    // Node-major, so every behaviour on one node is adjacent. That is the order the
    // evaluator buckets them into anyway, and a stable order is what keeps a re-authored
    // document a small diff.
    const behaviours: Behaviour[] = [];
    for (const nodeId of request.nodeIds) {
      request.plans.forEach((plan, index) => {
        behaviours.push(materialise(request.key, request.seed, nodeId, plan, index));
      });
    }

    return Promise.resolve(ok({ tracks: [], behaviours }));
  }
}

function materialise(
  key: string,
  rootSeed: number,
  nodeId: NodeId,
  plan: BehaviourPlan,
  index: number,
): Behaviour {
  const address = [key, plan.kind, String(index), nodeId] as const;
  return {
    ...plan,
    id: deriveId<BehaviourId>('bhv', address.join(':')),
    nodeId,
    seed: deriveSeed([rootSeed, ...address]),
  };
}
