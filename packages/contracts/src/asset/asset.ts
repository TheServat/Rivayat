/**
 * The stored asset: identity, versions, variants, clips and baked sheets.
 *
 * The shape encodes the product rule directly:
 *
 *     Asset (identity, keyed by semanticKey + style)
 *      └─ AssetVersion   - "a different take". Added, never replaced.
 *          ├─ Part[]     - transparent layers, named and z-ordered
 *          ├─ Rig        - fitted from the archetype template
 *          ├─ Variant[]  - cheap edits (winter, damaged, night-lit)
 *          └─ Clip[]     - procedural motion, optionally baked to a sprite sheet
 *
 * Nothing here is mutable after it is written. A change produces a new version and
 * the old one stays addressable, which is what makes "regenerate" safe and what lets
 * episode 2 keep rendering after episode 6 restyles the world.
 */

import { z } from 'zod';

import {
  AssetId,
  AssetVersionId,
  ClipId,
  PartId,
  SheetId,
  StyleBibleId,
  VariantId,
} from '../primitives/ids';
import {
  IsoInstant,
  Label,
  NonNegativeInt,
  PositivePixels,
  Prose,
  Provenance,
  Rect,
  SemanticKey,
  Sha256Hex,
  Size,
  Slug,
  StoryInterval,
  Tags,
  Unit01,
  Vec2,
  checkEmbeddingPair,
  embeddingShape,
} from '../primitives/common';
import { AssetArchetype, AssetKey, QualityTarget } from './asset-spec';
import {
  AssetRepresentation,
  RepresentationKind,
  findRepresentation,
  type FlatRepresentation,
} from './representation';
import { Rig } from './rig';

// ── parts ───────────────────────────────────────────────────────────────────

/**
 * One transparent layer of an asset.
 *
 * `imageHash` addresses the pixels in the content-addressed store; the part record
 * itself carries only geometry. Two assets that happen to share an identical layer
 * therefore share the bytes on disk.
 */
export const Part = z.object({
  id: PartId,
  name: Slug,
  role: Slug.describe('Rig role this part binds to'),
  imageHash: Sha256Hex,
  /** Where the part sits inside the asset canvas, in pixels. */
  bounds: Rect,
  size: Size,
  /** Rotation centre in the part's own normalised space. */
  pivot: Vec2.default({ x: 0.5, y: 0.5 }),
  zOrder: z.number().int(),
  deformable: z.boolean().default(false),
  /**
   * Fraction of the bounding box that is not fully transparent.
   *
   * A quality signal: a "wing" that covers 2 % of its box is almost certainly a
   * matting failure, and the QA gate rejects it before it reaches a rig.
   */
  alphaCoverage: Unit01,
});
export type Part = z.infer<typeof Part>;

// ── clips and sheets ────────────────────────────────────────────────────────

export const LoopMode = z.enum(['once', 'loop', 'ping-pong', 'hold-last']);
export type LoopMode = z.infer<typeof LoopMode>;

/**
 * A baked sprite sheet.
 *
 * Explicitly a **derived artefact**: rendered from a clip on demand, cached in the
 * content store, and rebuildable at any time. It is never the source of truth, which
 * is why re-timing or restyling a clip does not require regenerating any imagery.
 */
export const SpriteSheet = z.object({
  id: SheetId,
  clipId: ClipId,
  atlasImageHash: Sha256Hex,
  atlasJsonHash: Sha256Hex,
  frameCount: z.number().int().min(1),
  fps: z.number().int().min(1).max(120),
  frameSize: Size,
  atlasSize: Size,
  /** Per-frame source rect in the atlas, plus the trim offset that was removed. */
  frames: z.array(z.object({ rect: Rect, trimOffset: Vec2.default({ x: 0, y: 0 }) })).min(1),
  trimmed: z.boolean().default(true),
  padding: NonNegativeInt.default(2),
  createdAt: IsoInstant,
});
export type SpriteSheet = z.infer<typeof SpriteSheet>;

export const ClipSource = z.enum(['template', 'authored', 'llm-choreographed', 'imported']);
export type ClipSource = z.infer<typeof ClipSource>;

/**
 * One named motion an asset can perform.
 *
 * The motion itself lives in an `AnimationIR` fragment addressed by `irHash` - the
 * clip record is the index entry. Storing the IR by content hash means two assets
 * that share a generated `idle` share it on disk, and means a clip can be diffed.
 */
