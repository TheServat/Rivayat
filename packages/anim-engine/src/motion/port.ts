/**
 * The `MotionProvider` port.
 *
 * One method, because there is one job: turn a request into tracks and behaviours. The
 * shapes on both sides live in `@rv/contracts` (`anim/motion.ts`, which carries the
 * reasoning); what is declared here is the interface itself, in the application layer
 * that consumes it, so that an adapter can be written against it without core ever
 * importing the adapter.
 *
 * ## Why `author` is asynchronous when both of today's providers are synchronous
 *
 * Because the *next* one is not. A physics bake runs a solver, a mocap import reads a
 * file and a model proposing keyframes is a network call, and a port shaped around
 * today's two implementations would have to change for the third - which is the shape of
 * a leaky abstraction.
 *
 * It also does real work here. `evaluate(ir, t)` is **synchronous**, and a synchronous
 * function cannot await an asynchronous one. So "a provider may not be consulted at
 * evaluation time" is not only a rule and a test; it is a type error.
 */

import type { AppError, Result } from '@rv/shared-kernel';
import type {
  AuthoredMotion,
  MotionCapabilities,
  MotionProviderKind,
  MotionRequest,
} from '@rv/contracts';

export interface MotionProvider {
  /**
   * Stable identifier, and the registry key.
   *
   * Per instance rather than per kind, because two procedural providers - the pure one
   * and a future physics-backed one - are two different propositions and a router that
   * cannot tell them apart cannot be asked for a particular one.
   */
  readonly id: string;
  readonly kind: MotionProviderKind;
  /**
   * What this instance can actually author.
   *
   * A claim, checked at registration against what the request needs. An adapter that
   * declares a behaviour it cannot produce is a routing hole, which is the whole reason
   * the declaration is separate from the implementation.
   */
  readonly capabilities: MotionCapabilities;

  /**
   * Authors motion for the whole request. Never for one instant.
   *
   * The result is written into an `AnimationIR` and content-hashed, at which point
   * whether this provider was deterministic stops mattering - the artefact is what
   * replays. That is the entire trade ADR-0008 makes, and it is what a provider that
   * *cannot* bake fails: there is nothing to hash.
   */
  author(request: MotionRequest): Promise<Result<AuthoredMotion, AppError>>;
}
