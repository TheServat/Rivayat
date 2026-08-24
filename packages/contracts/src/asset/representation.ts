/**
 * What an asset actually **is**, said out loud.
 *
 * Until now every asset was implicitly a cutout rig - parts, a skeleton, clips - and
 * nothing in the schema said so. That assumption is wrong in both directions at once: a
 * character in a wide shot wants to be one flat image and paying for a rig to draw it
 * eight pixels tall is waste, while a painted background wants to be a *stack* of
 * images at different depths so a camera move through it reads as depth rather than as
 * a pan across a poster.
 *
 * So a version may carry **several** representations of the same artwork, and choosing
 * between them is a shot-level decision, not an asset-level one - see
 * {@link AssetRef.representation} in `asset.ts`, which is where the choice is recorded
 * and pinned. The data lives here, on the immutable `AssetVersion`; the *selection*
 * lives on the reference, because a render resolves nothing at render time.
 *
 * ## Why `video` is here and not in the motion system
 *
 * The source design document groups AI video under Motion. ADR-0008 rejects that
 * grouping and the reason is one sentence: **motion is a function of time you can
 * sample at any `t`; footage is frames somebody already decided.** `evaluate(ir, t)` is
 * pure and knows nothing about codecs, and teaching it to decode video would make
 * "motion" mean two incompatible things - which is exactly how a `switch` on kind ends
 * up in core.
 *
 * As a representation, video costs the motion system nothing. The compositor draws it
 * the way it draws any other representation, with an in-point into the source media and
 * a duration; two seconds of engine animation, one second of AI video and four more of
 * engine is three placements on one timeline, not a second animation architecture.
 *
 * ## Reserved kinds
 *
 * `isometric` and `mesh` are in {@link REPRESENTATION_KINDS} but carry no payload
 * schema yet. That is deliberate: the vocabulary is the thing that is expensive to
 * change later, because every router, every capability set and every warning message is
 * keyed by it. Adding `mesh` for real is then a *registration* - one payload schema
 * appended to {@link AssetRepresentation} - rather than a redesign, and
 * {@link RESERVED_REPRESENTATION_KINDS} is derived rather than listed so it cannot
 * drift from the union.
 *
 * `isometric` is reserved rather than implemented for a second reason worth stating:
 * isometric is primarily a *projection* (`CameraTrack.projection` in `anim/ir.ts`), and
 * an `isometric` representation only earns its place when an asset ships artwork drawn
 * for that projection specifically. The camera does not need it.
 */

import { assertNever } from '@rv/shared-kernel';
import { z } from 'zod';

import { PartId, RigId } from '../primitives/ids';
import {
  type Label,
  Millis,
  NonEmptyString,
  Rect,
  Sha256Hex,
  Size,
  Slug,
  Unit01,
  Vec2,
} from '../primitives/common';

// ── the vocabulary ──────────────────────────────────────────────────────────

/**
 * Every representation the system has a name for, implemented or reserved.
 *
 * Ordered cheapest-to-draw first, which is also the order a router should fall back
 * through when a preference cannot be served.
 */
export const REPRESENTATION_KINDS = [
  'flat',
  'cutout',
  'layered-2.5d',
  'video',
  'isometric',
  'mesh',
] as const;

export const RepresentationKind = z.enum(REPRESENTATION_KINDS);
export type RepresentationKind = z.infer<typeof RepresentationKind>;

// ── flat ────────────────────────────────────────────────────────────────────

/**
 * One image, no articulation.
 *
 * The right answer far more often than the pipeline's bias towards rigs suggests: a
 * crowd extra, a distant building, a prop that never moves. It is also the fallback
 * when a rig fails QA - a version that could not be rigged is still perfectly usable as
 * a flat, and saying so is better than marking the whole take failed.
 */
export const FlatRepresentation = z.object({
  kind: z.literal('flat'),
  imageHash: Sha256Hex,
  size: Size,
  /** Rotation and placement centre in normalised image space, as `Part.pivot`. */
  pivot: Vec2.default({ x: 0.5, y: 0.5 }),
});
export type FlatRepresentation = z.infer<typeof FlatRepresentation>;

