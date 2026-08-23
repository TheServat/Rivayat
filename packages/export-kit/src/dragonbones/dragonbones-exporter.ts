/**
 * `Rig + AnimationIR → DragonBones 5.5 JSON`.
 *
 * Research §5 keeps DragonBones as an export target for the reason ADR-0001 rejected it
 * as a source: its editor is effectively unmaintained, so the format is **frozen**, and a
 * frozen well-documented format is exactly what you want on the way out. Its runtimes are
 * widely embedded - Cocos, Egret, Phaser via a plugin, and the standalone JS runtime - so
 * a skeleton written here opens in engines we will never integrate with directly.
 *
 * The mapping is structural, and three things about it are worth knowing before reading
 * the numbers:
 *
 *  - **Bones come from the `Rig`, animation comes from the IR.** They are joined by
 *    *role*: a clip fragment's nodes are named after the archetype template's bone roles
 *    (the same join `bakeSheet` uses), so one fragment animates every asset of its
 *    archetype regardless of which bone ids a particular fitting minted.
 *  - **DragonBones bone frames are deltas from the rest pose**, so every emitted value is
 *    the evaluated local transform minus the bone's rest - not the world transform.
 *  - **There are no procedural behaviours**, so they are sampled onto the frame grid,
 *    exactly as for Lottie and with the same `stride` dial.
 *
 * What does not map is declared in {@link DRAGONBONES_CAPABILITIES}: shapes, text,
 * particles, the camera, the IR's independent x/y skew, and per-node tint.
 */

import { type AppError, type Result, ValidationError, at, err, isErr, ok } from '@rv/shared-kernel';
import type {
  AnimationClip,
  AnimationIR,
  Bone,
  BoneId,
  LoopMode,
  Part,
  Rig,
  Size,
  Transform2D,
} from '@rv/contracts';
import { type EvaluateOptions, evaluate, rotateVec } from '@rv/anim-engine';

