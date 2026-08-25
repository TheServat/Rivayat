/**
 * The Animation IR - `.rvanim.json`.
 *
 * One document describes a whole shot, and everything else is a projection of it:
 * live playback in PixiJS, head-less frames for FFmpeg, a baked sprite sheet, a Lottie
 * export. Four properties drove the design, and no existing format has all four:
 *
 *  - **LLM-generatable.** Flat arrays of small, named, well-described records. No
 *    deep nesting, no positional tuples, no implicit state. A model can emit this
 *    against a JSON schema; it cannot reliably emit an imperative generator function.
 *  - **Deterministic and seek-safe.** `evaluate(ir, t)` is a pure function of `t`.
 *    No accumulated state, no `Date.now()`, no `Math.random()` - behaviours carry an
 *    explicit `seed`. Scrubbing to 4.2s, playing to 4.2s and resuming a distributed
 *    render at 4.2s all produce the same frame.
 *  - **Diffable.** Flat, id-keyed records with stable ordering, so a change to one
 *    node is a small diff and an edit can be reviewed.
 *  - **Editable.** Every value a human might want to grab in a timeline UI is a first
 *    class field, not an argument buried in a function call.
 *
 * Nodes are stored **flat with a `parentId`** rather than nested. Nesting reads better
 * on paper but makes diffs enormous, makes LLM output brittle, and makes re-parenting
 * a node in the editor a tree surgery instead of a field assignment.
 */

import { z } from 'zod';

import {
  AnimationId,
  BehaviourId,
  BoneId,
  MarkerId,
  NodeId,
  PartId,
  TrackId,
} from '../primitives/ids';
import {
  HexColor,
  Label,
  Millis,
  NonEmptyString,
  Size,
  Slug,
  Transform2D,
  Unit01,
  Vec2,
} from '../primitives/common';
import { LoopMode, PinnedAssetRef } from '../asset/asset';
import { Easing } from './easing';

// ── nodes ───────────────────────────────────────────────────────────────────

/**
 * Where on the parent instance this node hangs.
 *
 * The thing that lets a character hold a sword without any code naming a bone. A rig
 * declares `grip-right` as a point in a bone's local space (`asset/rig.ts`), and a node
 * carrying this attaches there instead of at the instance's origin - so the sword follows
 * the hand through the whole clip, survives the rig being refitted, survives the template
 * gaining a wrist bone, and transfers to a second character whose arms are a different
 * length.
 *
 * It refines `parentId` rather than replacing it: the node is already a child of the
 * instance, and this says *where* on it. Modelling it as a second, independent link would
 * be a second hierarchy, which is exactly what flat-nodes-with-`parentId` exists to avoid.
 *
 * The anchor is a **name**, and it is deliberately not checked here. The rig lives on an
 * `AssetVersion` the IR only names, so nothing in this document can resolve it; the
 * failure surfaces where the rig is in scope, as a `NotFoundError` from `anchorPoint` in
 * `@rv/anim-engine`. What *is* checked is that the parent is an asset instance at all -
 * a group has no rig and no anchors, so attaching to one is a typo that would otherwise
 * evaluate to nothing.
 *
 * For the same reason **`evaluate` does not apply the offset**. It is a pure function of
 * the document and has never seen a rig, so the `ResolvedNode` it returns for an attached
 * node is composed through the instance's transform and stops there. A consumer that
 * draws one composes `attachmentFrame` from `@rv/anim-engine` over the resolved
 * transform, once it has posed the instance's skeleton. That is the same split as
 * everything else about rigs: the IR carries the intent, the poser does the arithmetic,
 * and the evaluator stays pure.
 */
export const NodeAttachment = z.object({
  anchor: Slug.describe('Anchor name on the parent instance’s rig, e.g. "grip-right"'),
  /**
   * Whether the node inherits the anchor's rotation.
   *
   * True for a held prop - a sword turns with the hand - and false for anything that must
   * stay upright while tracking a point, which is what a speech balloon over a tumbling
   * character has to do.
   */
  inheritRotation: z.boolean().default(true),
});
export type NodeAttachment = z.infer<typeof NodeAttachment>;

