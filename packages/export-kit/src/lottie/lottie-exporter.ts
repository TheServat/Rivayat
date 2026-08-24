/**
 * `AnimationIR → Lottie` - the primary export target (ADR-0001).
 *
 * ADR-0001 rejected Lottie as a *source* format and kept it as the *output* one, and
 * this file is where that distinction is paid for. Two problems dominate.
 *
 * **Lottie has no procedural behaviours.** Our `wind`, `blink` and `boil` are closed-form
 * functions of `t`; Lottie has keyframes and nothing else. So a behaviour is **baked**:
 * sampled across the clip at the IR's own frame rate and written out as dense keys. That
 * is a real cost and it is reported rather than hidden - `stats.bakedKeyframeCount` is
 * the size of it, `options.lottie.stride` is the dial, and `stats.fidelity` is the
 * measured error that dial buys.
 *
 * **Lottie composes transforms as matrices; the IR composes them component-wise.** The
 * two disagree wherever a rotated parent has non-uniform scale (see the note on
 * `composeTransform` in `@rv/anim-engine`). Rather than ship a file that diverges from
 * its own preview in a way nobody would predict, layers are **flattened**: each carries
 * the world transform the evaluator computed, so the picture is exact by construction.
 * The cost is that the layer tree cannot be re-parented downstream, reported as a
 * `restructured` warning on `node:hierarchy`.
 *
 * **The two spaces put the origin in different places.** Scene space is centre-origin -
 * `@rv/render-engine`'s `frames/draw-list.ts` fixes it, and it is what makes a camera at
 * `{x: 0, y: 0}` frame the middle of the composition - while a Lottie composition is
 * top-left origin with no negative half. Every position written here is therefore shifted
 * by half the canvas; see {@link sceneCentreOf} and {@link toCompositionSpace}, which is
 * the only place the conversion happens.
 *
 * What survives exactly, what is approximated, and what is dropped is declared in
 * {@link LOTTIE_CAPABILITIES} and returned per export in `warnings`.
 */

import { type AppError, type Result, ValidationError, at, err, isErr, ok } from '@rv/shared-kernel';
import type {
  AnimChannel,
  AnimNode,
  AnimationIR,
  Marker,
  NodeId,
  PinnedAssetRef,
  ResolvedNode,
  SceneSnapshot,
  ShapeNode,
  Size,
  TextNode,
  Track,
  Vec2,
} from '@rv/contracts';
import { type IrFeature, describeIrFeature, detectIrFeatures } from '@rv/contracts';
import {
  type EasingLibrary,
  type EvaluateOptions,
  DEFAULT_EASINGS,
  buildEasingLibrary,
  evaluate,
  orderParentFirst,
} from '@rv/anim-engine';

import { sceneCentreOf, toCompositionSpace } from '../scene-space';
import type { ExportOptions, LottieOptions } from '../options';
import {
  type ErrorStat,
  type ExportInput,
  type ExportOutput,
  type Exporter,
  type FidelityReport,
  frameCountOf,
  jsonArtifact,
  sampleFrames,
  slugifyName,
  totalBytes,
} from '../port';
import {
  type ApproximationNote,
  type ExportWarning,
  type FormatCapabilities,
  UnsupportedFeaturesError,
  diffFeatures,
  lossyWarnings,
} from '../warnings';
import {
  isExactlyRepresentable,
  overshoots,
  toSegmentEase,
  type LottieSegmentEase,
} from './easing';
import {
  authoredProperty,
  bakedProperty,
  keyframeCount,
  roundTo,
  sampleLottieProperty,
  staticProperty,
} from './sample';
import {
  LOTTIE_LAYER,
  type LottieDocument,
  type LottieFont,
  type LottieImageAsset,
  type LottieLayer,
  type LottieProperty,
  type LottieShapeItem,
  type LottieTextData,
  type LottieTransform,
} from './types';

export const LOTTIE_FORMAT_ID = 'lottie';

const DEFAULT_VERSION = '5.13.0';
const DEFAULT_PRECISION = 6;
const DEFAULT_TOLERANCE = 1e-9;
const DEFAULT_IMAGE_DIR = 'images/';
/**
 * Text size, when the IR does not carry one.
 *
 * `TextNode.styleName` resolves against the project's typography tokens, which live in
 * the style bible and are not an input here. Writing a placeholder and declaring
 * `node:text` approximated is honest; guessing from the node's name would not be.
 */
const DEFAULT_FONT_SIZE = 36;
const DEFAULT_LINE_HEIGHT_RATIO = 1.2;

const BEHAVIOUR_FEATURES = [
  'behaviour:wind',
  'behaviour:breathe',
  'behaviour:blink',
  'behaviour:sway',
  'behaviour:walk-cycle',
  'behaviour:flap',
  'behaviour:orbit',
  'behaviour:parallax',
  'behaviour:boil',
  'behaviour:spring',
  'behaviour:look-at',
  'behaviour:follow-path',
  'behaviour:lip-sync',
] as const satisfies readonly IrFeature[];

