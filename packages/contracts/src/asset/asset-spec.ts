/**
 * What to make, and the key that decides whether it already exists.
 *
 * The product requirement is blunt: *nothing is generated twice unless we say so*.
 * That reduces to one thing being exactly right - the dedup key. It is built from
 * everything that changes the output and nothing that does not:
 *
 *     key = hash(semanticKey ‖ styleChecksum ‖ variantKey ‖ specHash)
 *
 * `semanticKey` is what the thing *is*, `styleChecksum` is how the world looks,
 * `variantKey` is which flavour, and `specHash` covers the rest of the request. Two
 * episodes asking for the same oak tree in the same style therefore hit the same key
 * and the second one costs nothing.
 */

import { z } from 'zod';

import { AssetId, AssetVersionId, StyleBibleId } from '../primitives/ids';
import {
  Label,
  NanoUsdAmount,
  NonEmptyString,
  NonNegativeInt,
  PositivePixels,
  Prose,
  SemanticKey,
  Sha256Hex,
  Size,
  Slug,
  StoryInterval,
  Tags,
  Unit01,
  Vec2,
} from '../primitives/common';
import { SubjectClass } from '../style/style-bible';

/**
 * What kind of thing this is, mechanically.
 *
 * Chosen for **how it rigs and moves**, not for what it depicts: a bird and a bat are
 * both `winged`, a cart and a bicycle are both `wheeled`. The archetype selects the
 * rig template and the motion preset library, so it is the single most consequential
 * field on a spec.
 */
export const AssetArchetype = z.enum([
  'biped',
  'quadruped',
  'winged',
  'serpentine',
  'multi-limbed',
  'tree',
  'shrub',
  'grass',
  'cloud',
  'water',
  'fire',
  'wheeled',
  'door-hinged',
  'cloth',
  'rigid-prop',
  'articulated-prop',
  'crowd',
  'particle-fx',
  'backdrop',
  'ui-element',
]);
export type AssetArchetype = z.infer<typeof AssetArchetype>;

/**
 * A named piece of the asset, requested up front.
 *
 * We ask the image model for parts *by design* rather than trying to cut a finished
 * render apart afterwards (see research §3). Naming them in the spec is what lets the
 * rig template bind to them automatically once they come back.
 */
export const PartPlan = z.object({
  name: Slug.describe('Stable machine name, e.g. "wing-left"'),
  role: Slug.describe('Rig role this part fulfils; matched against the archetype template'),
  description: NonEmptyString.describe('What to draw for this part, in the style of the bible'),
  /** Painting order within the asset. Higher draws in front. */
  zOrder: z.number().int(),
  /**
   * Where this part attaches to its parent, in the parent's normalised space.
   * Supplying it up front beats inferring it from alpha, which guesses wrong on
   * symmetrical shapes.
   */
  attachHint: Vec2.optional(),
  parent: Slug.optional().describe('Name of the part this hangs off, if any'),
  deformable: z.boolean().default(false).describe('Needs a mesh, not just a transform'),
  optional: z.boolean().default(false).describe('Absence is acceptable, not a failure'),
});
export type PartPlan = z.infer<typeof PartPlan>;

/**
 * A flavour of an asset that is an *edit*, not a new generation.
 *
 * Winter foliage, a damaged hull, a night-lit window. Produced by image editing from
 * the base version at a fraction of the cost, and keyed separately so it caches too.
 */
export const VariantSpec = z.object({
  key: Slug.describe('Stable variant name, e.g. "winter" or "damaged"'),
  label: Label,
  instruction: NonEmptyString.describe('Edit instruction applied to the base image'),
  /** When this variant is the correct one to serve, in story time. */
  validity: StoryInterval.optional(),
  /** Parts this edit touches; the rest are reused byte-for-byte. */
  affectedParts: z.array(Slug).default([]),
});
export type VariantSpec = z.infer<typeof VariantSpec>;

/**
 * How good this artefact has to be.
 *
 * The same three words as `QualityTier` in `provider/capability.ts`, and deliberately a
 * separate schema: this one is a property of the *artefact* - what fidelity an asset
 * was generated at, recorded on the version forever - while `QualityTier` is a property
 * of one *call*, the input the router uses to pick between the free local lane and the
 * paid cloud lane. A `final` asset can be re-derived by a `draft` call, so collapsing
 * them would make one field mean two things.
 *
 * They must nonetheless offer the same choices, because the tier a call is routed at is
 * chosen from the target the spec asked for. Nothing structural holds them in
 * lock-step, so `asset.spec.ts` asserts it: "the asset quality target and the provider
 * quality tier offer the same three levels".
 */