const NodeBase = {
  id: NodeId,
  name: Slug,
  parentId: NodeId.nullable().describe('null for a root node'),
  transform: Transform2D.prefault({}),
  visible: z.boolean().default(true),
  /**
   * Signed distance from the camera plane, for parallax and for painting order.
   *
   * **0 is the camera plane**, positive is behind it and lags, negative is in front of it
   * and over-travels - a fence post at the roadside against the field behind it. The
   * scale is the same one `DEPTH_FAR_PLANE` and `Layered25dRepresentation.depthScale` use,
   * so a 2.5D layer stack and a hand-placed backdrop mean the same thing by "far".
   *
   * Note it counts the opposite way to `ShotLayer.z` in `story/shot.ts`, which ascends
   * from the furthest back; `paintDepthFor` there is the conversion, and `irDepthFor` is
   * the one for `ParallaxDepth`.
   */
  depth: z.number().default(0),
  /** Attach to a named point on the parent instance's rig rather than to its origin. */
  attachment: NodeAttachment.optional(),
};

export const GroupNode = z.object({
  ...NodeBase,
  kind: z.literal('group'),
});

/**
 * An asset placed in the scene.
 *
 * The clip named here plays on the instance's own rig.
 *
 * The reference is a `PinnedAssetRef`, not the floating `AssetRef` an author writes.
 * An IR is a *render document*: `evaluate(ir, t)` has to be a pure function and the
 * frames it produces have to be bit-reproducible (CLAUDE.md non-negotiable #1), and
 * "whatever version is current" is not something a replay, a shard or a resumed job
 * can resolve consistently. Propagating an upgraded asset is an *authoring-time*
 * property, and it belongs to the floating `AssetRef` upstream of compilation; by the
 * time a shot has been compiled into an IR, every reference is frozen and the
 * resolution is recorded in a `ShotCompilation` (`story/shot.ts`).
 */
export const AssetInstanceNode = z.object({
  ...NodeBase,
  kind: z.literal('asset-instance'),
  asset: PinnedAssetRef,
  clipName: Slug.optional().describe('Clip to play; omitted means the rig rest pose'),
  clipLoop: LoopMode.default('loop'),
  /** Offset into the clip at t=0, so instances of the same asset do not move in lockstep. */
  clipOffsetMs: Millis.default(0),
  clipSpeed: z.number().min(0.05).max(8).default(1),
  tint: HexColor.optional(),
  flipX: z.boolean().default(false),
});

/** Direct control of one part inside an instance, for hand-tweaked overrides. */
export const PartNode = z.object({
  ...NodeBase,
  kind: z.literal('part'),
  instanceId: NodeId,
  partId: PartId,
});

/** Direct control of one bone, for poses the clip library does not cover. */
export const BoneNode = z.object({
  ...NodeBase,
  kind: z.literal('bone'),
  instanceId: NodeId,
  boneId: BoneId,
});

export const TextNode = z.object({
  ...NodeBase,
  kind: z.literal('text'),
  text: NonEmptyString,
  /** Logical style name resolved against the project's typography tokens. */
  styleName: Slug.default('body'),
  color: HexColor.optional(),
  maxWidth: z.number().positive().optional(),
  align: z.enum(['start', 'center', 'end']).default('start'),
  /** Text direction. Persian content is authored RTL, so this is not cosmetic. */
  direction: z.enum(['ltr', 'rtl', 'auto']).default('auto'),
});

export const ShapeNode = z.object({
  ...NodeBase,
  kind: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'line', 'polygon', 'path']),
  fill: HexColor.optional(),
  stroke: HexColor.optional(),
  strokeWidth: z.number().nonnegative().default(0),
  /** SVG path data when `shape` is "path"; polygon points otherwise. */
  geometry: z.string().optional(),
  size: Size.optional(),
});

export const FxEmitterNode = z.object({
  ...NodeBase,
  kind: z.literal('fx-emitter'),
  effect: z.enum([
    'dust',
    'leaves',
    'rain',
    'snow',
    'sparks',
    'bubbles',
    'smoke',
    'petals',
    'fireflies',
  ]),
  rate: z.number().min(0).max(500).describe('Particles per second'),
  area: Size,
  /** Explicit, because particle systems are the easiest place for determinism to leak. */
  seed: z.number().int().nonnegative(),
  intensity: Unit01.default(0.5),
});