function behaviourNotes(): readonly (readonly [IrFeature, ApproximationNote])[] {
  return BEHAVIOUR_FEATURES.map((feature) => [
    feature,
    {
      disposition: 'approximated' as const,
      detail: `${describeIrFeature(feature)} is a closed-form function of time; Lottie has only keyframes, so it was sampled across the clip and written as dense keys`,
    },
  ]);
}

/**
 * What Lottie can and cannot carry, declared before anything is exported.
 *
 * Static so a caller can ask "what would I lose?" without paying for the export - which
 * is what makes the format list usable in a picker rather than only in a post-mortem.
 */
export const LOTTIE_CAPABILITIES: FormatCapabilities = {
  exact: new Set<IrFeature>([
    'node:group',
    'node:shape',
    'track:position',
    'track:rotation',
    'track:scale',
    'track:opacity',
    // Both are resolved by the evaluator before anything is written, so the numbers that
    // reach the file already account for them.
    'track:additive',
    'track:extrapolation',
    'markers',
  ]),
  approximate: new Map<IrFeature, ApproximationNote>([
    [
      'node:hierarchy',
      {
        disposition: 'restructured',
        detail:
          'layers are flattened and each carries its world transform, so the picture is exact; the parent/child structure is not recoverable and the tree cannot be re-parented downstream',
      },
    ],
    [
      'node:asset-instance',
      {
        disposition: 'approximated',
        detail:
          'written as an image layer referencing a file by name; the pixels are not embedded and the layer dimensions are a placeholder derived from the supplied parts or the scene size',
      },
    ],
    [
      'node:text',
      {
        disposition: 'approximated',
        detail: `the IR names a typography token, not a face; the text document is written with the token as its family at ${String(DEFAULT_FONT_SIZE)}px`,
      },
    ],
    [
      'track:skew',
      {
        disposition: 'approximated',
        detail:
          'Lottie has one skew angle and one skew axis; independent x and y skew cannot both be written, so the axis follows whichever component is non-zero',
      },
    ],
    [
      'track:stepped-easing',
      {
        disposition: 'approximated',
        detail:
          'multi-step and jump-at-start curves are baked onto the frame grid instead of written as hold keys: exact at frame times, linear in between',
      },
    ],
    [
      'camera:track',
      {
        disposition: 'restructured',
        detail:
          'Lottie has no camera; the camera transform is folded into every layer so the picture matches, and nothing downstream can pan or zoom it afterwards',
      },
    ],
    [
      'camera:shake',
      {
        disposition: 'restructured',
        detail: 'folded into the layer transforms along with the rest of the camera',
      },
    ],
    ...behaviourNotes(),
  ]),
};

interface ResolvedLottieOptions {
  readonly stride: number;
  readonly tolerance: number;
  readonly precision: number;
  readonly applyCamera: boolean;
  readonly measureFidelity: boolean;
  readonly imageDir: string;
  readonly version: string;
  readonly name: string;
}

export class LottieExporter implements Exporter {
  readonly id = LOTTIE_FORMAT_ID;
  readonly label = 'Lottie';
  readonly formatSpec =
    'Lottie JSON as read by lottie-web 5.13 (research §5): top-level v/fr/ip/op/w/h/layers, layers flattened, transforms in ks';
  readonly requires = [];
  readonly capabilities = LOTTIE_CAPABILITIES;

  export(input: ExportInput, options: ExportOptions = {}): Promise<Result<ExportOutput, AppError>> {
    // Synchronous work in an async signature: the port is uniform across formats, and
    // two of them genuinely await an encoder. Pretending this one does keeps the
    // registry free of a branch.
    return Promise.resolve(this.#run(input, options));
  }

  #run(input: ExportInput, options: ExportOptions): Result<ExportOutput, AppError> {
    const resolved = resolveOptions(input.ir, options.lottie ?? {});
    if (isErr(resolved)) return resolved;
    const opts = resolved.value;

    const built = buildDocument(input, opts);
    const artifact = jsonArtifact(`${opts.name}.json`, built.document);

    const warnings = assembleWarnings(input.ir, opts, built);
    if (options.strict === true) {
      const lossy = lossyWarnings(warnings);
      if (lossy.length > 0) return err(new UnsupportedFeaturesError(this.id, lossy));
    }

    return ok({
      format: this.id,
      artifacts: [artifact],
      warnings,
      stats: {
        totalBytes: totalBytes([artifact]),
        keyframeCount: built.keyframeCount,
        bakedKeyframeCount: built.bakedKeyframeCount,
        sampledFrames: built.sampledFrames,
        sampleStride: opts.stride,
        ...(built.fidelity === undefined ? {} : { fidelity: built.fidelity }),
      },
    });
  }
}

function resolveOptions(
  ir: AnimationIR,
  raw: LottieOptions,
): Result<ResolvedLottieOptions, AppError> {
  const stride = raw.stride ?? 1;
  if (!Number.isInteger(stride) || stride < 1) {
    return err(
      new ValidationError({
        message: 'lottie stride must be a positive integer number of frames',
        context: { stride },
      }),
    );
  }

  const precision = raw.precision ?? DEFAULT_PRECISION;
  if (!Number.isInteger(precision) || precision < 0 || precision > 12) {
    return err(
      new ValidationError({
        message: 'lottie precision must be an integer between 0 and 12 decimals',
        context: { precision },
      }),
    );
  }

  return ok({
    stride,
    tolerance: raw.simplifyTolerance ?? DEFAULT_TOLERANCE,
    precision,
    applyCamera: raw.applyCamera ?? true,
    measureFidelity: raw.measureFidelity ?? true,
    imageDir: raw.imageDir ?? DEFAULT_IMAGE_DIR,
    version: raw.version ?? DEFAULT_VERSION,
    name: raw.name ?? slugifyName(ir.name),
  });
}

