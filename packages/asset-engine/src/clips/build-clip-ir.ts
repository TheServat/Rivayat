/**
 * One clip name plus one `MotionStyle` → one `AnimationIR` fragment.
 *
 * This is where "the style includes how things animate" stops being a slogan. Every
 * number in the output is read out of `StyleBible.motion`: the frame rate, the tempo
 * that sets the duration, the ambient wind and breath rates, the easing curve by name,
 * and the principles - anticipation, overshoot, follow-through, squash, exaggeration,
 * weight - that shape an impulse. A paper-cutout bible with `stepMode: 'on-3s'`, low
 * `arcBias` and high `holdBias` and a painterly one with smooth stepping and high
 * `secondaryMotion` do not produce the same `flap`; they produce different documents,
 * and `derive-clips.spec.ts` asserts the two IRs differ rather than trusting it.
 *
 * The fragment is **self-contained and instance-free**: its nodes are groups named
 * after the template's bone roles, not `asset-instance` nodes. That is what lets the
 * document be content-addressed and shared - `AnimationClip.irHash` exists so "two
 * assets that share a generated `idle` share it on disk", and a pinned asset version
 * inside the document would make every fragment unique.
 */

import { contentHash, hashSeed } from '@rv/shared-kernel';
import type {
  AnimNode,
  AnimationIR,
  AnimationId,
  AssetArchetype,
  Behaviour,
  BehaviourId,
  Keyframe,
  MotionSignature,
  MotionStyle,
  NodeId,
  Size,
  Track,
  TrackId,
} from '@rv/contracts';

import { contentId } from '../content-ids';
import { templateFor } from '../rig/templates/index';
import { type ClipKind, CLIP_KINDS, TARGET_PATTERNS } from './clip-kinds';

export interface BuildClipIrInput {
  readonly archetype: AssetArchetype;
  readonly clipName: string;
  readonly motion: MotionStyle;
  /** Root seed for the whole style. Every behaviour seed is derived from it. */
  readonly styleSeed: number;
  readonly sceneSpace: Size;
  /** Nominal on-screen height, so a stride is proportional to the subject. */
  readonly nominalHeight: number;
  /** Roles whose part is deformable. Wind and boil go here, not on rigid parts. */
  readonly deformableRoles?: readonly string[];
  /**
   * `StyleBible.visual.shape.exaggeration`, 0..1.
   *
   * The visual half of the bible reaching into the motion half, on purpose: a style
   * that draws exaggerated proportions and then animates them at naturalistic
   * amplitudes reads as a cartoon that has been slowed down. `MotionPrinciples` has no
   * exaggeration of its own precisely because it is a property of the shape language.
   */
  readonly exaggeration?: number;
  /** A character's own way of moving. Absent for anything that is not a character. */
  readonly signature?: MotionSignature;
}

export interface ClipIrDraft {
  readonly ir: AnimationIR;
  readonly kind: ClipKind;
}

const DEFAULT_EXAGGERATION = 0.4;

type Gait = 'walk' | 'run' | 'sneak' | 'limp' | 'march' | 'shuffle' | 'skip';

/**
 * `GaitStyle` from the character graph to the behaviour's own gait vocabulary.
 *
 * Two enums for one idea, and deliberately so: the narrative one is what a writer
 * calls it ("prowl", "trudge"), the behaviour one is what the evaluator implements.
 * This is the single place the two are joined.
 */
const GAIT_MAP: Readonly<Record<MotionSignature['gaitStyle'], Gait>> = {
  glide: 'walk',
  stride: 'walk',
  trudge: 'shuffle',
  bounce: 'skip',
  prowl: 'sneak',
  shuffle: 'shuffle',
  march: 'march',
  limp: 'limp',
  drift: 'walk',
};