export const AnimNode = z.discriminatedUnion('kind', [
  GroupNode,
  AssetInstanceNode,
  PartNode,
  BoneNode,
  TextNode,
  ShapeNode,
  FxEmitterNode,
]);
export type AnimNode = z.infer<typeof AnimNode>;
export type GroupNode = z.infer<typeof GroupNode>;
export type AssetInstanceNode = z.infer<typeof AssetInstanceNode>;
export type PartNode = z.infer<typeof PartNode>;
export type BoneNode = z.infer<typeof BoneNode>;
export type TextNode = z.infer<typeof TextNode>;
export type ShapeNode = z.infer<typeof ShapeNode>;
export type FxEmitterNode = z.infer<typeof FxEmitterNode>;

// ── tracks ──────────────────────────────────────────────────────────────────

/**
 * The animatable channels.
 *
 * A closed enum rather than a free-form property path: it keeps the evaluator's
 * dispatch exhaustive, it gives the LLM a fixed vocabulary, and it means the timeline
 * UI can render a row per channel without reflection.
 */
export const AnimChannel = z.enum([
  'position.x',
  'position.y',
  'rotation',
  'scale.x',
  'scale.y',
  'skew.x',
  'skew.y',
  'anchor.x',
  'anchor.y',
  'opacity',
  'depth',
  'tint.r',
  'tint.g',
  'tint.b',
  'clip.speed',
  'fx.intensity',
  'text.reveal',
  'path.progress',
]);
export type AnimChannel = z.infer<typeof AnimChannel>;

export const Keyframe = z.object({
  timeMs: Millis,
  value: z.number(),
  /** Easing applied on the way *out* of this keyframe, toward the next one. */
  easing: Easing.optional(),
});
export type Keyframe = z.infer<typeof Keyframe>;

/**
 * What happens outside a track's first and last keyframe.
 *
 * Named rather than inlined twice because a motion request has to spell the same three
 * options, and two spellings of one closed set is one place too many.
 */
export const Extrapolation = z.enum(['hold', 'loop', 'ping-pong']);
export type Extrapolation = z.infer<typeof Extrapolation>;

export const Track = z
  .object({
    id: TrackId,
    nodeId: NodeId,
    channel: AnimChannel,
    keyframes: z.array(Keyframe).min(1),
    /** Behaviour outside the first and last keyframe. */
    before: Extrapolation.default('hold'),
    after: Extrapolation.default('hold'),
    /** Added to, rather than replacing, whatever a behaviour computed for this channel. */
    additive: z.boolean().default(false),
  })
  .refine(
    (track) =>
      track.keyframes.every((keyframe, index) => {
        // Written as "no previous keyframe, or later than it" rather than
        // `index === 0 || ... ?? -1`, because the sentinel branch of that version was
        // unreachable and therefore permanently uncovered - an untestable branch in a
        // package that owes 100 %.
        const previous = track.keyframes[index - 1];
        return previous === undefined || keyframe.timeMs > previous.timeMs;
      }),
    { message: 'keyframes must be strictly ordered by time', path: ['keyframes'] },
  );
export type Track = z.infer<typeof Track>;

// ── behaviours ──────────────────────────────────────────────────────────────

/**
 * Procedural motion, parameterised rather than keyframed.
 *
 * This is where the cost saving lives. A forest of forty trees swaying convincingly is
 * forty `wind` behaviours with different seeds, not forty hand-animated tracks and
 * certainly not forty generated videos. Every behaviour is a pure function of `(t,
 * params, seed)`, which is what keeps the whole IR seek-safe.
 */
const BehaviourBase = {
  id: BehaviourId,
  nodeId: NodeId,
  enabled: z.boolean().default(true),
  /** Deterministic per-behaviour randomness. Derive it from the node id, never at random. */
  seed: z.number().int().nonnegative(),
  /** Restrict the behaviour to a window; omitted means the whole clip. */
  startMs: Millis.optional(),
  endMs: Millis.optional(),
  weight: Unit01.default(1).describe('Blend factor against the underlying pose'),
};

export const WindBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('wind'),
  hz: z.number().min(0).max(8).default(0.3),
  amplitude: Unit01.default(0.25),
  gustiness: Unit01.default(0.4),
  direction: z.number().min(-180).max(180).default(0),
  /** Sway increases toward the tips of a chain, as a real branch does. */
  tipBias: Unit01.default(0.7),
});