// ── document assembly ───────────────────────────────────────────────────────

interface BuiltDocument {
  readonly document: LottieDocument;
  readonly keyframeCount: number;
  readonly bakedKeyframeCount: number;
  readonly sampledFrames: number;
  readonly fidelity: FidelityReport | undefined;
  /** Nodes whose skew has both components non-zero, so one of them could not be written. */
  readonly skewConflicts: readonly string[];
  readonly cameraFolded: boolean;
}

/** The pose an export writes for one node at one instant. */
interface LayerPose {
  readonly position: readonly [number, number];
  readonly scalePercent: readonly [number, number];
  readonly rotation: number;
  readonly opacityPercent: number;
  readonly skew: readonly [number, number];
}

function buildDocument(input: ExportInput, opts: ResolvedLottieOptions): BuiltDocument {
  const ir = input.ir;
  // The evaluator's own fallback curves, imported rather than replicated: a named easing
  // has to resolve to the same two control points here as it does in the renderer, and a
  // second copy of them only shows up as an export that no longer matches its preview.
  const library = buildEasingLibrary(input.motion?.easings ?? DEFAULT_EASINGS);
  const evaluateOptions: EvaluateOptions =
    input.motion === undefined ? {} : { motion: input.motion };

  const frameCount = frameCountOf(ir);
  const frames = sampleFrames(frameCount, opts.stride);
  const cameraFolded = opts.applyCamera && ir.camera !== undefined;

  const poses = frames.map((frame) =>
    posesAt(ir, frameToMs(frame, ir.fps), evaluateOptions, cameraFolded),
  );

  const ordered = orderParentFirst(ir.nodes);
  const assets = new AssetTable(input, opts, ir.sceneSpace);
  const fonts = new FontTable();
  const sparse = new SparseAnalysis(ir, library, input.motion, cameraFolded);

  const layers: LottieLayer[] = [];
  const skewConflicts: string[] = [];
  let keyframes = 0;
  let bakedKeyframes = 0;

  for (const node of ordered) {
    const samples = frames.map(
      (_, index) => at(poses, index).get(node.id) ?? restPose(node, ir.sceneSpace),
    );
    const transform = buildTransform(node, frames, samples, sparse, opts, skewConflicts);
    keyframes += transform.keyframes;
    bakedKeyframes += transform.baked;

    layers.push({
      ddd: 0,
      ind: 0, // rewritten once paint order is known
      ty: layerType(node),
      nm: node.name,
      mn: node.id,
      sr: 1,
      ks: transform.value,
      ao: 0,
      ip: 0,
      op: frameCount,
      st: 0,
      bm: 0,
      ...layerBody(node, assets, fonts, opts),
    });
  }

  const painted = paintOrder(ordered, layers);
  const document: LottieDocument = {
    v: opts.version,
    fr: ir.fps,
    ip: 0,
    op: frameCount,
    w: ir.sceneSpace.width,
    h: ir.sceneSpace.height,
    nm: ir.name,
    ddd: 0,
    assets: assets.list(),
    layers: painted,
    markers: ir.markers.map((marker) => toMarker(marker, ir.fps)),
    ...(fonts.isEmpty() ? {} : { fonts: { list: fonts.list() } }),
  };

  const fidelity = opts.measureFidelity
    ? measureFidelity(ir, painted, frameCount, evaluateOptions, cameraFolded)
    : undefined;

  return {
    document,
    keyframeCount: keyframes,
    bakedKeyframeCount: bakedKeyframes,
    sampledFrames: frames.length,
    fidelity,
    skewConflicts,
    cameraFolded,
  };
}

function frameToMs(frame: number, fps: number): number {
  return (frame * 1000) / fps;
}

function layerType(node: AnimNode): number {
  switch (node.kind) {
    case 'asset-instance':
      return LOTTIE_LAYER.image;
    case 'text':
      return LOTTIE_LAYER.text;
    case 'shape':
      return LOTTIE_LAYER.shape;
    case 'group':
    case 'part':
    case 'bone':
    case 'fx-emitter':
      return LOTTIE_LAYER.null;
  }
}

/**
 * Paint order.
 *
 * Our renderer draws high `depth` first (further from camera) and later siblings on top.
 * Lottie draws the **first** layer in the array on top, so the array is the reverse of
 * our paint order. Getting this backwards produces a file where every layer is present
 * and the picture is inside out.
 */
function paintOrder(
  ordered: readonly AnimNode[],
  layers: readonly LottieLayer[],
): readonly LottieLayer[] {
  const indexed = layers.map((layer, index) => ({ layer, index, depth: at(ordered, index).depth }));
  indexed.sort((left, right) => right.depth - left.depth || left.index - right.index);
  indexed.reverse();
  return indexed.map((entry, position) => ({ ...entry.layer, ind: position + 1 }));
}