// ── cutout ──────────────────────────────────────────────────────────────────

/**
 * Parts on a skeleton - what every asset was implicitly assumed to be.
 *
 * Carries *references* rather than copies. `AssetVersion` already holds the parts and
 * the rig, and a second copy of a part list is a second thing to keep in step; what
 * this adds is the declaration that those parts and that rig are servable as a cutout,
 * plus which subset participates when a version holds parts a rig does not bind.
 */
export const CutoutRepresentation = z.object({
  kind: z.literal('cutout'),
  rigId: RigId,
  /** The parts this representation draws, in the version's own part list. */
  partIds: z.array(PartId).min(1),
});
export type CutoutRepresentation = z.infer<typeof CutoutRepresentation>;

// ── layered 2.5D ────────────────────────────────────────────────────────────

/**
 * The scene depth a full-range depth map spans.
 *
 * The `parallax` behaviour normalises a node's `depth` against this number to get its
 * lag factor, so it is the constant that ties `NodeBase.depth` to a physical meaning:
 * **0 is the camera plane and {@link DEPTH_FAR_PLANE} is as far as parallax goes**.
 * Exported rather than repeated because a second copy in the evaluator and a second in
 * the layer cutter would be two definitions of "far", and the symptom would be a
 * background that lags by the wrong amount with nothing failing.
 */
export const DEPTH_FAR_PLANE = 100;

/**
 * A normalised depth-map band, with the convention pinned.
 *
 * **0 is nearest the camera and 1 is furthest**, matching `NodeBase.depth`'s "higher is
 * further" so the mapping to scene depth is a scale with no sign flip. Estimators do
 * not agree on this - MiDaS and friends emit *inverse* depth, where higher means
 * closer - so the ingest pass must flip theirs, once, and everything downstream reads
 * one convention. A band rather than a single value because layer separation cuts the
 * map into slices, and the slice is what was actually decided; the plane the layer is
 * placed on is derived from it by {@link layerDepth}.
 */
export const DepthBand = z
  .object({
    near: Unit01,
    far: Unit01,
  })
  .refine((band) => band.near <= band.far, {
    message: 'a depth band cannot end nearer the camera than it starts',
    path: ['far'],
  });
export type DepthBand = z.infer<typeof DepthBand>;

/**
 * One separated layer of a 2.5D scene.
 *
 * Shaped like a `Part` on purpose - a transparent image with bounds and an alpha
 * coverage score - because it is produced by the same matting machinery and judged by
 * the same quality gate. What it adds is the depth band it was cut from, and what it
 * deliberately does *not* carry is a rig role: a depth layer is a slab of a painting,
 * not a limb.
 */
export const DepthLayer = z.object({
  id: PartId,
  name: Slug,
  imageHash: Sha256Hex,
  /** Where the layer sits inside the representation canvas, in pixels. */
  bounds: Rect,
  band: DepthBand,
  /**
   * Whether the hole this layer's neighbours left behind was filled in.
   *
   * Recorded rather than assumed because it is the difference between a camera move
   * that can push past a foreground element and one that reveals a transparent tear.
   * An un-inpainted stack is still useful for small moves, and the reviewer should be
   * able to see which they have.
   */
  inpainted: z.boolean().default(false),
  /** Fraction of the bounding box that is not fully transparent, as `Part.alphaCoverage`. */
  alphaCoverage: Unit01,
});
export type DepthLayer = z.infer<typeof DepthLayer>;

/**
 * A flat drawing turned into a scene the camera can move through.
 *
 * This is the cheapest cinematic quality in the pipeline: no extra generation, one
 * depth-estimation pass over an image that already exists, and a still gains parallax.
 * It is also the piece the `parallax` behaviour has been waiting for - that behaviour
 * reads `NodeBase.depth` and, until this schema existed, nothing in the system produced
 * depth layers for it to read.
 *
 * The depth map itself is kept, not just the cut layers, because re-cutting into more
 * or fewer slabs is then free while re-estimating is a GPU pass.
 */