import { detectFeatures, type IrFeature } from '../features';
import type { DragonBonesOptions, ExportOptions } from '../options';
import type { ImageEncoderPort } from '../pixels';
import {
  type ExportArtifact,
  type ExportInput,
  type ExportOutput,
  type Exporter,
  binaryArtifact,
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
import { type AtlasFrameSource, packAtlas, resolveAtlasOptions } from '../atlas/pack';

export const DRAGONBONES_FORMAT_ID = 'dragonbones';

const DEFAULT_VERSION = '5.5';
/** Tween codes: `0` is linear. Omitting the field entirely means "no tween". */
const TWEEN_LINEAR = 0;

export const DRAGONBONES_CAPABILITIES: FormatCapabilities = {
  exact: new Set<IrFeature>([
    // The bone hierarchy is the format's core idea, and animation is written as locals
    // relative to it, so the structure survives intact.
    'node:hierarchy',
    'node:group',
    'track:additive',
    'track:extrapolation',
  ]),
  approximate: new Map<IrFeature, ApproximationNote>([
    [
      'node:asset-instance',
      {
        disposition: 'restructured',
        detail:
          'the instance becomes the armature itself: its parts become slots and skin displays, and its rig becomes the bone list',
      },
    ],
    [
      'node:part',
      { disposition: 'restructured', detail: 'written as a slot with one image display' },
    ],
    ['node:bone', { disposition: 'restructured', detail: 'written as a bone in the armature' }],
    [
      'track:position',
      {
        disposition: 'approximated',
        detail:
          'sampled onto the frame grid as `translateFrame` deltas from the bone rest: exact at frame times, linearly tweened in between',
      },
    ],
    [
      'track:rotation',
      {
        disposition: 'approximated',
        detail: 'sampled onto the frame grid as `rotateFrame` deltas from the bone rest',
      },
    ],
    [
      'track:scale',
      {
        disposition: 'approximated',
        detail: 'sampled onto the frame grid as `scaleFrame` multipliers of the bone rest',
      },
    ],
    [
      'track:opacity',
      {
        disposition: 'approximated',
        detail:
          'DragonBones alpha lives on a slot, not a bone, so per-node opacity is written to every slot the node’s bone owns',
      },
    ],
    [
      'markers',
      {
        disposition: 'approximated',
        detail:
          'written as animation frame events carrying the marker’s label; the marker kind has no equivalent',
      },
    ],
    ...(
      [
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
      ] as const satisfies readonly IrFeature[]
    ).map((feature): readonly [IrFeature, ApproximationNote] => [
      feature,
      {
        disposition: 'approximated',
        detail:
          'DragonBones has no procedural motion; the behaviour was sampled onto the frame grid and written as bone frames',
      },
    ]),
  ]),
};

// ── the emitted document ────────────────────────────────────────────────────

interface DbTransform {
  readonly x?: number;
  readonly y?: number;
  /** Skew-x. With `skY` equal to it, this is a plain rotation in degrees. */
  readonly skX?: number;
  readonly skY?: number;
  readonly scX?: number;
  readonly scY?: number;
}

interface DbBone {
  readonly name: string;
  readonly parent?: string;
  readonly length?: number;
  readonly transform?: DbTransform;
}

interface DbSlot {
  readonly name: string;
  readonly parent: string;
  readonly displayIndex: number;
}

interface DbSkinSlot {
  readonly name: string;
  readonly display: readonly {
    readonly type: 'image';
    readonly name: string;
    readonly transform?: DbTransform;
  }[];
}

interface DbSkin {
  readonly name: string;
  readonly slot: readonly DbSkinSlot[];
}

interface DbValueFrame {
  readonly duration: number;
  readonly tweenEasing?: number;
  readonly x?: number;
  readonly y?: number;
  readonly rotate?: number;
}

interface DbColorFrame {
  readonly duration: number;
  readonly tweenEasing?: number;
  readonly value: { readonly aM: number };
}

interface DbBoneTimeline {
  readonly name: string;
  readonly translateFrame?: readonly DbValueFrame[];
  readonly rotateFrame?: readonly DbValueFrame[];
  readonly scaleFrame?: readonly DbValueFrame[];
}

interface DbSlotTimeline {
  readonly name: string;
  readonly colorFrame: readonly DbColorFrame[];
}

interface DbEventFrame {
  readonly duration: number;
  readonly events: readonly { readonly name: string }[];
}

interface DbAnimation {
  readonly duration: number;
  /** 0 loops forever; 1 plays once. */
  readonly playTimes: number;
  readonly name: string;
  readonly bone?: readonly DbBoneTimeline[];
  readonly slot?: readonly DbSlotTimeline[];
  readonly frame?: readonly DbEventFrame[];
}

interface DbArmature {
  readonly type: 'Armature';
  readonly frameRate: number;
  readonly name: string;
  readonly aabb: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly bone: readonly DbBone[];
  readonly slot: readonly DbSlot[];
  readonly skin: readonly DbSkin[];
  readonly animation: readonly DbAnimation[];
  readonly defaultActions: readonly { readonly gotoAndPlay: string }[];
}

interface DbSkeleton {
  readonly frameRate: number;
  readonly name: string;
  readonly version: string;
  readonly compatibleVersion: string;
  readonly armature: readonly DbArmature[];
}

interface DbTextureAtlas {
  readonly width: number;
  readonly height: number;
  readonly name: string;
  readonly imagePath: string;
  readonly SubTexture: readonly {
    readonly name: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly frameX?: number;
    readonly frameY?: number;
    readonly frameWidth?: number;
    readonly frameHeight?: number;
  }[];
}

// ── the exporter ────────────────────────────────────────────────────────────

interface ResolvedDbOptions {
  readonly name: string;
  readonly stride: number;
  readonly version: string;
}

export class DragonBonesExporter implements Exporter {
  readonly id = DRAGONBONES_FORMAT_ID;
  readonly label = 'DragonBones';
  readonly formatSpec =
    'DragonBones 5.5 skeleton JSON (`<name>_ske.json`) plus, when parts are supplied, a texture atlas (`<name>_tex.json` / `<name>_tex.png`)';
  readonly requires = ['rig'] as const;
  readonly capabilities = DRAGONBONES_CAPABILITIES;

  readonly #encoder: ImageEncoderPort | undefined;

  constructor(deps: { readonly encoder?: ImageEncoderPort } = {}) {
    this.#encoder = deps.encoder;
  }

  async export(
    input: ExportInput,
    options: ExportOptions = {},
  ): Promise<Result<ExportOutput, AppError>> {
    const rig = input.rig;
    if (rig === undefined) {
      return err(
        new ValidationError({
          message:
            'the DragonBones export needs a `rig`: an armature is bones, and the IR carries none',
        }),
      );
    }

    const opts = resolveOptions(input.ir, options.dragonBones ?? {});
    if (isErr(opts)) return opts;

    const built = buildSkeleton(input.ir, rig, input.parts ?? [], input.clips ?? [], opts.value, {
      motion: input.motion,
    });

    const artifacts: ExportArtifact[] = [
      jsonArtifact(`${opts.value.name}_ske.json`, built.skeleton),
    ];
    const warnings: ExportWarning[] = [
      ...diffFeatures(detectFeatures(input.ir), DRAGONBONES_CAPABILITIES),
    ];

    const texture = await this.#texturePage(input, opts.value, options);
    if (isErr(texture)) return texture;
    artifacts.push(...texture.value.artifacts);
    warnings.push(...texture.value.warnings);

    warnings.push(...built.warnings);
    warnings.sort((left, right) =>
      left.feature < right.feature ? -1 : left.feature > right.feature ? 1 : 0,
    );

    if (options.strict === true) {
      const lossy = lossyWarnings(warnings);
      if (lossy.length > 0) return err(new UnsupportedFeaturesError(this.id, lossy));
    }

    return ok({
      format: this.id,
      artifacts,
      warnings,
      stats: {
        totalBytes: totalBytes(artifacts),
        keyframeCount: built.frameCount,
        bakedKeyframeCount: built.frameCount,
        sampledFrames: built.sampledFrames,
        sampleStride: opts.value.stride,
      },
    });
  }

  /**
   * The companion texture page.
   *
   * Optional on purpose: a skeleton is useful on its own for inspection and for rebinding
   * to art that already exists in a host project, and requiring an encoder to produce one
   * would make the common case need infrastructure it does not use.
   */
  async #texturePage(
    input: ExportInput,
    opts: ResolvedDbOptions,
    options: ExportOptions,
  ): Promise<
    Result<{ artifacts: readonly ExportArtifact[]; warnings: readonly ExportWarning[] }, AppError>
  > {
    const parts = input.parts;
    const encoder = this.#encoder;
    if (parts === undefined || parts.length === 0 || encoder === undefined) {
      return ok({
        artifacts: [],
        warnings: [
          {
            feature: 'node:part' as const,
            disposition: 'dropped' as const,
            detail:
              'no parts or no image encoder were supplied, so the armature was written without its texture atlas; the slots reference displays that do not exist yet',
            ids: [],
          },
        ],
      });
    }

    const atlasOptions = resolveAtlasOptions(options.dragonBones?.atlas ?? {}, `${opts.name}_tex`);
    if (isErr(atlasOptions)) return atlasOptions;

    const sources: readonly AtlasFrameSource[] = parts.map((entry) => ({
      name: entry.part.name,
      image: entry.image,
      sourceSize: entry.part.size,
      pivot: entry.part.pivot,
    }));

    const packed = await packAtlas(sources, atlasOptions.value, encoder);
    if (isErr(packed)) return packed;

    const artifacts: ExportArtifact[] = [];
    const warnings: ExportWarning[] = [];

    if (packed.value.length > 1) {
      warnings.push({
        feature: 'node:part',
        disposition: 'approximated',
        detail: `the parts did not fit one texture page; DragonBones expects a single atlas per armature, so pages beyond the first were written but will not be found by the runtime`,
        ids: parts.map((entry) => entry.part.id),
      });
    }

    for (const page of packed.value) {
      const base = page.index === 0 ? `${opts.name}_tex` : `${opts.name}_tex-${String(page.index)}`;
      const imagePath = `${base}.png`;
      const atlas: DbTextureAtlas = {
        width: page.size.width,
        height: page.size.height,
        name: opts.name,
        imagePath,
        SubTexture: page.frames.map((frame) => ({
          name: frame.name,
          x: frame.rect.x,
          y: frame.rect.y,
          width: frame.rect.width,
          height: frame.rect.height,
          // DragonBones records the trim as a negative origin plus the untrimmed size,
          // which is the same information TexturePacker calls `spriteSourceSize`.
          frameX: -frame.trimOffset.x,
          frameY: -frame.trimOffset.y,
          frameWidth: frame.sourceSize.width,
          frameHeight: frame.sourceSize.height,
        })),
      };
      artifacts.push(binaryArtifact(imagePath, encoder.mediaType, page.image.data));
      artifacts.push(jsonArtifact(`${base}.json`, atlas));
    }

    return ok({ artifacts, warnings });
  }
}

