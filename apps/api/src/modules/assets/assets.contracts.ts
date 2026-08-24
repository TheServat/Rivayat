/**
 * Request and response shapes for the asset registry surface.
 *
 * `ResolveAssetsBody` mirrors `ResolveAssetDemandInput` field for field, because that
 * use-case's input *is* the API's input - there is no translation to do, and inventing
 * one would be a second place for the dedup key's components to drift.
 *
 * The three projections below - {@link AssetLibraryPage}, {@link AssetProduceReport} and
 * {@link RegenerateOutcome} - are not in `@rv/contracts` only because this agent may not
 * write to that package. They are field-for-field the shapes
 * `apps/web/src/api/schemas/assets.ts` validates, and both copies should collapse into
 * one upstream. `PRODUCE_STEPS` is imported from `@rv/asset-engine` rather than restated,
 * so the step order on the wire is the order the engine runs them in by construction; the
 * studio's copy is a tuple typed out by hand, and asserting the two against each other is
 * what `assets.contracts.spec.ts` does.
 */

import {
  AssetArchetype,
  AssetId,
  AssetKey,
  AssetKeyParts,
  AssetSpec,
  AssetVersionId,
  AssetVersionStatus,
  IsoInstant,
  Label,
  NanoUsdAmount,
  NonNegativeInt,
  ProjectId,
  Prose,
  RegenerateIntent,
  SemanticKey,
  Sha256Hex,
  Slug,
  StyleBibleId,
} from '@rv/contracts';
import { PRODUCE_STEPS } from '@rv/asset-engine';
import { z } from 'zod';

export const ResolveAssetsBody = z.object({
  specs: z.array(AssetSpec).min(1).max(512),
  styleBibleId: StyleBibleId,
  styleChecksum: Sha256Hex.describe(
    'The locked style checksum. Change it and every spec in the list misses - which is ' +
      'the point: a restyle forks the library rather than silently mismatching.',
  ),
  variantKey: Slug.optional(),
  budgetNanoUsd: NanoUsdAmount.optional(),
  confirmationThresholdNanoUsd: NanoUsdAmount.optional(),
});
export type ResolveAssetsBody = z.infer<typeof ResolveAssetsBody>;

export const SearchAssetsBody = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
  minSimilarity: z.number().min(0).max(1).optional(),
});
export type SearchAssetsBody = z.infer<typeof SearchAssetsBody>;

export const AssetIdParam = AssetId;

// ── the library, as the Assets screen renders it ────────────────────────────

export const ListAssetsQuery = z.object({
  /**
   * Free text over the semantic key, the label and the description.
   *
   * A substring filter and deliberately **not** the semantic search on
   * `POST /assets/search`: that one embeds the query, which is a provider call, and a
   * list box that searched semantically would bill for every keystroke.
   */
  query: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ListAssetsQuery = z.infer<typeof ListAssetsQuery>;

/**
 * One row of the library.
 *
 * The counts are the point of the row. "Nothing is generated twice" is only visible if
 * a reader can see that an asset has four clips and two versions without opening it,
 * and computing that client-side means shipping every version's whole part list to draw
 * a table.
 *
 * `keyParts` comes from the `assets` table rather than from the `Asset` document,
 * because `Asset` in `@rv/contracts` carries the composite key and not its four
 * components - and the components are the only thing you can diff when a cache miss
 * happens that should not have.
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
  /** Everything every version of this asset has cost, summed from its provenance. */
  spentNanoUsd: NanoUsdAmount.default(0),
  updatedAt: IsoInstant,
});
export type AssetLibraryEntry = z.infer<typeof AssetLibraryEntry>;

// ── where a take stopped ────────────────────────────────────────────────────

/** The eight steps of produce, in the order `@rv/asset-engine` runs them. */
export const ProduceStep = z.enum(PRODUCE_STEPS);
export type ProduceStep = z.infer<typeof ProduceStep>;

/**
 * One step's outcome.
 *
 * `not-reached` is a real, distinct state and not a synonym for `failed`: an asset that
 * stopped at `matte` did not fail at `rig`, it never got there, and a UI that paints
 * both red sends the user to look at the rig.
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
   * on - lower the threshold, change the prompt, matte by hand. "Matting failed" is not.
   * Shown verbatim, which is why it is the one string on the screen that does not come
   * from a message catalogue.
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
 * engine addresses it - `ProduceFailure` carries `{key, semanticKey, step, error, cost}`.
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

/**
 * The library, plus the takes that never became part of it.
 *
 * `incomplete` is not an error channel. A take that stopped at `matte` is a real thing
 * that happened, it cost real money, and it is the only place a user can learn *why* the
 * asset they asked for is not in the list. Leaving it out would mean the screen shows an
 * absence with no explanation, which is the failure mode the produce chain records its
 * steps to prevent.
 */
export const AssetLibraryPage = z.strictObject({
  assets: z.array(AssetLibraryEntry).default([]),
  /** Total in the library, which is not `assets.length` once the list is filtered. */
  total: NonNegativeInt.default(0),
  incomplete: z.array(AssetProduceReport).default([]),
});
export type AssetLibraryPage = z.infer<typeof AssetLibraryPage>;

// ── regeneration ────────────────────────────────────────────────────────────

/**
 * What the server says after a deliberate second take.
 *
 * `previousVersionId` is returned as well as the new one so a client can *show* that the
 * old version is still addressable rather than assert it in a sentence. The invariant is
 * "a second take appends"; the evidence is two ids and two ordinals.
 */
export const RegenerateOutcome = z.strictObject({
  assetId: AssetId,
  previousVersionId: AssetVersionId,
  newVersionId: AssetVersionId,
  ordinal: NonNegativeInt,
  estimatedNanoUsd: NanoUsdAmount.default(0),
});
export type RegenerateOutcome = z.infer<typeof RegenerateOutcome>;

export const AssetVersionIdParam = AssetVersionId;

/**
 * The regenerate body: a `RegenerateIntent`, plus who is paying.
 *
 * `RegenerateIntent` is spread rather than nested, because that is the shape the studio
 * already sends (`StudioApi.regenerateAsset` posts the intent as the whole body) and
 * because the intent *is* the request - the two extra fields are about the ledger, not
 * about the take.
 *
 * **`projectId` is optional and should not be.** An asset belongs to the library, which
 * is project-wide; money belongs to a project, because `CostMeter` is constructed per
 * project and `usage_records.run_id` hangs off a run that names one. So a regeneration
 * genuinely needs to know whose budget it is spending. It is optional here only so that
 * the screen as built today keeps working: when it is absent the use-case uses the sole
 * project if there is exactly one, and **refuses by name** when there are none or
 * several rather than picking. The studio should start sending it.
 */
export const RegenerateAssetBody = RegenerateIntent.extend({
  projectId: ProjectId.optional(),
  budgetNanoUsd: NanoUsdAmount.optional().describe(
    'Ceiling for this one take. Absent inherits the project and machine layers.',
  ),
});
export type RegenerateAssetBody = z.infer<typeof RegenerateAssetBody>;
