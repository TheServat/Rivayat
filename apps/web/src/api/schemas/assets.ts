/**
 * The asset registry as the studio consumes it.
 *
 * Composed from `@rv/contracts`, never restated: `Asset`, `AssetVersion`, `Part`,
 * `Rig`, `AnimationClip`, `AssetVariant`, `AssetDemandPlan`, `AssetResolution` and
 * `RegenerateIntent` are all exported upstream and are imported here as-is. What this
 * file adds is the three shapes the *screen* needs that no schema upstream describes
 * yet, and each one is a projection of contract pieces rather than a second opinion
 * about them:
 *
 * | shape                  | why it exists                                                      |
 * |------------------------|--------------------------------------------------------------------|
 * | `AssetLibraryEntry`    | the list row: counts and spend, which `Asset` carries only by walking its whole version tree |
 * | `AssetLibraryPage`     | the list envelope, with the total so the header can say how many exist |
 * | `AssetProduceReport`   | where a version stopped in the eight-step produce chain, and why    |
 *
 * ## Endpoints that do not exist yet
 *
 * Three of the five routes below are **not implemented in `apps/api`**. They are
 * declared here anyway, with the paths the controller will use, because the alternative
 * - a screen written against a different shape and re-pointed later - is how a client
 * and a server drift. `AssetsStore` treats a 404 on one of them as `unavailable`
 * rather than as an error, so the screen says which endpoint is missing instead of
 * showing a red banner about a network that is fine.
 *
 * | route                                | status | story  |
 * |--------------------------------------|--------|--------|
 * | `POST /assets/resolve`               | live   | RV-102 |
 * | `POST /assets/search`                | live   | RV-103 |
 * | `GET  /assets/:id`                   | live   | RV-102 |
 * | `GET  /assets`                       | absent | RV-208 |
 * | `POST /assets/:id/regenerate`        | absent | RV-208 |
 * | `GET  /assets/:id/versions/:vid/produce` | absent | RV-208 |
 * | `GET  /assets/demand/plan`           | absent | RV-208 |
 *
 * Two path segments on the last one is not a style choice: `AssetsController` declares
 * `@Get(':id')`, so any single segment under `/assets` is parsed as an asset id and a
 * missing collection route answers 400 rather than 404.
 */

import {
  Asset,
  AssetArchetype,
  AssetId,
  AssetKey,
  AssetKeyParts,
  AssetVersionId,
  AssetVersionStatus,
  IsoInstant,
  Label,
  NanoUsdAmount,
  NonNegativeInt,
  Prose,
  SemanticKey,
  Unit01,
} from '@rv/contracts';
import { z } from 'zod';

// ── where a take stopped ────────────────────────────────────────────────────

/**
 * The eight steps of `produce`, in the order `@rv/asset-engine` runs them.
 *
 * Restated as a plain tuple rather than imported, because `PRODUCE_STEPS` lives in
 * `@rv/asset-engine`, which is server code the studio may not import. The order is
 * load-bearing - `score` sits between `split` and `rig` because part completeness is a
 * measured input to the rubric - so it is asserted against the produce report the API
 * returns rather than trusted.
 */
export const PRODUCE_STEPS = [
  'generate',
  'matte',
  'split',
  'score',
  'rig',
  'clips',
  'bake',
  'register',
] as const;

export const ProduceStep = z.enum(PRODUCE_STEPS);
export type ProduceStep = z.infer<typeof ProduceStep>;

/**
 * One step's outcome.
 *
 * `not-reached` is a real, distinct state and not a synonym for `failed`: an asset that
 * stopped at `matte` did not fail at `rig`, it never got there, and a UI that paints
 * both red tells the user to go and look at the rig.
 */
export const ProduceStepOutcome = z.enum(['ran', 'resumed', 'failed', 'not-reached']);
export type ProduceStepOutcome = z.infer<typeof ProduceStepOutcome>;

export const ProduceStepRecord = z.strictObject({
  step: ProduceStep,
  outcome: ProduceStepOutcome,
  attempt: NonNegativeInt.default(0),
  durationMs: NonNegativeInt.default(0),
  costNanoUsd: NanoUsdAmount.default(0),
  /**
   * The diagnosis, in the engine's own words.
   *
   * "removed nothing: alpha coverage 0.9912 is above 0.98" is something a user can act
   * on - lower the threshold, change the prompt, matte by hand. "Matting failed" is
   * not. The field is prose from the engine and is shown verbatim, which is why it is
   * the one string on this screen that does not come from the catalogue.
   */
  detail: Prose.optional(),
});
export type ProduceStepRecord = z.infer<typeof ProduceStepRecord>;

