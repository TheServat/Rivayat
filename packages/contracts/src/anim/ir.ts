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

const NodeBase = {
  id: NodeId,
  name: Slug,
  parentId: NodeId.nullable().describe('null for a root node'),
  transform: Transform2D.prefault({}),
  visible: z.boolean().default(true),
  /**
   * Depth for parallax and painting order. Higher is further from camera.
   * The camera uses it to compute per-layer offset; the renderer uses it to sort.
   */
  depth: z.number().default(0),
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

export const Track = z
  .object({
    id: TrackId,
    nodeId: NodeId,
    channel: AnimChannel,
    keyframes: z.array(Keyframe).min(1),
    /** Behaviour outside the first and last keyframe. */
    before: z.enum(['hold', 'loop', 'ping-pong']).default('hold'),
    after: z.enum(['hold', 'loop', 'ping-pong']).default('hold'),
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
  amplitudeDeg: z.number().min(0).max(180).default(50),
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
export type BehaviourKind = Behaviour['kind'];

// ── camera, markers, document ───────────────────────────────────────────────

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