export const Layered25dRepresentation = z
  .object({
    kind: z.literal('layered-2.5d'),
    /**
     * Near to far, strictly ordered.
     *
     * At least two: one layer at one depth is a `flat` with extra steps, and admitting
     * it here would let a "2.5D" representation exist that cannot parallax at all.
     */
    layers: z.array(DepthLayer).min(2),
    depthMapHash: Sha256Hex,
    /**
     * What produced the depth map.
     *
     * A depth map nobody can attribute cannot be compared against the next one, and the
     * estimators differ enough that "the background is at 0.8" means different things
     * from different models.
     */
    estimator: NonEmptyString.max(200),
    canvas: Size,
    /**
     * Scene depth units the full [0, 1] map spans.
     *
     * Defaults to {@link DEPTH_FAR_PLANE}, which puts a layer at the far end of the map
     * at the far end of parallax. A shot that wants a shallower stack - an interior,
     * where "far" is four metres - lowers it rather than rescaling every band.
     */
    depthScale: z.number().positive().max(DEPTH_FAR_PLANE).default(DEPTH_FAR_PLANE),
  })
  .superRefine((rep, ctx) => {
    // Ordering is not cosmetic. The layers' index order is what the compiler turns into
    // paint order and what a reviewer reads in the UI, and `depth` is what the renderer
    // sorts by. If the two disagree the picture is wrong in a way that looks like a
    // matting bug, so they are made to agree here rather than trusted to.
    rep.layers.forEach((layer, index) => {
      const previous = rep.layers[index - 1];
      if (previous !== undefined && bandCentre(layer.band) <= bandCentre(previous.band)) {
        ctx.addIssue({
          code: 'custom',
          path: ['layers', index, 'band'],
          message: `layer ${layer.name} is not further from the camera than ${previous.name}; layers run near to far`,
        });
      }
    });

    const names = new Set<string>();
    rep.layers.forEach((layer, index) => {
      if (names.has(layer.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['layers', index, 'name'],
          message: `duplicate layer name ${layer.name}`,
        });
      }
      names.add(layer.name);
    });
  });
export type Layered25dRepresentation = z.infer<typeof Layered25dRepresentation>;

/** The middle of a depth band - the plane a flat slab is placed on. */
function bandCentre(band: DepthBand): number {
  return (band.near + band.far) / 2;
}

/**
 * The `NodeBase.depth` a layer must carry once it is placed in an IR.
 *
 * The single conversion between a depth map's normalised space and the scene depth the
 * `parallax` behaviour and the renderer's paint sort both read. Exported because the
 * shot compiler needs it and a test needs to be able to check it: two independent
 * spellings of this multiplication is how a background ends up parallaxing at a
 * plausible but wrong rate.
 */
export function layerDepth(layer: DepthLayer, depthScale: number): number {
  return bandCentre(layer.band) * depthScale;
}

/** Every layer's scene depth, in the representation's near-to-far order. */
export function layerDepths(rep: Layered25dRepresentation): readonly number[] {
  return rep.layers.map((layer) => layerDepth(layer, rep.depthScale));
}

// ── video ───────────────────────────────────────────────────────────────────

/**
 * Footage the compositor draws, not motion the evaluator samples.
 *
 * The fields are the intrinsic media facts plus the sub-range of the file to use.
 * *Where on the shot's timeline the clip sits* is deliberately absent: that is a
 * placement, it belongs to the node that places it, and putting it here would mean the
 * same footage reused in two shots needs two representations.
 *
 * This is the one representation that is a genuine render **capability** rather than a
 * different arrangement of images - a canvas backend that cannot decode a video cannot
 * approximate one either - which is why it also appears in the IR feature vocabulary
 * and why an exporter that cannot carry it says so instead of dropping it.
 */
export const VideoRepresentation = z.object({
  kind: z.literal('video'),
  videoHash: Sha256Hex,
  size: Size,
  fps: z.number().int().min(1).max(120),
  /** Where in the source media the usable range starts. */
  inPointMs: Millis.default(0),
  /** How much of the source media to use from `inPointMs`. */
  durationMs: z.number().int().positive(),
  /** Whether the footage carries an alpha channel, and can therefore composite over a scene. */
  hasAlpha: z.boolean().default(false),
});
export type VideoRepresentation = z.infer<typeof VideoRepresentation>;

