/**
 * What `GET /api/compositions` answers with.
 *
 * The server stores an `AnimationIR` addressed by the sha256 of its own bytes and calls
 * that a *composition*, because a run references one by hash and reproducibility depends
 * on the address rather than the document's own id. The studio calls the same thing an
 * *animation*, because that is what a person opens on a timeline.
 *
 * Both names are right for their own side, so this file is the boundary between them and
 * `client.ts` does the translation. The alternative - one side adopting the other's word -
 * would make either the render pipeline talk about animations it cannot address, or the
 * timeline talk about compositions nobody authored.
 *
 * `AnimationIR` is imported from the contracts rather than restated. It is the same
 * object `evaluate(ir, t)` is typed against and the same one the renderer consumes, so a
 * document that fails the IR's refinements never reaches the player.
 */

import { AnimationIR, AnimationId, IsoInstant, Label, Sha256Hex, Size } from '@rv/contracts';
import { z } from 'zod';

export const CompositionSummary = z.strictObject({
  /** The sha256 of the composition: its identity, and what a run references. */
  id: Sha256Hex,
  animationId: AnimationId,
  label: Label,
  durationMs: z.number().int().nonnegative(),
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

export const StoredComposition = z.strictObject({
  summary: CompositionSummary,
  ir: AnimationIR,
});
export type StoredComposition = z.infer<typeof StoredComposition>;