export function buildClipIr(input: BuildClipIrInput): ClipIrDraft {
  const kind = CLIP_KINDS[input.clipName] ?? CLIP_KINDS.idle;
  if (kind === undefined) throw new TypeError('CLIP_KINDS must define "idle"');

  const template = templateFor(input.archetype);
  const roles = template.bones.map((bone) => bone.role);
  const rootRole =
    template.bones.find((bone) => bone.parentRole === null)?.role ?? roles[0] ?? 'root';

  // The fingerprint is what makes two motion blocks produce two different documents
  // rather than two documents that merely hold different numbers: the ids move too, so
  // a diff shows a new clip rather than an edited one.
  const fingerprint = contentHash({
    archetype: input.archetype,
    clipName: input.clipName,
    motion: input.motion,
    signature: input.signature ?? null,
    nominalHeight: input.nominalHeight,
    exaggeration: input.exaggeration ?? DEFAULT_EXAGGERATION,
  });

  const nodeIdOf = (role: string): NodeId =>
    contentId<NodeId>('nod', `${fingerprint}:node:${role}`);
  const parentOf = new Map(template.bones.map((bone) => [bone.role, bone.parentRole]));

  const nodes: AnimNode[] = roles.map((role) => {
    const parentRole = parentOf.get(role) ?? null;
    return {
      kind: 'group',
      id: nodeIdOf(role),
      name: role,
      parentId: parentRole === null ? null : nodeIdOf(parentRole),
      transform: {
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      visible: true,
      depth: 0,
    };
  });

  const frameMs = 1000 / input.motion.fps;
  const durationMs = Math.max(
    Math.round(frameMs),
    Math.round(Math.round(kind.baseDurationMs / input.motion.tempo / frameMs) * frameMs),
  );

  const context: FamilyContext = {
    kind,
    durationMs,
    motion: input.motion,
    exaggeration: input.exaggeration ?? DEFAULT_EXAGGERATION,
    nominalHeight: input.nominalHeight,
    ...(input.signature === undefined ? {} : { signature: input.signature }),
    rootRole,
    targets: selectTargets(kind, roles, rootRole, input.deformableRoles ?? []),
    allRoles: roles,
    deformableRoles: (input.deformableRoles ?? []).filter((role) => roles.includes(role)),
    nodeIdOf,
    behaviourIdOf: (label: string) =>
      contentId<BehaviourId>('bhv', `${fingerprint}:behaviour:${label}`),
    trackIdOf: (label: string) => contentId<TrackId>('trk', `${fingerprint}:track:${label}`),
    seedOf: (label: string) => hashSeed(`${String(input.styleSeed)}:${input.clipName}:${label}`),
  };

  const built = FAMILIES[kind.family](context);

  const ir: AnimationIR = {
    irVersion: 1,
    id: contentId<AnimationId>('anm', `${fingerprint}:ir`),
    name: `${input.archetype} ${input.clipName}`,
    fps: input.motion.fps,
    durationMs,
    sceneSpace: input.sceneSpace,
    seed: hashSeed(`${String(input.styleSeed)}:${input.clipName}`),
    nodes,
    tracks: [...built.tracks],
    behaviours: [...built.behaviours, ...boilFor(context)],
    markers: [],
  };

  return { ir, kind };
}

// ── target selection ────────────────────────────────────────────────────────

function selectTargets(
  kind: ClipKind,
  roles: readonly string[],
  rootRole: string,
  deformableRoles: readonly string[],
): readonly string[] {
  if (kind.targets === 'root') return [rootRole];
  if (kind.targets === 'all') return roles;
  if (kind.targets === 'deformable') {
    const deformable = roles.filter((role) => deformableRoles.includes(role));
    // A rigid archetype has no deformable part, and an ambient clip that drives nothing
    // is a four-second hold. Fall back to the root so "nothing is ever perfectly still"
    // survives contact with a crate.
    return deformable.length > 0 ? deformable : [rootRole];
  }

  const pattern = TARGET_PATTERNS[kind.targets];
  const matched = roles.filter((role) => pattern.test(role));
  return matched.length > 0 ? matched : [rootRole];
}

// ── family builders ─────────────────────────────────────────────────────────

interface FamilyContext {
  readonly kind: ClipKind;
  readonly durationMs: number;
  readonly motion: MotionStyle;
  /** From the style's shape language, not from `MotionPrinciples`. */
  readonly exaggeration: number;
  readonly nominalHeight: number;
  readonly signature?: MotionSignature;
  readonly rootRole: string;
  readonly targets: readonly string[];
  readonly allRoles: readonly string[];
  readonly deformableRoles: readonly string[];
  readonly nodeIdOf: (role: string) => NodeId;
  readonly behaviourIdOf: (label: string) => BehaviourId;
  readonly trackIdOf: (label: string) => TrackId;
  readonly seedOf: (label: string) => number;
}

interface Built {
  readonly behaviours: readonly Behaviour[];
  readonly tracks: readonly Track[];
}

const FAMILIES: Readonly<Record<ClipKind['family'], (context: FamilyContext) => Built>> = {
  ambient: buildAmbient,
  oscillate: buildOscillate,
  locomotion: buildLocomotion,
  impulse: buildImpulse,
  hinge: buildHinge,
  spin: buildSpin,
  emit: buildEmit,
};

function buildAmbient(context: FamilyContext): Built {
  const { ambient, principles } = context.motion;
  const behaviours: Behaviour[] = [];

  for (const role of context.targets) {
    behaviours.push({
      kind: 'wind',
      ...base(context, `wind:${role}`, role),
      hz: clamp(ambient.windHz * context.kind.intensity, 0, 8),
      amplitude: unit(
        ambient.windAmplitude * context.kind.intensity * (0.6 + principles.secondaryMotion * 0.8),
      ),
      gustiness: unit(ambient.windGustiness),
      direction: 0,
      tipBias: unit(0.4 + principles.arcBias * 0.5),
    });
  }

  behaviours.push({
    kind: 'breathe',
    ...base(context, 'breathe', context.rootRole),
    hz: clamp(ambient.breathHz, 0, 2),
    // Heavy styles breathe shallower and slower; that is what `weight` is for.
    amplitude: unit(ambient.idleAmplitude * (1 - principles.weight * 0.4) * context.kind.intensity),
  });

  const headRole = context.allRoles.find((role) => TARGET_PATTERNS.head.test(role));
  if (headRole !== undefined) {
    behaviours.push({
      kind: 'blink',
      ...base(context, 'blink', headRole),
      intervalMs: Math.round(ambient.blinkIntervalMs),
      varianceMs: Math.round(ambient.blinkVarianceMs),
      closeDurationMs: 110,
    });
  }

  return { behaviours, tracks: [] };
}

function buildOscillate(context: FamilyContext): Built {
  const { principles } = context.motion;
  const hz = (context.kind.cycles * 1000) / context.durationMs;
  const wings = context.kind.targets === 'wings';
  const behaviours: Behaviour[] = context.targets.map((role, index) =>
    wings
      ? {
          kind: 'flap',
          ...base(context, `flap:${role}`, role),
          hz: clamp(hz, 0.1, 20),
          amplitudeDeg: clamp(40 * context.kind.intensity * (0.6 + context.exaggeration), 0, 180),
          // A wing's downstroke is faster than its upstroke, and a heavy style
          // exaggerates the difference. Symmetry is what makes a flap read as a metronome.
          downstrokeBias: unit(0.25 + principles.weight * 0.3),
        }
      : {
          kind: 'sway',
          ...base(context, `sway:${role}`, role),
          hz: clamp(hz, 0, 8),
          amplitudeDeg: clamp(
            5 * context.kind.intensity * (0.5 + context.exaggeration * 1.5) * phaseScale(index),
            0,
            90,
          ),
          axis: 'rotation',
        },
  );

  return { behaviours, tracks: [] };
}

function buildLocomotion(context: FamilyContext): Built {
  const { principles } = context.motion;
  const signature = context.signature;
  const energy = signature?.energy ?? 0.5;
  const stepsPerSecond = (context.kind.cycles * 1000) / context.durationMs;

  const gait: Gait =
    context.kind.baseDurationMs <= 900 ? 'run' : GAIT_MAP[signature?.gaitStyle ?? 'stride'];

  const behaviours: Behaviour[] = [
    {
      kind: 'walk-cycle',
      ...base(context, 'walk-cycle', context.rootRole),
      stepsPerSecond: clamp(stepsPerSecond * (0.7 + energy * 0.6), 0.1, 8),
      strideLength: Math.max(
        1,
        context.nominalHeight * 0.12 * context.kind.intensity * (0.7 + energy * 0.6),
      ),
      bounce: unit(principles.squashStretch * (0.6 + energy * 0.8)),
      gait,
    },
  ];

  // Limbs counter-phase against the body. Amplitude follows the character's gesture
  // frequency, so a still-handed character does not windmill.
  const gesture = signature?.gestureFrequency ?? 0.5;
  context.targets.forEach((role, index) => {
    behaviours.push({
      kind: 'sway',
      ...base(context, `limb:${role}`, role),
      hz: clamp(stepsPerSecond, 0, 8),
      amplitudeDeg: clamp(
        14 *
          context.kind.intensity *
          (0.4 + gesture * 0.9) *
          (0.6 + context.exaggeration) *
          phaseScale(index),
        0,
        90,
      ),
      axis: 'rotation',
    });
  });

  return { behaviours, tracks: [] };
}

/**
 * A one-shot action, shaped entirely by the twelve principles.
 *
 * Five keyframes: rest, anticipation (a wind-up *away* from the move), the peak, an
 * overshoot past the settle, and rest again. Each of the middle three is scaled by its
 * own principle, so a style that sets `anticipation: 0` genuinely has no wind-up rather
 * than a small one.
 */
function buildImpulse(context: FamilyContext): Built {
  const { principles, defaultEasing } = context.motion;
  const peak = 18 * context.kind.intensity * (0.5 + context.exaggeration);
  const total = context.durationMs;

  const times = [
    0,
    Math.round(total * 0.18),
    Math.round(total * 0.45),
    Math.round(total * 0.72),
    total,
  ];
  const values = [
    0,
    -peak * principles.anticipation,
    peak,
    -peak * principles.overshoot * 0.5,
    peak * principles.followThrough * 0.08,
  ];

  const tracks: Track[] = context.targets.map((role, index) => ({
    id: context.trackIdOf(`impulse:${role}`),
    nodeId: context.nodeIdOf(role),
    channel: 'rotation',
    keyframes: strictlyIncreasing(
      times,
      values.map((value) => value * phaseScale(index)),
      defaultEasing,
    ),
    before: 'hold',
    after: 'hold',
    additive: false,
  }));

  if (principles.squashStretch > 0.01) {
    tracks.push({
      id: context.trackIdOf('impulse:squash'),
      nodeId: context.nodeIdOf(context.rootRole),
      channel: 'scale.y',
      keyframes: strictlyIncreasing(
        times,
        [
          0,
          principles.squashStretch * 0.12,
          -principles.squashStretch * 0.18,
          principles.squashStretch * 0.06,
          0,
        ],
        defaultEasing,
      ),
      before: 'hold',
      after: 'hold',
      additive: true,
    });
  }

  return { behaviours: [], tracks };
}

function buildHinge(context: FamilyContext): Built {
  const opening = context.kind.intensity >= 0;
  const swing = 90;
  const tracks: Track[] = context.targets.map((role) => ({
    id: context.trackIdOf(`hinge:${role}`),
    nodeId: context.nodeIdOf(role),
    channel: 'rotation',
    keyframes: strictlyIncreasing(
      [0, Math.round(context.durationMs * 0.85), context.durationMs],
      opening
        ? [0, -swing * 1.04, -swing * (1 - context.motion.principles.overshoot * 0.02)]
        : [-swing, swing * 0.03, 0],
      context.motion.defaultEasing,
    ),
    before: 'hold',
    after: 'hold',
    additive: false,
  }));
  return { behaviours: [], tracks };
}

function buildSpin(context: FamilyContext): Built {
  const tracks: Track[] = context.targets.map((role) => ({
    id: context.trackIdOf(`spin:${role}`),
    nodeId: context.nodeIdOf(role),
    channel: 'rotation',
    keyframes: strictlyIncreasing(
      [0, context.durationMs],
      [0, 360 * context.kind.intensity],
      // A wheel turns at a constant rate, so `linear` - but only if the style declares
      // one. A name that resolves to nothing is the dangling reference `MotionStyle`
      // refuses elsewhere, and there is no reason to introduce one here.
      easingName(context.motion, 'linear'),
    ),
    before: 'loop',
    after: 'loop',
    additive: false,
  }));
  return { behaviours: [], tracks };
}

function buildEmit(context: FamilyContext): Built {
  const ramp = context.kind.ramp ?? [0, 1];
  const step = context.durationMs / Math.max(1, ramp.length - 1);
  const times = ramp.map((_, index) => Math.round(index * step));
  // Channel deltas are multiplicative on opacity and scale, so a ramp value of 1 means
  // "as authored" and the delta is `value - 1`.
  const deltas = ramp.map((value) => value - 1);

  const tracks: Track[] = [];
  for (const role of context.targets) {
    tracks.push({
      id: context.trackIdOf(`emit-opacity:${role}`),
      nodeId: context.nodeIdOf(role),
      channel: 'opacity',
      keyframes: strictlyIncreasing(times, deltas, context.motion.defaultEasing),
      before: 'hold',
      after: context.kind.loop === 'loop' ? 'loop' : 'hold',
      additive: false,
    });
    tracks.push({
      id: context.trackIdOf(`emit-scale:${role}`),
      nodeId: context.nodeIdOf(role),
      channel: 'scale.y',
      keyframes: strictlyIncreasing(
        times,
        deltas.map((delta) => delta * 0.35 * context.kind.intensity),
        context.motion.defaultEasing,
      ),
      before: 'hold',
      after: context.kind.loop === 'loop' ? 'loop' : 'hold',
      additive: false,
    });
  }

  return { behaviours: [], tracks };
}

/**
 * Hand-drawn line jitter, added to every clip when the style asks for it.
 *
 * Not a clip of its own: boil is a property of the *medium*, so an ink-comic series
 * boils while it walks, sways and flaps. This is the one place the style adds motion no
 * clip requested.
 */
function boilFor(context: FamilyContext): readonly Behaviour[] {
  const boil = context.motion.boil;
  if (!boil.enabled) return [];
  return context.allRoles.map((role) => ({
    kind: 'boil',
    ...base(context, `boil:${role}`, role),
    amplitude: unit(boil.amplitude),
    hz: clamp(boil.hz, 0, 24),
  }));
}

// ── helpers ─────────────────────────────────────────────────────────────────

function base(
  context: FamilyContext,
  label: string,
  role: string,
): { id: BehaviourId; nodeId: NodeId; enabled: boolean; seed: number; weight: number } {
  return {
    id: context.behaviourIdOf(label),
    nodeId: context.nodeIdOf(role),
    enabled: true,
    seed: context.seedOf(label),
    weight: 1,
  };
}

/**
 * Keyframes with strictly increasing times, which `Track` refines and this must honour.
 *
 * Rounding to whole milliseconds can collide two keyframes on a very short clip - a
 * 400 ms slam at 24 fps quantises to five frames - and the refinement rejects the
 * track rather than merging them. Nudging forward keeps the shape and keeps it legal.
 */
function strictlyIncreasing(
  times: readonly number[],
  values: readonly number[],
  easing: string,
): Keyframe[] {
  const out: Keyframe[] = [];
  let previous = -1;
  times.forEach((time, index) => {
    const at = Math.max(Math.round(time), previous + 1);
    previous = at;
    out.push({
      timeMs: at,
      value: round4(values[index] ?? 0),
      easing: { kind: 'named', name: easing },
    });
  });
  return out;
}

/** `preferred` when the style declares it, otherwise the style's own default. */
function easingName(motion: MotionStyle, preferred: string): string {
  return motion.easings.some((curve) => curve.name === preferred)
    ? preferred
    : motion.defaultEasing;
}

/** Alternating sign, so paired limbs and stacked segments do not move in lockstep. */
function phaseScale(index: number): number {
  return index % 2 === 0 ? 1 : -1;
}

function clamp(value: number, min: number, max: number): number {
  return round4(Math.min(max, Math.max(min, value)));
}

function unit(value: number): number {
  return clamp(value, 0, 1);
}

/** Four decimals: enough for motion, few enough that the content hash is stable. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