export const BreatheBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('breathe'),
  hz: z.number().min(0).max(2).default(0.25),
  amplitude: Unit01.default(0.15),
});

export const BlinkBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('blink'),
  intervalMs: Millis.default(4200),
  varianceMs: Millis.default(1800),
  closeDurationMs: Millis.default(110),
});

export const SwayBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('sway'),
  hz: z.number().min(0).max(8).default(0.5),
  amplitudeDeg: z.number().min(0).max(90).default(4),
  axis: z.enum(['rotation', 'position.x', 'position.y']).default('rotation'),
});

export const WalkCycleBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('walk-cycle'),
  stepsPerSecond: z.number().min(0.1).max(8).default(1.6),
  strideLength: z.number().positive().default(60),
  bounce: Unit01.default(0.3),
  /** From the character's `motionSignature`; a limp is a gait, not a bug. */
  gait: z.enum(['walk', 'run', 'sneak', 'limp', 'march', 'shuffle', 'skip']).default('walk'),
});

export const FlapBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('flap'),
  hz: z.number().min(0.1).max(20).default(4),
  /**
   * Signed, because a pair of wings is one behaviour applied twice with opposite sign.
   *
   * The evaluator computes `sin(phase) * amplitudeDeg`, so a negative amplitude is a
   * wing rotating the other way - which is exactly what the far wing of a bird does.
   * Requiring a non-negative angle here made the mirrored half unrepresentable, and the
   * only scene in the repo that actually flaps was writing -46 and never being validated
   * against this schema.
   *
   * The bound is the magnitude: 180 degrees either way.
   */
  amplitudeDeg: z.number().min(-180).max(180).default(50),
  /** Wings do not flap symmetrically in time; the asymmetry is what sells it. */
  downstrokeBias: Unit01.default(0.35),
});

export const OrbitBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('orbit'),
  centre: Vec2,
  radius: Vec2,
  periodMs: Millis.default(4000),
  phase: Unit01.default(0),
});

/**
 * Camera-driven layer offset.
 *
 * Reads the node's `depth` and the camera track. Declared per node rather than derived
 * globally so a foreground element can opt out - a UI overlay must not parallax.
 */
export const ParallaxBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('parallax'),
  strength: Unit01.default(0.5),
  curve: z.enum(['linear', 'exponential', 'logarithmic']).default('exponential'),
});

export const BoilBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('boil'),
  amplitude: Unit01.default(0.15),
  hz: z.number().min(0).max(24).default(8),
});

export const SpringBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('spring'),
  stiffness: Unit01.default(0.5),
  damping: Unit01.default(0.6),
  /** The channel that drives the spring; the spring trails it. */
  follows: AnimChannel.default('position.x'),
});

export const LookAtBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('look-at'),
  targetNodeId: NodeId,
  maxAngleDeg: z.number().min(0).max(180).default(35),
  responsiveness: Unit01.default(0.5),
});

export const FollowPathBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('follow-path'),
  /** SVG path data in scene space. */
  path: NonEmptyString,
  durationMs: Millis,
  orientToPath: z.boolean().default(true),
  loop: LoopMode.default('loop'),
});

/**
 * Mouth shapes driven by a phoneme timeline.
 *
 * The phonemes come from the dialogue line, so lip-sync is data the story stage
 * already produced rather than a separate analysis pass over rendered audio.
 */
export const LipSyncBehaviour = z.object({
  ...BehaviourBase,
  kind: z.literal('lip-sync'),
  phonemes: z.array(z.object({ timeMs: Millis, viseme: Slug, durationMs: Millis })).min(1),
  intensity: Unit01.default(0.8),
});

export const Behaviour = z.discriminatedUnion('kind', [
  WindBehaviour,
  BreatheBehaviour,
  BlinkBehaviour,
  SwayBehaviour,
  WalkCycleBehaviour,
  FlapBehaviour,
  OrbitBehaviour,
  ParallaxBehaviour,
  BoilBehaviour,
  SpringBehaviour,
  LookAtBehaviour,
  FollowPathBehaviour,
  LipSyncBehaviour,
]);
export type Behaviour = z.infer<typeof Behaviour>;

