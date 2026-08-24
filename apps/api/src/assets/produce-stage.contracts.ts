/**
 * What S6 needs on a run's payload.
 *
 * `specs` is the only required field. The style is the other half of the dedup key, and
 * it is optional only because a `[style, produce]` run cannot name a bible S1 has not
 * created yet: absent, the stage takes the one S1 recorded on the run. Everything else
 * has a default, and the defaults are chosen so that a payload of `{specs}` is a *safe*
 * run - it plans, it prices, and it stops.
 *
 * **`approved` defaults to false, and that is the whole of non-negotiable #3 on this
 * stage.** `AssetDemandPlan.requiresConfirmation` defaults to "any spend at all is
 * confirmed", so a payload that omitted approval and was treated as consent would spend
 * money nobody was shown a number for. The engine returns the plan and calls no provider
 * in that case; the stage fails with the estimate rather than succeeding with nothing.
 *
 * `specs` are carried on the payload rather than read from a store because S4 - the
 * stage that invents them - is not this workstream's, and a stage that invented its own
 * demand would be guessing at what the episode needs. When S4 lands, this is the field it
 * fills.
 */

import { AssetSpec, NanoUsdAmount, Slug, StyleBibleId } from '@rv/contracts';
import { DEFAULT_CONCURRENCY } from '@rv/asset-engine';
import { z } from 'zod';

export const ProduceBakePlan = z.object({
  /**
   * Which clips to bake to a sprite sheet. `'all'` bakes the archetype's whole set.
   *
   * `['idle']` by default, and an empty list is a real answer: a sheet is a *derived*
   * artefact, rebuildable from the clip at any time, so baking none costs nothing later.
   */
  clips: z.union([z.literal('all'), z.array(Slug).max(64)]).default(['idle']),
  frames: z.number().int().min(1).max(240).default(8),
});
export type ProduceBakePlan = z.infer<typeof ProduceBakePlan>;

export const ProduceStageRequest = z.object({
  specs: z.array(AssetSpec).min(1).max(512),
  styleBibleId: StyleBibleId.optional().describe(
    'The style to generate against. Must be locked: `assertUsableForGeneration` is the ' +
      'one guard in front of every image generation, and it refuses a draft. Absent falls ' +
      'back to the bible S1 established earlier in this run - see `style/style-artifacts.ts`.',
  ),
  variantKey: Slug.optional(),
  approved: z
    .boolean()
    .default(false)
    .describe(
      'The human "yes" to the estimate. Absent is refusal, not permission: the stage ' +
        'returns the plan and calls no provider.',
    ),
  confirmationThresholdNanoUsd: NanoUsdAmount.optional().describe(
    'Spend below which no approval is needed. Absent means zero - any spend is confirmed.',
  ),
  /**
   * Defaults to two, because the local lane is one 6 GB card.
   *
   * Research §2 measured 1024² at 95 % of the card, so a second concurrent generation at
   * that size does not fit and twelve are slower than two. The engine owns the number;
   * this only lets an operator with a bigger card raise it.
   */
  concurrency: z.number().int().min(1).max(16).default(DEFAULT_CONCURRENCY),
  bake: ProduceBakePlan.prefault({}),
});
export type ProduceStageRequest = z.infer<typeof ProduceStageRequest>;