export const AnimationClip = z.object({
  id: ClipId,
  name: Slug.describe('e.g. "idle", "walk", "flap", "sway", "talk-a"'),
  label: Label.optional(),
  source: ClipSource,
  durationMs: z.number().int().positive(),
  fps: z.number().int().min(1).max(120),
  loop: LoopMode.default('loop'),
  /** Content hash of the `AnimationIR` fragment that defines this motion. */
  irHash: Sha256Hex,
  /** Present once the clip has been baked. Absent is normal, not an error. */
  bakedSheetId: SheetId.optional(),
  tags: Tags,
  provenance: Provenance,
});
export type AnimationClip = z.infer<typeof AnimationClip>;

// ── variants ────────────────────────────────────────────────────────────────

/**
 * A flavour produced by editing, not by regenerating.
 *
 * Only `replacedParts` differ from the base version; everything else is reused
 * byte-for-byte, which is why a seasonal or damaged variant costs a fraction of a
 * fresh take and why the rig and clips carry straight over.
 */
export const AssetVariant = z.object({
  id: VariantId,
  key: Slug,
  label: Label,
  /** Parts overridden by this variant, keyed by part name. */
  replacedParts: z.record(Slug, Sha256Hex),
  /** When this variant is the correct one to serve, in story time. */
  validity: StoryInterval.optional(),
  provenance: Provenance,
});
export type AssetVariant = z.infer<typeof AssetVariant>;

// ── versions ────────────────────────────────────────────────────────────────

/**
 * Automated quality scores from the vision gate.
 *
 * Recorded rather than merely thresholded, so a rejected take can be compared against
 * the accepted one and the thresholds themselves can be tuned against real data.
 */
export const QualityScores = z.object({
  styleMatch: Unit01,
  alphaCleanliness: Unit01.describe('Absence of halos and fringing at the cutout edge'),
  silhouetteReadability: Unit01,
  identityMatch: Unit01.optional().describe('Against identity anchors; characters only'),
  partCompleteness: Unit01.describe('Fraction of planned parts that came back usable'),
  overall: Unit01,
});
export type QualityScores = z.infer<typeof QualityScores>;

export const AssetVersionStatus = z.enum([
  'generating',
  'matting',
  'rigging',
  'ready',
  'rejected',
  'failed',
]);
export type AssetVersionStatus = z.infer<typeof AssetVersionStatus>;

export const AssetVersion = z
  .object({
    id: AssetVersionId,
    assetId: AssetId,
    /** 1-based, monotonic within the asset. Version N+1 never replaces version N. */
    ordinal: z.number().int().positive(),
    status: AssetVersionStatus,

    styleBibleId: StyleBibleId,
    styleChecksum: Sha256Hex,

    parts: z.array(Part).min(1),
    rig: Rig.optional().describe('Absent while the version is still being rigged'),
    variants: z.array(AssetVariant).default([]),
    clips: z.array(AnimationClip).default([]),
    /**
     * What this version can be served as. See `representation.ts`.
     *
     * **Optional, and absent is a real state** rather than a shrug: every version
     * written before representations existed has none, and the honest answer for those
     * is not "assume cutout" - it is to read what the version actually holds. That is
     * what {@link representationsOf} does, and it is the only thing that should ever
     * answer this question, because two places deciding what an undeclared version is
     * would disagree exactly once and produce a wrong bitmap.
     *
     * At most one per kind: a representation is a *way of drawing this version*, and
     * two answers to "draw it as a cutout" is a choice nothing downstream could make.
     */
    representations: z
      .array(AssetRepresentation)
      .optional()
      .describe('Declared representations. Absent means "derive from the parts and rig".'),

    canvas: Size,
    nominalHeight: PositivePixels,
    /** Flattened preview of the assembled parts, for library thumbnails. */
    previewImageHash: Sha256Hex.optional(),

    quality: QualityTarget,
    scores: QualityScores.optional(),
    rejectionReason: Prose.optional(),

    provenance: Provenance,
  })
  .superRefine((version, ctx) => {
    // A version is the only place that holds the parts, the rig and the variants at
    // once, so it is the only place that can check they agree. The rig validates its own
    // skeleton but has never seen the part list, and a variant names parts by their slug
    // with nothing to resolve them against - so a bone bound to a part that was dropped
    // during matting, or a `winter` variant replacing a part this version never had,
    // both validate cleanly today and surface as a missing layer in a finished frame.
    const partIds = new Set(version.parts.map((part) => part.id));
    version.rig?.bones.forEach((bone, index) => {
      for (const partId of bone.partIds) {
        if (!partIds.has(partId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['rig', 'bones', index, 'partIds'],
            message: `bone ${bone.name} binds part ${partId}, which this version does not have`,
          });
        }
      }
    });

    const partNames = new Set(version.parts.map((part) => part.name));
    version.variants.forEach((variant, index) => {
      for (const name of Object.keys(variant.replacedParts)) {
        if (!partNames.has(name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['variants', index, 'replacedParts', name],
            message: `variant ${variant.key} replaces part "${name}", which this version does not have`,
          });
        }
      }
    });

    // The same reasoning one level along: a representation names parts and a rig with
    // nothing local to resolve them against, so a `cutout` that binds a part matting
    // dropped, or that names a rig this version was never fitted with, validates
    // cleanly and surfaces as a missing layer in a finished frame.
    const declared = version.representations ?? [];
    const seen = new Set<string>();
    declared.forEach((representation, index) => {
      if (seen.has(representation.kind)) {
        ctx.addIssue({
          code: 'custom',
          path: ['representations', index, 'kind'],
          message: `this version declares ${representation.kind} twice`,
        });
      }
      seen.add(representation.kind);

      if (representation.kind !== 'cutout') return;
      if (version.rig?.id !== representation.rigId) {
        ctx.addIssue({
          code: 'custom',
          path: ['representations', index, 'rigId'],
          message: `cutout representation names rig ${representation.rigId}, which is not this version's rig`,
        });
      }
      for (const partId of representation.partIds) {
        if (!partIds.has(partId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['representations', index, 'partIds'],
            message: `cutout representation draws part ${partId}, which this version does not have`,
          });
        }
      }
    });
  });

