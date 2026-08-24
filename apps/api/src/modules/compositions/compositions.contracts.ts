/**
 * Compositions the studio can actually start a render from.
 *
 * ## Why this exists at all
 *
 * `POST /api/render` and S10's run payload both take a whole `AnimationIR`, by design:
 * ADR-0001 requires a render to be reproducible from its input alone, so a request that
 * named a composition by id would render whatever that id points at *now*. That is the
 * right rule for the *render* and it left the studio unable to begin one, because
 * nothing in the browser has an `AnimationIR` and nothing in this build produces one -
 * S8 Choreograph is a stub and there are no episodes.
 *
 * So the composition is stored **by content**, and a run names it by content hash. The
 * rule survives: a hash cannot point at something else later, which is precisely the
 * property an id lacks. `POST /api/runs` accepts `compositionId` *or* an inline `ir`,
 * and S10 resolves the first into the second before it draws anything.
 *
 * ## Why not an `episodeId`
 *
 * The other option the brief allowed. It would mean the API assembling a payload from an
 * episode, and an episode has no composition until S8 runs - so today it would assemble
 * nothing, and the endpoint would be a promise rather than a capability. A composition
 * store is smaller, is honest about what it holds, and is what S8 will write into.
 */

import {
  AnimationId,
  AnimationIR,
  IsoInstant,
  Label,
  Millis,
  Sha256Hex,
  Size,
} from '@rv/contracts';
import { z } from 'zod';

export const StoreCompositionBody = z.strictObject({
  ir: AnimationIR,
  /**
   * A name for the list. Falls back to the composition's own.
   *
   * Separate from `AnimationIR.name` because the same composition can be stored for two
   * reasons - "episode 1 final" and "the cut I am comparing against" - and renaming the
   * IR would change its hash and therefore its identity.
   */
  label: Label.optional(),
});
export type StoreCompositionBody = z.infer<typeof StoreCompositionBody>;

/**
 * A stored composition, as the list screen needs it.
 *
 * The IR itself is *not* here. It is megabytes, the list shows tens of rows, and the
 * detail route serves it whole to the one caller that needs it.
 */
export const CompositionSummary = z.strictObject({
  /** `sha256` of the composition. The identity, and what a run references. */
  id: Sha256Hex,
  animationId: AnimationId,
  label: Label,
  durationMs: Millis,
  fps: z.number().positive(),
  sceneSpace: Size,
  nodeCount: z.number().int().nonnegative(),
  storedAt: IsoInstant,
});
export type CompositionSummary = z.infer<typeof CompositionSummary>;

export const CompositionList = z.strictObject({
  compositions: z.array(CompositionSummary).default([]),
});
export type CompositionList = z.infer<typeof CompositionList>;

/** The whole thing, for the one caller that renders it. */
export const StoredComposition = z.strictObject({
  summary: CompositionSummary,
  ir: AnimationIR,
});
export type StoredComposition = z.infer<typeof StoredComposition>;

export const CompositionIdParam = Sha256Hex;