function toMarker(marker: Marker, fps: number): { tm: number; cm: string; dr: number } {
  return { tm: (marker.timeMs * fps) / 1000, cm: marker.label, dr: 0 };
}

// ── poses ───────────────────────────────────────────────────────────────────

function posesAt(
  ir: AnimationIR,
  timeMs: number,
  options: EvaluateOptions,
  foldCamera: boolean,
): ReadonlyMap<NodeId, LayerPose> {
  const snapshot = evaluate(ir, timeMs, options);
  const visibility = new Map(ir.nodes.map((node) => [node.id, node.visible]));

  const poses = new Map<NodeId, LayerPose>();
  for (const resolved of snapshot.nodes) {
    poses.set(
      resolved.nodeId,
      toPose(
        resolved,
        visibility.get(resolved.nodeId) ?? true,
        snapshot.camera,
        ir.sceneSpace,
        foldCamera,
      ),
    );
  }
  return poses;
}

function toPose(
  resolved: ResolvedNode,
  visible: boolean,
  camera: SceneSnapshot['camera'],
  sceneSpace: Size,
  foldCamera: boolean,
): LayerPose {
  const world = resolved.worldTransform;
  // The camera is passed only when it is being folded in; omitted, the conversion is the
  // centre shift alone. See `../scene-space.ts` for why the shift is not optional.
  const position = toCompositionSpace(world.position, sceneSpace, foldCamera ? camera : undefined);
  const zoom = foldCamera ? camera.zoom : 1;
  return {
    position: [position.x, position.y],
    scalePercent: [world.scale.x * zoom * 100, world.scale.y * zoom * 100],
    rotation: foldCamera ? world.rotation - camera.rotation : world.rotation,
    opacityPercent: (visible ? world.opacity : 0) * 100,
    skew: [world.skew.x, world.skew.y],
  };
}

/** The pose of a node the evaluator did not resolve. Defensive; the schema prevents it. */
function restPose(node: AnimNode, sceneSpace: Size): LayerPose {
  const t = node.transform;
  const centre = sceneCentreOf(sceneSpace);
  return {
    position: [centre.x + t.position.x, centre.y + t.position.y],
    scalePercent: [t.scale.x * 100, t.scale.y * 100],
    rotation: t.rotation,
    opacityPercent: (node.visible ? t.opacity : 0) * 100,
    skew: [t.skew.x, t.skew.y],
  };
}

// ── transforms ──────────────────────────────────────────────────────────────

interface BuiltTransform {
  readonly value: LottieTransform;
  readonly keyframes: number;
  readonly baked: number;
}

function buildTransform(
  node: AnimNode,
  frames: readonly number[],
  samples: readonly LayerPose[],
  sparse: SparseAnalysis,
  opts: ResolvedLottieOptions,
  skewConflicts: string[],
): BuiltTransform {
  const position = buildProperty(
    node,
    ['position.x', 'position.y'],
    frames,
    samples.map((pose) => pose.position),
    sparse,
    opts,
  );
  const scale = buildProperty(
    node,
    ['scale.x', 'scale.y'],
    frames,
    samples.map((pose) => pose.scalePercent),
    sparse,
    opts,
  );
  const rotation = buildProperty(
    node,
    ['rotation'],
    frames,
    samples.map((pose) => [pose.rotation]),
    sparse,
    opts,
  );
  const opacity = buildProperty(
    node,
    ['opacity'],
    frames,
    samples.map((pose) => [pose.opacityPercent]),
    sparse,
    opts,
  );

  const skew = buildSkew(node, frames, samples, opts, skewConflicts);

  const value: LottieTransform = {
    // The IR's anchor is normalised over bounds the IR does not carry, and Lottie's is in
    // pixels. Writing the layer origin is the one choice that is exactly right for the
    // world transforms above; `track:anchor` is reported as dropped.
    a: staticProperty([0, 0]),
    p: position.property,
    s: scale.property,
    r: rotation.property,
    o: opacity.property,
    ...(skew === undefined ? {} : { sk: skew.sk, sa: skew.sa }),
  };

  const parts = [position, scale, rotation, opacity];
  return {
    value,
    keyframes:
      parts.reduce((sum, part) => sum + keyframeCount(part.property), 0) + (skew?.keyframes ?? 0),
    baked:
      parts.reduce((sum, part) => sum + (part.baked ? keyframeCount(part.property) : 0), 0) +
      (skew?.keyframes ?? 0),
  };
}

interface BuiltProperty {
  readonly property: LottieProperty;
  readonly baked: boolean;
}

function buildProperty(
  node: AnimNode,
  channels: readonly AnimChannel[],
  frames: readonly number[],
  samples: readonly (readonly number[])[],
  sparse: SparseAnalysis,
  opts: ResolvedLottieOptions,
): BuiltProperty {
  const authored = sparse.authored(node, channels, opts);
  if (authored !== undefined) return { property: authored, baked: false };
  return {
    property: bakedProperty(frames, samples, {
      tolerance: opts.tolerance,
      precision: opts.precision,
    }),
    baked: true,
  };
}