/**
 * What this version can be served as, whether or not it says so.
 *
 * The migration bridge, and the *only* place an undeclared version is interpreted. It
 * derives rather than assumes: a version with a rig can be served as a cutout because
 * it has one, and a version with a flattened preview can be served flat because those
 * are the pixels. A version with neither gets an empty list, which is the correct and
 * useful answer - the router will refuse to place it rather than draw the wrong thing.
 *
 * Once a producer declares representations, this returns exactly what was declared and
 * derives nothing. That is the whole point: the derivation is a bridge over versions
 * written before the field existed, not a permanent second opinion.
 */
export function representationsOf(version: AssetVersion): readonly AssetRepresentation[] {
  if (version.representations !== undefined) return version.representations;

  const derived: AssetRepresentation[] = [];
  const rig = version.rig;
  if (rig !== undefined) {
    derived.push({ kind: 'cutout', rigId: rig.id, partIds: version.parts.map((part) => part.id) });
  }
  const preview = version.previewImageHash;
  if (preview !== undefined) {
    const flat: FlatRepresentation = {
      kind: 'flat',
      imageHash: preview,
      size: version.canvas,
      pivot: { x: 0.5, y: 0.5 },
    };
    derived.push(flat);
  }
  return derived;
}

/** Whether this version can be drawn the way a reference asks for. */
export function servesRepresentation(version: AssetVersion, kind: RepresentationKind): boolean {
  return findRepresentation(representationsOf(version), kind) !== null;
}
export type AssetVersion = z.infer<typeof AssetVersion>;

// ── identity ────────────────────────────────────────────────────────────────

/**
 * An asset's identity, and the semantic handle the registry finds it by.
 *
 * The embedding is **domain data, not a storage detail**. "A gnarled old tree" has to
 * find `flora/oak-tree/mature` *before* anything decides to generate one - that lookup
 * is the mechanism behind non-negotiable #2 ("no asset is generated twice") and the $0
 * second run, not a search convenience bolted on afterwards. An asset that cannot be
 * found semantically will be regenerated, and the money is spent before anyone notices.
 *
 * So the vector lives here, next to the text it was derived from (`semanticKey`,
 * `label`, `description`, `tags`), the same way `EntityEnvelope` carries one - plus the
 * model that produced it, because a vector nobody can attribute cannot be compared
 * against the next one. See `embeddingShape` for why that pairing is enforced rather
 * than assumed.
 *
 * Both halves are absent until the indexing pass has run. That is a real state: an
 * asset exists the moment its first version is written, and embedding it is a separate
 * pass that may not have happened yet.
 */
export const Asset = z
  .object({
    id: AssetId,
    /** The dedup key. Unique across the whole library. */
    key: AssetKey,
    semanticKey: SemanticKey,
    archetype: AssetArchetype,
    label: Label,
    description: Prose,
    tags: Tags,

    versions: z.array(AssetVersion).min(1),
    /** Which version is served when nothing more specific is asked for. */
    currentVersionId: AssetVersionId,

    ...embeddingShape,

    createdAt: IsoInstant,
    updatedAt: IsoInstant,
  })
  .refine((asset) => asset.versions.some((version) => version.id === asset.currentVersionId), {
    message: 'currentVersionId must reference one of this asset’s versions',
    path: ['currentVersionId'],
  })
  .refine(
    (asset) =>
      new Set(asset.versions.map((version) => version.ordinal)).size === asset.versions.length,
    { message: 'version ordinals must be unique', path: ['versions'] },
  )
  .superRefine(checkEmbeddingPair);