function resolveOptions(
  ir: AnimationIR,
  raw: DragonBonesOptions,
): Result<ResolvedDbOptions, AppError> {
  const stride = raw.stride ?? 1;
  if (!Number.isInteger(stride) || stride < 1) {
    return err(
      new ValidationError({
        message: 'dragonBones stride must be a positive integer number of frames',
        context: { stride },
      }),
    );
  }
  return ok({
    name: raw.name ?? slugifyName(ir.name, 'armature'),
    stride,
    version: raw.version ?? DEFAULT_VERSION,
  });
}

// ── skeleton assembly ───────────────────────────────────────────────────────

interface BuiltSkeleton {
  readonly skeleton: DbSkeleton;
  readonly frameCount: number;
  readonly sampledFrames: number;
  readonly warnings: readonly ExportWarning[];
}

function buildSkeleton(
  ir: AnimationIR,
  rig: Rig,
  parts: readonly { readonly part: Part }[],
  clips: readonly AnimationClip[],
  opts: ResolvedDbOptions,
  context: { readonly motion: ExportInput['motion'] },
): BuiltSkeleton {
  const evaluateOptions: EvaluateOptions =
    context.motion === undefined ? {} : { motion: context.motion };

  const bones = rig.bones.map((bone) => toDbBone(bone, rig));
  const partById = new Map(parts.map((entry) => [entry.part.id, entry.part]));
  const worldRests = boneWorldRests(rig);

  const slots: DbSlot[] = [];
  const skinSlots: DbSkinSlot[] = [];
  for (const bone of rig.bones) {
    for (const partId of bone.partIds) {
      const part = partById.get(partId);
      if (part === undefined) continue;
      slots.push({ name: part.name, parent: bone.name, displayIndex: 0 });
      skinSlots.push({
        name: part.name,
        display: [
          {
            type: 'image',
            name: part.name,
            transform: displayTransform(part, worldRests.get(bone.id)),
          },
        ],
      });
    }
  }

  const warnings: ExportWarning[] = [];
  const animations =
    clips.length > 0
      ? clips.map((clip) => buildAnimation(ir, rig, slots, clip.name, clip, opts, evaluateOptions))
      : [
          buildAnimation(
            ir,
            rig,
            slots,
            slugifyName(ir.name, 'idle'),
            undefined,
            opts,
            evaluateOptions,
          ),
        ];

  for (const clip of clips) {
    if (clip.loop === 'ping-pong') {
      warnings.push({
        feature: 'track:extrapolation',
        disposition: 'approximated',
        detail: `clip "${clip.name}" is ping-pong; DragonBones only loops forwards, so it was written as a forward loop`,
        ids: [clip.id],
      });
    }
  }

  const first = at(animations, 0);
  const aabb = armatureBounds(
    parts.map((entry) => entry.part),
    ir.sceneSpace,
  );

  return {
    skeleton: {
      frameRate: ir.fps,
      name: opts.name,
      version: opts.version,
      compatibleVersion: opts.version,
      armature: [
        {
          type: 'Armature',
          frameRate: ir.fps,
          name: opts.name,
          aabb,
          bone: bones,
          slot: slots,
          skin: [{ name: '', slot: skinSlots }],
          animation: animations.map((entry) => entry.animation),
          defaultActions: [{ gotoAndPlay: first.animation.name }],
        },
      ],
    },
    frameCount: animations.reduce((sum, entry) => sum + entry.frames, 0),
    sampledFrames: animations.reduce((sum, entry) => sum + entry.samples, 0),
    warnings,
  };
}