/**
 * Skew, and the component that cannot come with it.
 *
 * The IR shears x by y and y by x independently. Lottie has one angle (`sk`) and one axis
 * (`sa`), so at most one of them is expressible. The axis follows whichever component is
 * actually used; a node using both loses the second and is reported.
 */
function buildSkew(
  node: AnimNode,
  frames: readonly number[],
  samples: readonly LayerPose[],
  opts: ResolvedLottieOptions,
  skewConflicts: string[],
): { sk: LottieProperty; sa: LottieProperty; keyframes: number } | undefined {
  const usesX = samples.some((pose) => pose.skew[0] !== 0);
  const usesY = samples.some((pose) => pose.skew[1] !== 0);
  if (!usesX && !usesY) return undefined;
  if (usesX && usesY) skewConflicts.push(node.id);

  const axis = usesX ? 0 : 1;
  const property = bakedProperty(
    frames,
    samples.map((pose) => [pose.skew[axis]]),
    { tolerance: opts.tolerance, precision: opts.precision },
  );
  return {
    sk: property,
    sa: staticProperty(axis === 0 ? 0 : 90),
    keyframes: keyframeCount(property),
  };
}

// ── the sparse path ─────────────────────────────────────────────────────────

/**
 * Deciding when authored keyframes can be written straight through.
 *
 * Baking everything would be simpler and would throw away the thing that makes the IR
 * worth having: a three-second eased move is four keyframes with two bezier handles, and
 * ninety keyframes once sampled. So a property is written from its own track keyframes
 * whenever doing so is *provably* identical to what the evaluator computes, and baked
 * otherwise. The conditions are conservative by design - a wrong "yes" here is a file
 * that silently disagrees with its preview, which is the one failure this package exists
 * to prevent.
 */
class SparseAnalysis {
  readonly #tracks: ReadonlyMap<string, readonly Track[]>;
  readonly #behaviourNodes: ReadonlySet<NodeId>;
  readonly #library: EasingLibrary;
  readonly #fps: number;
  readonly #enabled: boolean;
  /** Scene origin to Lottie origin. See {@link sceneCentreOf}. */
  readonly #centre: Vec2;