export type Asset = z.infer<typeof Asset>;

/**
 * The **authoring-time** reference to an asset. Floating by design.
 *
 * Deliberately indirect: it names the asset and *optionally* pins a version and a
 * variant. Leaving `versionId` out means "whatever is current", which is what lets an
 * upgraded asset propagate to every reference that did not deliberately freeze it.
 *
 * That is exactly the property a render must not have. A re-render has to be
 * bit-reproducible (CLAUDE.md non-negotiable #1) and "the current version" is not
 * something a replay can resolve, so nothing downstream of compilation may hold one of
 * these. The two forms are:
 *
 * | Stage      | Shape                                     | `versionId` |
 * | ---------- | ----------------------------------------- | ----------- |
 * | authoring  | `AssetRef` (here)                         | optional    |
 * | compiled   | {@link PinnedAssetRef}                    | required    |
 * | rendered   | `AssetInstance` (`story/shot.ts`), `AssetInstanceNode` (`anim/ir.ts`) | required |
 *
 * Compilation is the step in between, and it is recorded rather than implied:
 * `ShotCompilation` in `story/shot.ts` holds one `ShotAssetPin` per placed instance,
 * carrying the ref as authored beside the version it resolved to and the style
 * checksum it resolved against. See {@link pinsRef} for what makes a resolution legal.
 */
export const AssetRef = z.object({
  assetId: AssetId,
  versionId: AssetVersionId.optional().describe(
    'The exact version, when the author deliberately froze one. Omit for "whatever is ' +
      'current" - compilation will pin it.',
  ),
  variantKey: Slug.optional().describe(
    'The variant by its stable slug key, e.g. "winter". Note that `AssetInstance` in ' +
      '`story/shot.ts` addresses the same variant by its minted `VariantId` instead.',
  ),
  /**
   * How this placement wants the asset drawn.
   *
   * On the *reference* and not on the asset record, because the choice is a shot-level
   * one - the same character is one flat image in a wide shot and a rig in a close-up -
   * and because it must be **pinned**. A representation looked up from a mutable asset
   * record at render or export time is the identical failure `versionId` exists to
   * prevent one level up: the export stops being a pure function of the IR, and two
   * exports of the same document can differ.
   *
   * Defaulted rather than optional, so an IR carries the answer explicitly once parsed
   * and every consumer reads a value instead of re-deriving one. `cutout` is the
   * default because it is what every existing document already meant.
   */
  representation: RepresentationKind.default('cutout').describe(
    'How to draw this placement: a single flat image, parts on a rig, depth-separated ' +
      'layers, or footage. Use "cutout" unless the shot needs otherwise.',
  ),
});
export type AssetRef = z.infer<typeof AssetRef>;

/**
 * The same reference after compilation, with the version resolved to a concrete id.
 *
 * The **locked** half of the floating/locked pair described on {@link AssetRef}. It is
 * a distinct schema rather than a runtime assertion so that "this render input cannot
 * be unpinned" is a type error and a parse failure, not a convention: `AssetInstanceNode`
 * in `anim/ir.ts` takes one of these, so an IR carrying a floating reference does not
 * parse and therefore never reaches a render worker.
 */
export const PinnedAssetRef = AssetRef.extend({
  versionId: AssetVersionId.describe(
    'The exact version this render uses. Required: a render resolves nothing at render time.',
  ),
});
export type PinnedAssetRef = z.infer<typeof PinnedAssetRef>;

/** Narrows a floating reference that happens to carry a version. */
export function isPinnedAssetRef(ref: AssetRef): ref is PinnedAssetRef {
  return ref.versionId !== undefined;
}

/**
 * Whether `pinned` is a legal compilation of `authored`.
 *
 * Compilation may only *resolve* what the author left open; it may never re-point a
 * reference. So the asset and the variant must survive unchanged, and a version the
 * author deliberately froze must survive unchanged too - silently repinning it would
 * turn "freeze this take" into a suggestion.
 *
 * Exported because two schemas need the same answer - `ShotAssetPin` in
 * `story/shot.ts` and any later compiler that records its own pins - and a second copy
 * of this rule is a second place for it to drift.
 */
export function pinsRef(authored: AssetRef, pinned: PinnedAssetRef): boolean {
  if (authored.assetId !== pinned.assetId) return false;
  if (authored.variantKey !== pinned.variantKey) return false;
  // The representation is authored, not resolved: compilation may pick a *version*,
  // never a different way of drawing it. Quietly downgrading a 2.5D placement to a flat
  // because the flat was cheaper to serve is precisely the substitution that would make
  // a re-render disagree with the preview the director approved.
  if (authored.representation !== pinned.representation) return false;
  return authored.versionId === undefined || authored.versionId === pinned.versionId;
}