function toDbBone(bone: Bone, rig: Rig): DbBone {
  const parent = rig.bones.find((candidate) => candidate.id === bone.parentId);
  return {
    name: bone.name,
    ...(parent === undefined ? {} : { parent: parent.name }),
    length: bone.rest.length,
    transform: {
      x: bone.rest.position.x,
      y: bone.rest.position.y,
      // Equal skew components are DragonBones' encoding of a plain rotation.
      skX: bone.rest.rotation,
      skY: bone.rest.rotation,
      scX: bone.rest.scale.x,
      scY: bone.rest.scale.y,
    },
  };
}

interface WorldRest {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/** Rest poses composed down the bone tree, so a part can be placed relative to its bone. */
function boneWorldRests(rig: Rig): ReadonlyMap<BoneId, WorldRest> {
  const byId = new Map(rig.bones.map((bone) => [bone.id, bone]));
  const resolved = new Map<BoneId, WorldRest>();

  const resolve = (bone: Bone): WorldRest => {
    const cached = resolved.get(bone.id);
    if (cached !== undefined) return cached;

    const parentBone = bone.parentId === null ? undefined : byId.get(bone.parentId);
    const parent: WorldRest =
      parentBone === undefined
        ? { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
        : resolve(parentBone);

    const scaled = {
      x: bone.rest.position.x * parent.scaleX,
      y: bone.rest.position.y * parent.scaleY,
    };
    const rotated = rotateVec(scaled, parent.rotation);
    const world: WorldRest = {
      x: parent.x + rotated.x,
      y: parent.y + rotated.y,
      rotation: parent.rotation + bone.rest.rotation,
      scaleX: parent.scaleX * bone.rest.scale.x,
      scaleY: parent.scaleY * bone.rest.scale.y,
    };
    resolved.set(bone.id, world);
    return world;
  };

  // The rig schema rejects cycles, so this terminates.
  for (const bone of rig.bones) resolve(bone);
  return resolved;
}

/**
 * Where a part's image hangs off its bone.
 *
 * The part knows where its pivot sits on the asset canvas; the bone knows where it sits
 * in the same space. The display transform is the difference, expressed in the bone's own
 * frame - which is what makes the art follow the bone instead of staying nailed to the
 * canvas.
 */
function displayTransform(part: Part, bone: WorldRest | undefined): DbTransform {
  const pivotOnCanvas = {
    x: part.bounds.x + part.pivot.x * part.bounds.width,
    y: part.bounds.y + part.pivot.y * part.bounds.height,
  };
  if (bone === undefined) return { x: pivotOnCanvas.x, y: pivotOnCanvas.y };

  const delta = { x: pivotOnCanvas.x - bone.x, y: pivotOnCanvas.y - bone.y };
  const local = rotateVec(delta, -bone.rotation);
  return {
    x: bone.scaleX === 0 ? 0 : local.x / bone.scaleX,
    y: bone.scaleY === 0 ? 0 : local.y / bone.scaleY,
    skX: -bone.rotation,
    skY: -bone.rotation,
  };
}

function armatureBounds(
  parts: readonly Part[],
  sceneSpace: Size,
): { x: number; y: number; width: number; height: number } {
  if (parts.length === 0) {
    return { x: 0, y: 0, width: sceneSpace.width, height: sceneSpace.height };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    minX = Math.min(minX, part.bounds.x);
    minY = Math.min(minY, part.bounds.y);
    maxX = Math.max(maxX, part.bounds.x + part.bounds.width);
    maxY = Math.max(maxY, part.bounds.y + part.bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ── animation ───────────────────────────────────────────────────────────────

const PLAY_TIMES: Readonly<Record<LoopMode, number>> = {
  loop: 0,
  'ping-pong': 0,
  once: 1,
  'hold-last': 1,
};

interface BuiltAnimation {
  readonly animation: DbAnimation;
  readonly frames: number;
  readonly samples: number;
}

function buildAnimation(
  ir: AnimationIR,
  rig: Rig,
  slots: readonly DbSlot[],
  name: string,
  clip: AnimationClip | undefined,
  opts: ResolvedDbOptions,
  evaluateOptions: EvaluateOptions,
): BuiltAnimation {
  const durationMs = clip?.durationMs ?? ir.durationMs;
  const frameCount = Math.max(1, Math.round((durationMs / 1000) * ir.fps));
  const frames = sampleFrames(frameCount, opts.stride);

  const nodeByName = new Map(ir.nodes.map((node) => [node.name, node]));
  const boneNode = new Map<BoneId, string>();
  for (const bone of rig.bones) {
    const node = nodeByName.get(bone.role) ?? nodeByName.get(bone.name);
    if (node !== undefined) boneNode.set(bone.id, node.id);
  }

  const snapshots = frames.map((frame) => {
    const snapshot = evaluate(ir, (frame * 1000) / ir.fps, evaluateOptions);
    return new Map(snapshot.nodes.map((node) => [node.nodeId, node.worldTransform]));
  });

  const boneById = new Map(rig.bones.map((bone) => [bone.id, bone]));
  const boneTimelines: DbBoneTimeline[] = [];
  const slotTimelines: DbSlotTimeline[] = [];
  let emitted = 0;

  for (const bone of rig.bones) {
    const nodeId = boneNode.get(bone.id);
    if (nodeId === undefined) continue;

    const parentBone = bone.parentId === null ? undefined : boneById.get(bone.parentId);
    const parentNodeId = parentBone === undefined ? undefined : boneNode.get(parentBone.id);

    const locals = snapshots.map((snapshot) => {
      const world = snapshot.get(nodeId);
      if (world === undefined) return undefined;
      const parentWorld = parentNodeId === undefined ? undefined : snapshot.get(parentNodeId);
      return decomposeLocal(parentWorld, world);
    });
    if (locals.some((local) => local === undefined)) continue;
    const poses = locals.filter((local): local is Transform2D => local !== undefined);

    const translate = valueFrames(
      frames,
      frameCount,
      poses,
      (pose) => ({
        x: pose.position.x - bone.rest.position.x,
        y: pose.position.y - bone.rest.position.y,
      }),
      { x: 0, y: 0 },
    );
    const rotate = valueFrames(
      frames,
      frameCount,
      poses,
      (pose) => ({ rotate: pose.rotation - bone.rest.rotation }),
      { rotate: 0 },
    );
    const scale = valueFrames(
      frames,
      frameCount,
      poses,
      (pose) => ({
        x: bone.rest.scale.x === 0 ? 1 : pose.scale.x / bone.rest.scale.x,
        y: bone.rest.scale.y === 0 ? 1 : pose.scale.y / bone.rest.scale.y,
      }),
      { x: 1, y: 1 },
    );

    const timeline: DbBoneTimeline = {
      name: bone.name,
      ...(translate === undefined ? {} : { translateFrame: translate }),
      ...(rotate === undefined ? {} : { rotateFrame: rotate }),
      ...(scale === undefined ? {} : { scaleFrame: scale }),
    };
    if (translate !== undefined || rotate !== undefined || scale !== undefined) {
      boneTimelines.push(timeline);
      emitted += (translate?.length ?? 0) + (rotate?.length ?? 0) + (scale?.length ?? 0);
    }

    // Opacity: DragonBones puts alpha on the slot, so a node's opacity is written to
    // every slot its bone owns rather than to the bone itself. Fully opaque and constant
    // is the default and writes nothing.
    const opaque = poses.every((pose) => pose.opacity === 1);
    if (!opaque) {
      for (const slot of slots.filter((candidate) => candidate.parent === bone.name)) {
        const colorFrames: DbColorFrame[] = frames.map((frame, index) => ({
          duration: frameDuration(frames, index, frameCount),
          tweenEasing: TWEEN_LINEAR,
          value: { aM: Math.round(at(poses, index).opacity * 100) },
        }));
        slotTimelines.push({ name: slot.name, colorFrame: colorFrames });
        emitted += colorFrames.length;
      }
    }
  }

  return {
    animation: {
      duration: frameCount,
      playTimes: PLAY_TIMES[clip?.loop ?? 'loop'],
      name,
      ...(boneTimelines.length > 0 ? { bone: boneTimelines } : {}),
      ...(slotTimelines.length > 0 ? { slot: slotTimelines } : {}),
      ...(ir.markers.length > 0 ? { frame: markerFrames(ir, frameCount) } : {}),
    },
    frames: emitted,
    samples: frames.length,
  };
}

/**
 * `undefined` when the channel never leaves its neutral value.
 *
 * `neutral` is passed in rather than inferred: a constant translate of `{x: 1}` is not
 * the identity even though 1 is the identity for *scale*, and a channel written as
 * "unchanged" when it is actually offset puts every part one pixel out.
 */
function valueFrames(
  frames: readonly number[],
  frameCount: number,
  poses: readonly Transform2D[],
  project: (pose: Transform2D) => Readonly<Record<string, number>>,
  neutral: Readonly<Record<string, number>>,
): readonly DbValueFrame[] | undefined {
  const values = poses.map(project);
  const atNeutral = values.every((value) =>
    Object.entries(value).every(([key, component]) => component === neutral[key]),
  );
  if (atNeutral) return undefined;

  return frames.map((frame, index) => ({
    duration: frameDuration(frames, index, frameCount),
    tweenEasing: TWEEN_LINEAR,
    ...at(values, index),
  }));
}

function frameDuration(frames: readonly number[], index: number, frameCount: number): number {
  const next = frames[index + 1];
  return next === undefined
    ? Math.max(0, frameCount - at(frames, index))
    : next - at(frames, index);
}

function markerFrames(ir: AnimationIR, frameCount: number): readonly DbEventFrame[] {
  const positions = [...ir.markers]
    .map((marker) => ({
      frame: Math.round((marker.timeMs * ir.fps) / 1000),
      label: marker.label,
    }))
    .sort((left, right) => left.frame - right.frame);

  const out: DbEventFrame[] = [];
  const first = at(positions, 0);
  if (first.frame > 0) out.push({ duration: first.frame, events: [] });

  positions.forEach((position, index) => {
    const next = positions[index + 1]?.frame ?? frameCount;
    out.push({
      duration: Math.max(0, next - position.frame),
      events: [{ name: position.label }],
    });
  });

  return out;
}

/**
 * The exact inverse of `composeTransform` in `@rv/anim-engine`.
 *
 * The evaluator only produces world transforms, and DragonBones only accepts locals, so
 * one of the two has to invert the other. Inverting the *published* composition is the
 * safe direction: it is by construction the same arithmetic run backwards, so it cannot
 * drift the way a second forward implementation would.
 */
export function decomposeLocal(parent: Transform2D | undefined, world: Transform2D): Transform2D {
  if (parent === undefined) return world;

  const delta = {
    x: world.position.x - parent.position.x,
    y: world.position.y - parent.position.y,
  };
  const unrotated = rotateVec(delta, -parent.rotation);

  return {
    position: {
      x: parent.scale.x === 0 ? 0 : unrotated.x / parent.scale.x,
      y: parent.scale.y === 0 ? 0 : unrotated.y / parent.scale.y,
    },
    rotation: world.rotation - parent.rotation,
    scale: {
      x: parent.scale.x === 0 ? world.scale.x : world.scale.x / parent.scale.x,
      y: parent.scale.y === 0 ? world.scale.y : world.scale.y / parent.scale.y,
    },
    skew: { x: world.skew.x - parent.skew.x, y: world.skew.y - parent.skew.y },
    anchor: world.anchor,
    opacity: parent.opacity === 0 ? world.opacity : world.opacity / parent.opacity,
  };
}