  constructor(
    ir: AnimationIR,
    library: EasingLibrary,
    motion: ExportInput['motion'],
    cameraFolded: boolean,
  ) {
    const tracks = new Map<string, Track[]>();
    for (const track of ir.tracks) {
      const key = `${track.nodeId}|${track.channel}`;
      const bucket = tracks.get(key);
      if (bucket === undefined) tracks.set(key, [track]);
      else bucket.push(track);
    }
    this.#tracks = tracks;
    this.#behaviourNodes = new Set(
      ir.behaviours.filter((behaviour) => behaviour.enabled).map((behaviour) => behaviour.nodeId),
    );
    this.#library = library;
    this.#fps = ir.fps;
    this.#centre = sceneCentreOf(ir.sceneSpace);
    // A stepped cadence quantises time before anything is evaluated, and a tempo other
    // than 1 rescales it. Both make "the value at the authored keyframe time" the wrong
    // answer, so neither is eligible.
    this.#enabled =
      !cameraFolded && (motion?.stepMode ?? 'smooth') === 'smooth' && (motion?.tempo ?? 1) === 1;
  }

  /**
   * The property written from authored keyframes, or `undefined` to bake.
   *
   * Vector properties are decided jointly: Lottie stores position as one property, so x
   * and y must share a keyframe grid and an easing or the two cannot be written as one.
   */
  authored(
    node: AnimNode,
    channels: readonly AnimChannel[],
    opts: ResolvedLottieOptions,
  ): LottieProperty | undefined {
    if (!this.#enabled) return undefined;
    // Only a root node's world transform is its own local transform. Anything deeper is
    // a composition, and a composition of two eased curves is not an eased curve.
    if (node.parentId !== null) return undefined;
    if (this.#behaviourNodes.has(node.id)) return undefined;

    const tracks = channels.map((channel) => this.#trackFor(node.id, channel));
    const present = tracks.filter((track): track is Track => track !== undefined);
    if (present.length === 0) return undefined;

    const grid = at(present, 0).keyframes.map((keyframe) => keyframe.timeMs);
    for (const track of present) {
      if (track.additive || track.before !== 'hold' || track.after !== 'hold') return undefined;
      if (track.keyframes.length !== grid.length) return undefined;
      if (track.keyframes.some((keyframe, index) => keyframe.timeMs !== grid[index]))
        return undefined;
      if (!track.keyframes.every((keyframe) => isExactlyRepresentable(keyframe.easing))) {
        return undefined;
      }
    }

    // Every component of a vector property shares one set of handles, so two tracks that
    // ease differently cannot be merged into one Lottie property.
    const eases = at(present, 0).keyframes.map((keyframe) =>
      toSegmentEase(keyframe.easing, this.#library),
    );
    for (const track of present) {
      const own = track.keyframes.map((keyframe) => toSegmentEase(keyframe.easing, this.#library));
      if (!own.every((ease, index) => sameEase(ease, at(eases, index)))) return undefined;
    }

    const values = grid.map((_, index) =>
      channels.map((channel, position) =>
        this.#valueFor(node, channel, tracks[position]?.keyframes[index]?.value),
      ),
    );

    if (channels.includes('opacity') && !this.#opacitySafe(node, present, values)) return undefined;

    return authoredProperty(
      grid.map((timeMs, index) => ({
        frame: roundTo((timeMs * this.#fps) / 1000, opts.precision),
        value: at(values, index),
      })),
      eases,
      opts.precision,
    );
  }

  #trackFor(nodeId: NodeId, channel: AnimChannel): Track | undefined {
    const bucket = this.#tracks.get(`${nodeId}|${channel}`);
    // Two tracks on one channel means the later one wins during evaluation. Representable,
    // but only by re-deriving the fold - which is what baking already does correctly.
    if (bucket?.length !== 1) return undefined;
    return at(bucket, 0);
  }

  /**
   * A channel's value, folded onto the node's authored transform exactly as
   * `applyDeltas` in the evaluator does it: positions and angles are offsets, scale and
   * opacity are multipliers.
   */
  #valueFor(node: AnimNode, channel: AnimChannel, delta: number | undefined): number {
    const base = node.transform;
    const d = delta ?? 0;
    switch (channel) {
      // Shifted into the composition's top-left origin exactly as `toCompositionSpace`
      // does for the baked path. The sparse path only runs with the camera unfolded, so
      // the centre offset is the whole of the conversion.
      case 'position.x':
        return this.#centre.x + base.position.x + d;
      case 'position.y':
        return this.#centre.y + base.position.y + d;
      case 'rotation':
        return base.rotation + d;
      case 'scale.x':
        return base.scale.x * (1 + d) * 100;
      case 'scale.y':
        return base.scale.y * (1 + d) * 100;
      case 'opacity':
        return (node.visible ? clamp01(base.opacity * (1 + d)) : 0) * 100;
      default:
        // Only the four transform properties take the sparse path; everything else is
        // baked, so no other channel reaches here.
        return d;
    }
  }

  /**
   * Whether opacity can be written sparsely.
   *
   * The evaluator clamps opacity to 0..1 *after* multiplying, and a clamp is not affine -
   * once it engages, the eased curve between two keyframes is no longer the eased curve
   * between the mapped values. An overshooting handle can also push the interpolation
   * outside the range between two keyframes that are themselves in range. Either case
   * bakes.
   */
  #opacitySafe(
    node: AnimNode,
    tracks: readonly Track[],
    values: readonly (readonly number[])[],
  ): boolean {
    const unclamped = tracks.some((track) =>
      track.keyframes.some((keyframe) => {
        const raw = node.transform.opacity * (1 + keyframe.value);
        return raw < 0 || raw > 1;
      }),
    );
    if (unclamped) return false;
    if (values.some((value) => value.some((component) => component < 0 || component > 100))) {
      return false;
    }
    return !tracks.some((track) =>
      track.keyframes.some((keyframe) => overshoots(keyframe.easing, this.#library)),
    );
  }
}

function sameEase(left: LottieSegmentEase, right: LottieSegmentEase): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'hold' || right.kind === 'hold') return true;
  return (
    left.out.x[0] === right.out.x[0] &&
    left.out.y[0] === right.out.y[0] &&
    left.in.x[0] === right.in.x[0] &&
    left.in.y[0] === right.in.y[0]
  );
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ── layer bodies ────────────────────────────────────────────────────────────

class AssetTable {
  readonly #byKey = new Map<string, LottieImageAsset>();
  readonly #size: Size;
  readonly #dir: string;

  constructor(input: ExportInput, opts: ResolvedLottieOptions, sceneSpace: Size) {
    this.#size = partsExtent(input) ?? sceneSpace;
    this.#dir = opts.imageDir;
  }

  refFor(ref: PinnedAssetRef): LottieImageAsset {
    const key = `${ref.assetId}|${ref.versionId}|${ref.variantKey ?? ''}`;
    const existing = this.#byKey.get(key);
    if (existing !== undefined) return existing;

    const suffix = ref.variantKey === undefined ? '' : `_${ref.variantKey}`;
    const asset: LottieImageAsset = {
      id: `image_${String(this.#byKey.size)}`,
      w: this.#size.width,
      h: this.#size.height,
      u: this.#dir,
      p: `${ref.assetId}_${ref.versionId}${suffix}.png`,
      e: 0,
    };
    this.#byKey.set(key, asset);
    return asset;
  }

  list(): readonly LottieImageAsset[] {
    return [...this.#byKey.values()];
  }
}

/** The union of the supplied parts' bounds - the asset's own canvas extent, near enough. */
function partsExtent(input: ExportInput): Size | undefined {
  const parts = input.parts;
  if (parts === undefined || parts.length === 0) return undefined;
  let width = 0;
  let height = 0;
  for (const entry of parts) {
    width = Math.max(width, Math.ceil(entry.part.bounds.x + entry.part.bounds.width));
    height = Math.max(height, Math.ceil(entry.part.bounds.y + entry.part.bounds.height));
  }
  return width > 0 && height > 0 ? { width, height } : undefined;
}

class FontTable {
  readonly #byName = new Map<string, LottieFont>();

  use(styleName: string): string {
    const existing = this.#byName.get(styleName);
    if (existing !== undefined) return existing.fName;
    const font: LottieFont = {
      fName: styleName,
      fFamily: styleName,
      fStyle: 'Regular',
      fWeight: 'normal',
      ascent: 72,
    };
    this.#byName.set(styleName, font);
    return font.fName;
  }

  isEmpty(): boolean {
    return this.#byName.size === 0;
  }

  list(): readonly LottieFont[] {
    return [...this.#byName.values()];
  }
}

function layerBody(
  node: AnimNode,
  assets: AssetTable,
  fonts: FontTable,
  opts: ResolvedLottieOptions,
): Partial<LottieLayer> {
  switch (node.kind) {
    case 'asset-instance': {
      const asset = assets.refFor(node.asset);
      return { refId: asset.id, w: asset.w, h: asset.h };
    }
    case 'text':
      return { t: textData(node, fonts, opts) };
    case 'shape':
      return { shapes: shapeItems(node, opts) };
    case 'group':
    case 'part':
    case 'bone':
    case 'fx-emitter':
      return {};
  }
}

const TEXT_JUSTIFICATION: Readonly<Record<TextNode['align'], number>> = {
  start: 0,
  center: 1,
  end: 2,
};

function textData(node: TextNode, fonts: FontTable, opts: ResolvedLottieOptions): LottieTextData {
  return {
    d: {
      k: [
        {
          t: 0,
          s: {
            f: fonts.use(node.styleName),
            fc: hexToRgb01(node.color ?? '#000000'),
            j: TEXT_JUSTIFICATION[node.align],
            lh: roundTo(DEFAULT_FONT_SIZE * DEFAULT_LINE_HEIGHT_RATIO, opts.precision),
            ls: 0,
            s: DEFAULT_FONT_SIZE,
            t: node.text,
            tr: 0,
          },
        },
      ],
    },
    a: [],
    p: {},
    m: { g: 1, a: staticProperty([0, 0]) },
  };
}

function shapeItems(node: ShapeNode, opts: ResolvedLottieOptions): readonly LottieShapeItem[] {
  const items: LottieShapeItem[] = [];

  const geometry = shapeGeometry(node);
  if (geometry !== undefined) items.push(geometry);

  if (node.fill !== undefined) {
    items.push({
      ty: 'fl',
      c: staticProperty(hexToRgb01(node.fill)),
      o: staticProperty(roundTo(hexAlpha(node.fill) * 100, opts.precision)),
      r: 1,
    });
  }
  if (node.stroke !== undefined) {
    items.push({
      ty: 'st',
      c: staticProperty(hexToRgb01(node.stroke)),
      o: staticProperty(roundTo(hexAlpha(node.stroke) * 100, opts.precision)),
      w: staticProperty(node.strokeWidth),
      lc: 2,
      lj: 2,
    });
  }

  // A group's item list must end with its own transform, or lottie-web ignores the group.
  items.push({
    ty: 'tr',
    p: staticProperty([0, 0]),
    a: staticProperty([0, 0]),
    s: staticProperty([100, 100]),
    r: staticProperty(0),
    o: staticProperty(100),
  });

  return [{ ty: 'gr', nm: node.name, it: items }];
}

function shapeGeometry(node: ShapeNode): LottieShapeItem | undefined {
  switch (node.shape) {
    case 'rect': {
      const size = node.size;
      if (size === undefined) return undefined;
      return {
        ty: 'rc',
        d: 1,
        s: staticProperty([size.width, size.height]),
        p: staticProperty([0, 0]),
        r: staticProperty(0),
      };
    }
    case 'ellipse': {
      const size = node.size;
      if (size === undefined) return undefined;
      return {
        ty: 'el',
        d: 1,
        s: staticProperty([size.width, size.height]),
        p: staticProperty([0, 0]),
      };
    }
    case 'line':
    case 'polygon': {
      const points = parsePoints(node.geometry);
      if (points.length < 2) return undefined;
      return {
        ty: 'sh',
        d: 1,
        ks: {
          a: 0,
          k: {
            i: points.map(() => [0, 0]),
            o: points.map(() => [0, 0]),
            v: points,
            c: node.shape === 'polygon',
          },
        },
      };
    }
    case 'path':
      // SVG path data carries arcs and cubic segments that would have to be re-fitted to
      // Lottie's vertex/tangent model. Reported as dropped rather than approximated with
      // a straight-line fit nobody asked for.
      return undefined;
  }
}

/**
 * `"x,y x,y"` or `"x y x y"` into vertex pairs. Trailing odd values are ignored.
 *
 * Deliberately identical to `parsePoints` in `@rv/render-engine` (`backends/painter.ts`),
 * down to which tokens it looks at: only the ones it consumes. Rejecting the whole
 * geometry over a trailing token the renderer never reads would mean the preview draws a
 * polygon and the export drops it, with no warning to say so - `node:shape` is declared
 * exact, so a silent omission here is a lie about what the file contains.
 */
function parsePoints(geometry: string | undefined): readonly (readonly [number, number])[] {
  if (geometry === undefined) return [];
  const numbers = geometry
    .split(/[\s,]+/u)
    .filter((token) => token.length > 0)
    .map(Number);

  const points: [number, number][] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    const x = at(numbers, index);
    const y = at(numbers, index + 1);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    points.push([x, y]);
  }
  return points;
}

function expandHex(hex: string): string {
  const body = hex.slice(1);
  return body.length === 3
    ? body
        .split('')
        .map((character) => character + character)
        .join('')
    : body;
}

/** `#rgb` / `#rrggbb` / `#rrggbbaa` to Lottie's 0..1 triple. */
export function hexToRgb01(hex: string): readonly number[] {
  const body = expandHex(hex);
  return [
    Number.parseInt(body.slice(0, 2), 16) / 255,
    Number.parseInt(body.slice(2, 4), 16) / 255,
    Number.parseInt(body.slice(4, 6), 16) / 255,
  ];
}

function hexAlpha(hex: string): number {
  const body = expandHex(hex);
  return body.length === 8 ? Number.parseInt(body.slice(6, 8), 16) / 255 : 1;
}

// ── measuring what was written ──────────────────────────────────────────────

/**
 * Reads the emitted layers back and compares them against the evaluator, frame by frame.
 *
 * This is the number that makes the whole package trustworthy. It is measured with
 * {@link sampleLottieProperty}, which eases through `cubicBezierAt` from
 * `@rv/anim-engine` - the renderer's own solver - so a mismatch here is a genuine
 * disagreement between the file and its preview rather than two implementations of the
 * same curve rounding differently.
 */
function measureFidelity(
  ir: AnimationIR,
  layers: readonly LottieLayer[],
  frameCount: number,
  options: EvaluateOptions,
  foldCamera: boolean,
): FidelityReport {
  const byNode = new Map(layers.map((layer) => [layer.mn, layer]));
  const position = new Accumulator();
  const rotation = new Accumulator();
  const scale = new Accumulator();
  const opacity = new Accumulator();
  let samples = 0;

  for (let frame = 0; frame <= frameCount; frame += 1) {
    const poses = posesAt(ir, frameToMs(frame, ir.fps), options, foldCamera);
    for (const [nodeId, expected] of poses) {
      const layer = byNode.get(nodeId);
      if (layer === undefined) continue;

      const actualPosition = sampleLottieProperty(layer.ks.p, frame);
      position.add((actualPosition[0] ?? 0) - expected.position[0]);
      position.add((actualPosition[1] ?? 0) - expected.position[1]);

      const actualScale = sampleLottieProperty(layer.ks.s, frame);
      scale.add((actualScale[0] ?? 0) - expected.scalePercent[0]);
      scale.add((actualScale[1] ?? 0) - expected.scalePercent[1]);

      rotation.add((sampleLottieProperty(layer.ks.r, frame)[0] ?? 0) - expected.rotation);
      opacity.add((sampleLottieProperty(layer.ks.o, frame)[0] ?? 0) - expected.opacityPercent);
      samples += 1;
    }
  }

  const report = {
    samples,
    positionPx: position.stat(),
    rotationDeg: rotation.stat(),
    scalePercent: scale.stat(),
    opacityPercent: opacity.stat(),
  };
  return {
    ...report,
    worst: Math.max(
      report.positionPx.max,
      report.rotationDeg.max,
      report.scalePercent.max,
      report.opacityPercent.max,
    ),
  };
}

class Accumulator {
  #max = 0;
  #sumSquares = 0;
  #count = 0;

  add(error: number): void {
    const absolute = Math.abs(error);
    if (absolute > this.#max) this.#max = absolute;
    this.#sumSquares += error * error;
    this.#count += 1;
  }

  stat(): ErrorStat {
    return {
      max: this.#max,
      rms: this.#count === 0 ? 0 : Math.sqrt(this.#sumSquares / this.#count),
    };
  }
}

// ── warnings ────────────────────────────────────────────────────────────────

function assembleWarnings(
  ir: AnimationIR,
  opts: ResolvedLottieOptions,
  built: BuiltDocument,
): readonly ExportWarning[] {
  const present = detectIrFeatures(ir);
  const base = diffFeatures(present, LOTTIE_CAPABILITIES);

  const warnings: ExportWarning[] = base.map((warning) => {
    if (warning.feature.startsWith('behaviour:')) {
      return {
        ...warning,
        detail: `${warning.detail}; ${String(warning.ids.length)} behaviour(s) baked at ${String(ir.fps)} fps with stride ${String(opts.stride)} into ${String(built.bakedKeyframeCount)} keyframe(s) across the file`,
      };
    }
    if (
      (warning.feature === 'camera:track' || warning.feature === 'camera:shake') &&
      !built.cameraFolded
    ) {
      return {
        ...warning,
        disposition: 'dropped' as const,
        detail:
          'Lottie has no camera and `applyCamera` was disabled, so the camera is absent from the file and the layers hold raw scene coordinates',
      };
    }
    return warning;
  });

  if (built.skewConflicts.length > 0 && !warnings.some((w) => w.feature === 'track:skew')) {
    warnings.push({
      feature: 'track:skew',
      disposition: 'approximated',
      detail:
        'a node skews on both axes at once; Lottie has one skew angle and one axis, so the y component was not written',
      ids: built.skewConflicts,
    });
  }

  return warnings.sort((left, right) => left.feature.localeCompare(right.feature));
}