/**
 * The behaviour kinds, as a schema rather than only as a type.
 *
 * A motion provider *declares* which behaviours it can author and a request *asks* for
 * some, and both of those travel: they are validated at a boundary and stored in a
 * decision log. `Behaviour['kind']` is a type and cannot do either.
 *
 * Written out rather than derived from the union because `z.discriminatedUnion` takes a
 * positional array and there is no way to project its discriminants back into a
 * `z.enum` without losing the literal types. The duplication is paid for by
 * `behaviourKindsAreExhaustive` below, which fails the build in both directions.
 */
export const BehaviourKind = z.enum([
  'wind',
  'breathe',
  'blink',
  'sway',
  'walk-cycle',
  'flap',
  'orbit',
  'parallax',
  'boil',
  'spring',
  'look-at',
  'follow-path',
  'lip-sync',
]);
export type BehaviourKind = z.infer<typeof BehaviourKind>;

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Compile-time proof that the enum above and the union above list the same kinds.
 *
 * A fourteenth behaviour added to only one of them makes this type `never`, so the
 * assignment fails to compile - in the file that declares both, rather than surfacing
 * as a provider that can never be routed to. It is a value and not a type alias
 * precisely because an unused alias resolving to `never` is not an error.
 */
const _behaviourKindsAreExhaustive: MutuallyAssignable<BehaviourKind, Behaviour['kind']> = true;

// ── camera, markers, document ───────────────────────────────────────────────

/**
 * How scene coordinates become view coordinates.
 *
 * Isometric is a *projection*, not a second animation system (ADR-0008 §4). The camera
 * gains a mode and `isometric` is one value of it; depth sorting follows from the mode
 * rather than from a different renderer. Refusing to treat it as a matrix is how a
 * project ends up with an "isometric mode" that duplicates the node kinds, the
 * behaviours and the exporters, and the source design document makes that point twice.
 *
 * The camera is the only thing that changes. Nodes, behaviours, tracks and the
 * evaluator are all untouched - which is the test of whether it was modelled correctly.
 */
export const CAMERA_PROJECTIONS = ['orthographic', 'isometric'] as const;
export const CameraProjection = z.enum(CAMERA_PROJECTIONS);
export type CameraProjection = z.infer<typeof CameraProjection>;

/**
 * How the compositor orders what it paints.
 *
 * - `depth`: by `ResolvedNode.depth` **descending**, authored order breaking ties. The
 *   rule the renderer has always used, and higher depth is further from camera.
 * - `projected-y`: by projected screen y **ascending**, then depth descending, then
 *   authored order. Under an isometric projection something further from the camera
 *   lands higher up the screen, so screen y - not depth - is what decides who occludes
 *   whom.
 */
export const DEPTH_SORTS = ['depth', 'projected-y'] as const;
export const DepthSort = z.enum(DEPTH_SORTS);
export type DepthSort = z.infer<typeof DepthSort>;

/**
 * A projection, as the three vectors it actually is.
 *
 * `xAxis`, `yAxis` and `depthAxis` are where one scene unit of x, y and depth land in
 * view space. That is the whole of it: `view = xAxis*x + yAxis*y + depthAxis*depth`, an
 * affine map, and `{a: xAxis.x, b: xAxis.y, c: yAxis.x, d: yAxis.y}` is directly the
 * linear half of a canvas matrix.
 *
 * `depthAxis` is separate because the map is affine over **three** inputs and a 2x3
 * canvas matrix holds two. The alternative - growing the renderer's matrix type - would
 * touch both render backends, the Lottie exporter and the web player, so the depth
 * contribution is folded into position *before* the matrix instead. That is not a new
 * trick here: the `parallax` behaviour already establishes depth-drives-position as a
 * legitimate move, which makes this consistent rather than novel.
 */
export const ProjectionBasis = z.object({
  xAxis: Vec2,
  yAxis: Vec2,
  depthAxis: Vec2,
  sort: DepthSort,
});
export type ProjectionBasis = z.infer<typeof ProjectionBasis>;

/**
 * The isometric elevation, in degrees above the horizon.
 *
 * 30 degrees is true isometric: the three axes meet at 120 degrees and the projected
 * ground diamond is sqrt(3):1. Named once rather than inlined twice, because the two
 * halves of the basis below have to be the *same* angle and a project that lets them
 * drift ends up with a floor grid that does not close.
 */