/**
 * What happened to one take, step by step.
 *
 * `assetId` and `versionId` are **optional and that is the interesting case**: the
 * registry is written at step eight, so a take that stopped at step two has neither. It
 * is addressed by its dedup key and its semantic key instead, which is exactly how the
 * engine addresses it (`ProduceFailure` in `@rv/asset-engine` carries
 * `{key, semanticKey, step, error, costNanoUsd}`).
 */
export const AssetProduceReport = z.strictObject({
  key: AssetKey,
  semanticKey: SemanticKey,
  label: Label,
  assetId: AssetId.optional(),
  versionId: AssetVersionId.optional(),
  steps: z.array(ProduceStepRecord).length(PRODUCE_STEPS.length),
  /** Absent when every step ran. Present is the whole reason this shape exists. */
  failedStep: ProduceStep.optional(),
  spentNanoUsd: NanoUsdAmount.default(0),
});
export type AssetProduceReport = z.infer<typeof AssetProduceReport>;

/** The steps a report lists, in engine order, as a lookup for the trail component. */
export function stepIndex(step: ProduceStep): number {
  return PRODUCE_STEPS.indexOf(step);
}

// ── the library list ────────────────────────────────────────────────────────

/**
 * One row of the library.
 *
 * The counts are the point of the row. "Nothing is generated twice" is only visible if
 * a reader can see that an asset has four clips and two versions without opening it,
 * and computing that client-side would mean shipping every version's whole part list to
 * draw a table.
 */
export const AssetLibraryEntry = z.strictObject({
  id: AssetId,
  key: AssetKey,
  keyParts: AssetKeyParts,
  semanticKey: SemanticKey,
  archetype: AssetArchetype,
  label: Label,
  currentVersionId: AssetVersionId,
  currentStatus: AssetVersionStatus,
  versionCount: NonNegativeInt,
  variantCount: NonNegativeInt,
  clipCount: NonNegativeInt,
  partCount: NonNegativeInt,
  /** Everything every version of this asset has cost, summed. */
  spentNanoUsd: NanoUsdAmount.default(0),
  updatedAt: IsoInstant,
});
export type AssetLibraryEntry = z.infer<typeof AssetLibraryEntry>;

/**
 * The library, plus the takes that never became part of it.
 *
 * `incomplete` is not an error channel. A take that stopped at `matte` is a real thing
 * that happened, it cost real money, and it is the only place the user can learn *why*
 * the asset they asked for is not in the list. Leaving it out of the library payload
 * would mean the screen shows an absence with no explanation, which is the failure mode
 * the produce chain records its steps to prevent.
 */
export const AssetLibraryPage = z.strictObject({
  assets: z.array(AssetLibraryEntry).default([]),
  /** Total in the library, which is not `assets.length` once the list is filtered. */
  total: NonNegativeInt.default(0),
  incomplete: z.array(AssetProduceReport).default([]),
});
export type AssetLibraryPage = z.infer<typeof AssetLibraryPage>;

/** `POST /assets/search`, unwrapped by the API's result interceptor into a bare array. */
export const AssetSearchHit = z.strictObject({
  assetId: AssetId,
  key: AssetKey,
  semanticKey: SemanticKey,
  label: Label,
  similarity: Unit01,
});
export type AssetSearchHit = z.infer<typeof AssetSearchHit>;

export const AssetSearchHits = z.array(AssetSearchHit);
export type AssetSearchHits = z.infer<typeof AssetSearchHits>;

// ── regeneration ────────────────────────────────────────────────────────────

/**
 * What the server says after a deliberate second take.
 *
 * `previousVersionId` is returned as well as the new one so the screen can *show* that
 * the old version is still addressable rather than asserting it in a sentence. The
 * invariant is "a second take appends"; the evidence is two ids.
 */
export const RegenerateOutcome = z.strictObject({
  assetId: AssetId,
  previousVersionId: AssetVersionId,
  newVersionId: AssetVersionId,
  ordinal: NonNegativeInt,
  estimatedNanoUsd: NanoUsdAmount.default(0),
});
export type RegenerateOutcome = z.infer<typeof RegenerateOutcome>;

/**
 * Re-exported so a component imports every asset shape from exactly one module.
 *
 * `Asset` is the real contract schema and is not wrapped: `GET /assets/:id` returns it
 * verbatim, and re-exporting rather than aliasing keeps that visible at the import
 * site.
 */
export { Asset };