// ── the union ───────────────────────────────────────────────────────────────

export const AssetRepresentation = z.discriminatedUnion('kind', [
  FlatRepresentation,
  CutoutRepresentation,
  Layered25dRepresentation,
  VideoRepresentation,
]);
export type AssetRepresentation = z.infer<typeof AssetRepresentation>;

/**
 * The kinds that carry a payload schema today.
 *
 * Derived from the union's own options rather than listed, so implementing a reserved
 * kind updates both lists by updating neither.
 */
export const IMPLEMENTED_REPRESENTATION_KINDS: readonly RepresentationKind[] =
  REPRESENTATION_KINDS.filter((kind) =>
    AssetRepresentation.options.some((option) => option.shape.kind.value === kind),
  );

/** The kinds named in the vocabulary but not yet servable. See the file header. */
export const RESERVED_REPRESENTATION_KINDS: readonly RepresentationKind[] =
  REPRESENTATION_KINDS.filter((kind) => !IMPLEMENTED_REPRESENTATION_KINDS.includes(kind));

/**
 * Every blob the content store must hold before this representation can be drawn.
 *
 * The prefetch list, and the reason this function exists rather than four call sites
 * reaching into four payload shapes. It is also the union's `assertNever` site: a
 * fifth representation that nobody taught the compositor to resolve fails to compile
 * here, in the file that declares the union, rather than at run time as a missing
 * bitmap on one frame.
 */
export function representationBlobs(rep: AssetRepresentation): readonly Sha256Hex[] {
  switch (rep.kind) {
    case 'flat':
      return [rep.imageHash];
    case 'cutout':
      // The part images are addressed by the version's own `Part` records; this
      // representation names which parts, not where their pixels are.
      return [];
    case 'layered-2.5d':
      return [rep.depthMapHash, ...rep.layers.map((layer) => layer.imageHash)];
    case 'video':
      return [rep.videoHash];
    default:
      return assertNever(rep, 'asset representation');
  }
}

// ── routing ─────────────────────────────────────────────────────────────────

/**
 * Pick the best representation an adapter can actually serve.
 *
 * `servable` is the adapter's own declaration of what it can draw. An adapter that
 * cannot decode video, or cannot composite a depth stack, says so and this routes
 * around it; nothing here guesses, and nothing substitutes a representation the caller
 * did not ask for beyond the order it supplied.
 *
 * Returns `null` rather than a fallback when nothing matches. A silent fallback is how
 * a shot that asked for 2.5D renders flat and looks merely disappointing instead of
 * failing - the caller is the only one that knows whether that trade is acceptable.
 */
export function selectRepresentation(
  available: readonly AssetRepresentation[],
  prefer: readonly RepresentationKind[],
  servable: ReadonlySet<RepresentationKind>,
): AssetRepresentation | null {
  for (const kind of prefer) {
    if (!servable.has(kind)) continue;
    const match = available.find((rep) => rep.kind === kind);
    if (match !== undefined) return match;
  }
  return null;
}

/** The representation of a given kind, if this list carries one. */
export function findRepresentation(
  available: readonly AssetRepresentation[],
  kind: RepresentationKind,
): AssetRepresentation | null {
  return available.find((rep) => rep.kind === kind) ?? null;
}

/**
 * A human label for a representation, for the library UI and for warning text.
 *
 * Deliberately not derived from the kind string: "layered-2.5d" is a slug, and a
 * reviewer reading why an export dropped something is owed a sentence.
 */
export const REPRESENTATION_LABELS: Readonly<Record<RepresentationKind, Label>> = {
  flat: 'a single flat image',
  cutout: 'parts on a rig',
  'layered-2.5d': 'depth-separated layers',
  video: 'pre-rendered footage',
  isometric: 'artwork drawn for an isometric projection',
  mesh: 'a 3D mesh',
};