const ISOMETRIC_ELEVATION_DEG = 30;
const ISO_HORIZONTAL = Math.cos((ISOMETRIC_ELEVATION_DEG * Math.PI) / 180);
const ISO_VERTICAL = Math.sin((ISOMETRIC_ELEVATION_DEG * Math.PI) / 180);

/**
 * One basis per projection - the registry, and the reason there is no `switch` on a
 * projection name anywhere outside this file.
 *
 * A total `Record`, so a third projection is a compile error here, in the file that
 * declares the vocabulary, rather than a silent fall-through to orthographic in a
 * renderer nobody thought to update.
 *
 * `orthographic` is *exactly* the identity, with a zero depth axis. That is a
 * requirement rather than an accident: the ninety-nine per cent case must render
 * byte-identically to a document that had no projection field at all, and
 * {@link projectScenePoint} short-circuits on it so the guarantee survives floating
 * point instead of depending on it.
 *
 * Under `isometric`, scene `y` is read as **ground-plane depth** rather than as screen
 * height - the authored coordinates are a floor grid and the projection is what turns
 * that grid into a diamond. `depthAxis` points up-screen (canvas y grows downward), so
 * something further from the camera draws higher, which is what makes `projected-y`
 * the correct sort.
 */
export const PROJECTION_BASES: Readonly<Record<CameraProjection, ProjectionBasis>> = {
  orthographic: {
    xAxis: { x: 1, y: 0 },
    yAxis: { x: 0, y: 1 },
    depthAxis: { x: 0, y: 0 },
    sort: 'depth',
  },
  isometric: {
    xAxis: { x: ISO_HORIZONTAL, y: ISO_VERTICAL },
    yAxis: { x: -ISO_HORIZONTAL, y: ISO_VERTICAL },
    depthAxis: { x: 0, y: -1 },
    sort: 'projected-y',
  },
};

/** Whether a basis is the identity: unit axes, no depth contribution. */
function isIdentityBasis(basis: ProjectionBasis): boolean {
  return (
    basis.xAxis.x === 1 &&
    basis.xAxis.y === 0 &&
    basis.yAxis.x === 0 &&
    basis.yAxis.y === 1 &&
    basis.depthAxis.x === 0 &&
    basis.depthAxis.y === 0
  );
}

/**
 * Scene space to view space, for one point at one depth.
 *
 * **The one shared function every consumer calls.** The renderer folds the result into
 * its camera matrix, the reframer normalises it to solve a crop, and an exporter that
 * has to flatten a projection reads the same numbers. Three implementations of this
 * arithmetic is exactly the failure this repo already has a bug report about - an
 * exporter that held a different opinion about where scene space's origin was and
 * displaced every layer by half a canvas - so there is one, here, beside the basis it
 * reads.
 *
 * It deliberately does **not** apply the camera. `ResolvedNode.worldTransform.position`
 * stays scene space, a convention three packages were just made to agree on at real
 * cost; projection is applied by consumers on the way to pixels, never by the evaluator
 * on the way out.
 *
 * The identity short-circuit is the byte-identity guarantee: under `orthographic` the
 * arithmetic is skipped rather than performed, so the result carries the input's own
 * coordinates and not a value that happens to round to them.
 */
export function projectScenePoint(projection: CameraProjection, point: Vec2, depth = 0): Vec2 {
  const basis = PROJECTION_BASES[projection];
  if (isIdentityBasis(basis)) return { x: point.x, y: point.y };
  return {
    x: basis.xAxis.x * point.x + basis.yAxis.x * point.y + basis.depthAxis.x * depth,
    y: basis.xAxis.y * point.x + basis.yAxis.y * point.y + basis.depthAxis.y * depth,
  };
}

/**
 * The axis-aligned extent a centre-origin scene rectangle occupies once projected.
 *
 * The reframer needs it. `sceneSpace` describes the authoring canvas, but under a
 * non-identity projection the canvas is no longer the shape that lands on screen, and
 * normalising against the wrong rectangle produces a crop that is confidently and
 * exactly wrong - which is worse than a sloppy one, because the crop solver's own
 * boundary tests will keep passing. Under `orthographic` it returns the scene
 * unchanged, so nothing that exists today moves.
 *
 * Depth is excluded on purpose: the extent is a property of the *canvas*, and how deep
 * a scene runs is a property of what happens to be in it.
 */
