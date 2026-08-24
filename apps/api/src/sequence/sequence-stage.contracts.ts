/**
 * What S7 needs on a run's payload.
 *
 * The interesting field is the one that is **not** here: `safeArea`. `solveSafeArea` in
 * `@rv/story-engine` computes the intersection of every centred maximal crop from the
 * canvas and the delivery aspects, and the exact rectangle it emits is pinned at both
 * ends of a seam - `story-engine/src/shots/safe-area-contract.spec.ts` records the
 * figures and `render-engine/src/reframe/shot-list-seam.spec.ts` asserts they solve for
 * every delivery format. An override is allowed by the engine (for a shot list with a
 * burned-in caption rail) and is deliberately not exposed on this payload: a run that set
 * it would hand the reframer a rectangle nothing had checked, and the failure would show
 * up as a crop that quietly loses a face rather than as a test.
 *
 * The camera grammar and the frame rate come from the **style bible** rather than from
 * the payload, because they are style: `MotionStyle.camera.cutRhythm` decides how long a
 * shot is and `MotionStyle.fps` decides what a duration rounds to. A payload that carried
 * them would let one run cut like a paper-cutout series and the next cut like a painterly
 * one under the same style.
 */

import {
  DELIVERY_ASPECTS,
  DeliveryAspect,
  DialogueLine,
  EntityId,
  AssetId,
  AssetVersionId,
  Label,
  Scene,
  Size,
  Slug,
  StyleBibleId,
  VariantId,
} from '@rv/contracts';
import { z } from 'zod';

/** Depth bands, as `@rv/story-engine` names them. Paint order follows: background first. */
export const LayerBand = z.enum(['background', 'midground', 'foreground']);
export type LayerBand = z.infer<typeof LayerBand>;

/**
 * One asset that already exists and may be placed in this scene.
 *
 * Supplied by the caller because by S7 the assets are real: S5 resolved the demand and S6
 * produced the misses. The shot list is where they are staged, not where they are
 * invented - and pinning the concrete `assetVersionId` here is what makes a re-render of
 * a shot reproduce that shot.
 *
 * `clipVocabulary` is what the asset's rig actually registers. A blocking action naming a
 * clip outside this list fails in the engine, with the shot to point at, rather than at
 * choreograph time with a stack trace.
 */
export const ScenePlaceable = z.strictObject({
  instance: Slug.describe('The shot-local handle the director will use, e.g. `kael-left`.'),
  label: Label,
  assetId: AssetId,
  assetVersionId: AssetVersionId,
  variantId: VariantId.optional(),
  entityRef: EntityId.optional().describe('The entity this artwork depicts, when it depicts one.'),
  band: LayerBand,
  clipVocabulary: z.array(Slug).max(64).default([]),
});
export type ScenePlaceable = z.infer<typeof ScenePlaceable>;

export const SequenceStageRequest = z.object({
  scene: Scene,
  sceneDurationMs: z
    .number()
    .int()
    .positive()
    .describe('How long this scene runs. The shot durations will sum to exactly this.'),
  styleBibleId: StyleBibleId.optional().describe(
    'Supplies the camera grammar and the frame rate. Absent falls back to the bible S1 ' +
      'established earlier in this run.',
  ),
  masterAspect: DeliveryAspect.default('16:9'),
  deliverables: z
    .array(DeliveryAspect)
    .min(1)
    .max(DELIVERY_ASPECTS.length)
    .default([...DELIVERY_ASPECTS])
    .describe('Every aspect the series ships. Drives the solved safe area.'),
  canvas: Size.describe(
    'The authoring canvas. Compose it wider and taller than any single deliverable needs.',
  ),
  placeables: z.array(ScenePlaceable).min(1).max(64),
  dialogue: z.array(DialogueLine).max(256).default([]),
});
export type SequenceStageRequest = z.infer<typeof SequenceStageRequest>;