export const QualityTarget = z.enum(['draft', 'preview', 'final']);
export type QualityTarget = z.infer<typeof QualityTarget>;

/** A reference image passed to the model to hold identity or style steady. */
export const AssetReference = z.object({
  imageHash: Sha256Hex,
  role: z.enum(['style-anchor', 'identity-anchor', 'pose-guide', 'palette-guide', 'avoid']),
  weight: Unit01.default(1),
});
export type AssetReference = z.infer<typeof AssetReference>;

export const AssetSpec = z.object({
  semanticKey: SemanticKey,
  archetype: AssetArchetype,
  subjectClass: SubjectClass.describe('Selects the style bible prompt fragment'),

  label: Label,
  description: Prose.describe('What the image model should draw, before style is applied'),
  tags: Tags,

  /** Canvas the parts are drawn into. Parts are positioned in this space. */
  canvas: Size.default({ width: 1024, height: 1024 }),
  /** Nominal on-screen height in scene units, so scale is consistent across assets. */
  nominalHeight: PositivePixels.default(512),

  parts: z
    .array(PartPlan)
    .min(1)
    .describe('At least one part. A single-part asset is still animatable via mesh deform'),

  variants: z.array(VariantSpec).default([]),
  references: z.array(AssetReference).default([]),

  quality: QualityTarget.default('preview'),
  /** Force transparency. Almost always true; false only for full-frame backdrops. */
  requireAlpha: z.boolean().default(true),
});
export type AssetSpec = z.infer<typeof AssetSpec>;

/**
 * The four components of the dedup key, kept as data so the key is auditable.
 *
 * When a cache miss happens unexpectedly this is what you diff to find out which
 * component moved.
 */
export const AssetKeyParts = z.object({
  semanticKey: SemanticKey,
  styleChecksum: Sha256Hex,
  variantKey: Slug.default('base'),
  /** Content hash of the `AssetSpec` minus the fields already named above. */
  specHash: Sha256Hex,
});
export type AssetKeyParts = z.infer<typeof AssetKeyParts>;

/** The resolved key itself. */
export const AssetKey = Sha256Hex.brand<'AssetKey'>();
export type AssetKey = z.infer<typeof AssetKey>;

/**
 * Why we are deliberately spending money on something we may already have.
 *
 * Required to bypass the cache. Regeneration always creates a *new* `AssetVersion`;
 * previous versions are never destroyed, so "give me another take" is non-destructive
 * and reversible.
 */
export const RegenerateIntent = z.object({
  reason: z.enum([
    'new-take',
    'style-changed',
    'quality-reject',
    'spec-changed',
    'manual-override',
  ]),
  note: Prose.optional(),
  /** Which version to branch from, when the reason is an edit rather than a fresh take. */
  basedOn: AssetVersionId.optional(),
  /** Always true. Present as a field so an attempt to set it false is a visible diff. */
  keepPrevious: z.literal(true).default(true),
});
export type RegenerateIntent = z.infer<typeof RegenerateIntent>;

/**
 * The answer to "do we already have this?", computed before anything is spent.
 *
 * `estimatedCostNanoUsd` covers only the misses - that number is what the user is
 * shown and asked to approve.
 */
export const AssetResolution = z.object({
  key: AssetKey,
  spec: AssetSpec,
  outcome: z.enum(['cache-hit', 'variant-of-hit', 'miss', 'blocked-by-budget']),
  existingAssetId: AssetId.optional(),
  existingVersionId: AssetVersionId.optional(),
  styleBibleId: StyleBibleId,
  estimatedCostNanoUsd: NanoUsdAmount.default(0),
  reason: Prose.optional().describe('Why this resolved the way it did; shown in the UI'),
});
export type AssetResolution = z.infer<typeof AssetResolution>;

/** What an episode needs, resolved in bulk so the cost is known before the run starts. */
export const AssetDemandPlan = z.object({
  resolutions: z.array(AssetResolution),
  hitCount: NonNegativeInt,
  missCount: NonNegativeInt,
  totalEstimatedNanoUsd: NanoUsdAmount,
  requiresConfirmation: z.boolean().default(false),
});
export type AssetDemandPlan = z.infer<typeof AssetDemandPlan>;