export function projectedExtent(
  projection: CameraProjection,
  scene: { readonly width: number; readonly height: number },
): { width: number; height: number } {
  const basis = PROJECTION_BASES[projection];
  if (isIdentityBasis(basis)) return { width: scene.width, height: scene.height };
  return {
    width: Math.abs(basis.xAxis.x) * scene.width + Math.abs(basis.yAxis.x) * scene.height,
    height: Math.abs(basis.xAxis.y) * scene.width + Math.abs(basis.yAxis.y) * scene.height,
  };
}

export const CameraKeyframe = z.object({
  timeMs: Millis,
  position: Vec2,
  zoom: z.number().min(0.05).max(20).default(1),
  rotation: z.number().min(-180).max(180).default(0),
  easing: Easing.optional(),
});
export type CameraKeyframe = z.infer<typeof CameraKeyframe>;

export const CameraTrack = z.object({
  keyframes: z.array(CameraKeyframe).min(1),
  /**
   * What must stay in frame.
   *
   * This is what makes one composition re-framable to 16:9, 9:16, 1:1 and 4:5 without
   * re-authoring: the reframer solves a crop per format that keeps this node inside
   * the platform's safe area.
   */
  focusNodeId: NodeId.optional(),
  shakeAmplitude: Unit01.default(0),
  shakeSeed: z.number().int().nonnegative().default(0),
  /**
   * How scene coordinates reach the screen.
   *
   * On the *track* and not on a keyframe, because a projection is not a function of
   * time. Tweening from orthographic to isometric is not a camera move, it is a cut,
   * and a cut is two shots. Keeping it off `CameraKeyframe` also keeps it off
   * `SceneSnapshot.camera`, so `evaluate` neither knows nor cares - a consumer reads it
   * from the IR it already holds.
   */
  projection: CameraProjection.default('orthographic'),
});
export type CameraTrack = z.infer<typeof CameraTrack>;

export const MarkerKind = z.enum(['beat', 'cut', 'dialogue', 'sfx', 'music', 'custom']);
export type MarkerKind = z.infer<typeof MarkerKind>;

export const Marker = z.object({
  id: MarkerId,
  timeMs: Millis,
  kind: MarkerKind,
  label: Label,
});
export type Marker = z.infer<typeof Marker>;

export const IR_VERSION = 1;

export const AnimationIR = z
  .object({
    /** Schema version. Bumped only for a breaking change; migrations key off it. */
    irVersion: z.literal(IR_VERSION),
    id: AnimationId,
    name: Label,

    fps: z.number().int().min(1).max(120),
    durationMs: z.number().int().positive(),
    /**
     * The format-agnostic authoring space.
     *
     * Shots are composed here once, then re-framed per delivery format. It is
     * deliberately larger than any target so a 9:16 crop and a 16:9 crop can both be
     * satisfied from the same composition.
     */
    sceneSpace: Size,
    /** Root seed. Every behaviour's seed should be derived from this plus its node id. */
    seed: z.number().int().nonnegative(),

    nodes: z.array(AnimNode).min(1),
    tracks: z.array(Track).default([]),
    behaviours: z.array(Behaviour).default([]),
    markers: z.array(Marker).default([]),
    camera: CameraTrack.optional(),
  })
  .superRefine((ir, ctx) => {
    const nodeIds = new Set<string>();
    for (const node of ir.nodes) {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate node id ${node.id}`, path: ['nodes'] });
      }
      nodeIds.add(node.id);
    }

    for (const node of ir.nodes) {
      if (node.parentId !== null && !nodeIds.has(node.parentId)) {
        ctx.addIssue({
          code: 'custom',
          message: `node ${node.name} references unknown parent ${node.parentId}`,
          path: ['nodes'],
        });
      }
    }

    // A parent cycle would make evaluation non-terminating. Reject it here rather than
    // hang a render worker.
    const parentOf = new Map(ir.nodes.map((node) => [node.id, node.parentId]));
    for (const node of ir.nodes) {
      const seen = new Set<string>([node.id]);
      let cursor = node.parentId;
      while (cursor != null) {
        if (seen.has(cursor)) {
          ctx.addIssue({
            code: 'custom',
            message: `node hierarchy contains a cycle through ${node.name}`,
            path: ['nodes'],
          });
          break;
        }
        seen.add(cursor);
        cursor = parentOf.get(cursor) ?? null;
      }
    }

    for (const track of ir.tracks) {
      if (!nodeIds.has(track.nodeId)) {
        ctx.addIssue({
          code: 'custom',
          message: `track ${track.id} targets unknown node ${track.nodeId}`,
          path: ['tracks'],
        });
      }
    }

    for (const behaviour of ir.behaviours) {
      if (!nodeIds.has(behaviour.nodeId)) {
        ctx.addIssue({
          code: 'custom',
          message: `behaviour ${behaviour.id} targets unknown node ${behaviour.nodeId}`,
          path: ['behaviours'],
        });
      }
      if (
        behaviour.startMs !== undefined &&
        behaviour.endMs !== undefined &&
        behaviour.endMs <= behaviour.startMs
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `behaviour ${behaviour.id} ends at or before it starts`,
          path: ['behaviours'],
        });
      }
    }

    if (ir.camera?.focusNodeId !== undefined && !nodeIds.has(ir.camera.focusNodeId)) {
      ctx.addIssue({
        code: 'custom',
        message: 'camera focus targets an unknown node',
        path: ['camera', 'focusNodeId'],
      });
    }

    // `part` and `bone` nodes override something *inside* an instance, so their
    // `instanceId` has to name an `asset-instance` node and not merely a node. A group
    // has no parts and no rig, and the override would evaluate to nothing at all.
    const instanceNodeIds = new Set(
      ir.nodes.filter((node) => node.kind === 'asset-instance').map((node) => node.id),
    );
    ir.nodes.forEach((node, index) => {
      if (node.kind !== 'part' && node.kind !== 'bone') return;
      if (!instanceNodeIds.has(node.instanceId)) {
        ctx.addIssue({
          code: 'custom',
          message: `${node.kind} node ${node.name} overrides ${node.instanceId}, which is not an asset-instance node`,
          path: ['nodes', index, 'instanceId'],
        });
      }
    });

    // An attachment hangs a node off a named point on its parent's *rig*. A group has no
    // rig and no anchors, and a root node has no parent at all, so either would make the
    // attachment a silent no-op - the prop draws at the origin and nothing says why. The
    // anchor name itself cannot be checked here: the rig lives on an `AssetVersion` this
    // document only names, so that failure belongs where the rig is in scope.
    ir.nodes.forEach((node, index) => {
      if (node.attachment === undefined) return;
      if (node.parentId === null) {
        ctx.addIssue({
          code: 'custom',
          message: `node ${node.name} attaches to anchor "${node.attachment.anchor}" but has no parent to attach to`,
          path: ['nodes', index, 'attachment'],
        });
        return;
      }
      if (!instanceNodeIds.has(node.parentId)) {
        ctx.addIssue({
          code: 'custom',
          message: `node ${node.name} attaches to anchor "${node.attachment.anchor}" on ${node.parentId}, which is not an asset-instance node and therefore has no rig`,
          path: ['nodes', index, 'attachment'],
        });
      }
    });
  });
export type AnimationIR = z.infer<typeof AnimationIR>;

/**
 * The result of evaluating the IR at one instant.
 *
 * Deliberately flat and renderer-agnostic: the PixiJS backend, the offscreen canvas
 * backend and the sprite-sheet baker all consume this identically, which is what makes
 * a golden-file test over frame hashes meaningful.
 */
export const ResolvedNode = z.object({
  nodeId: NodeId,
  worldTransform: Transform2D,
  visible: z.boolean(),
  depth: z.number(),
  tint: HexColor.optional(),
  /** Per-bone rotations resolved for this frame, for asset-instance nodes. */
  bonePose: z.record(z.string(), z.number()).default({}),
});
export type ResolvedNode = z.infer<typeof ResolvedNode>;

export const SceneSnapshot = z.object({
  timeMs: Millis,
  frame: z.number().int().nonnegative(),
  nodes: z.array(ResolvedNode),
  camera: z.object({ position: Vec2, zoom: z.number(), rotation: z.number() }),
});
export type SceneSnapshot = z.infer<typeof SceneSnapshot>;
