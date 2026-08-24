/**
 * Two skeletons of the same shape and different sizes, and a clip that walks on them.
 *
 * The whole point of the retargeting fixtures is that `bipedRig(2)` is `bipedRig(1)` with
 * every distance doubled and every angle identical - which is what a taller character is.
 * Anything that depends on the *ratio* of the two must then come out as exactly 2, and
 * anything that depends on an angle must come out unchanged. A fixture where the two
 * differed in some unprincipled way would make a failing assertion uninterpretable.
 *
 * Scales are powers of two so that every derived length is exact in IEEE-754 and a test
 * can assert equality rather than closeness.
 */

import {
  AnimationIR,
  ClipLibraryEntry,
  Rig,
  type BehaviourId,
  type BoneId,
  type NodeId,
  type TrackId,
} from '@rv/contracts';

import { rigSignature } from '../clips/signature';
import { deriveId } from '../motion/derive';

export interface BipedShape {
  /** Uniform multiplier on every distance. Angles are untouched. */
  readonly scale?: number;
  /** Extra multiplier on the leg bones only, for a rig that is *not* a uniform scaling. */
  readonly legScale?: number;
  readonly tag?: string;
}

interface BoneSpec {
  readonly role: string;
  readonly parentRole: string | null;
  readonly x: number;
  readonly y: number;
  readonly length: number;
  /** Legs take `legScale` on top of `scale`. */
  readonly leg?: boolean;
}

const SKELETON: readonly BoneSpec[] = [
  { role: 'torso', parentRole: null, x: 0, y: 0, length: 60 },
  { role: 'head', parentRole: 'torso', x: 0, y: -30, length: 25 },
  { role: 'arm-left', parentRole: 'torso', x: -20, y: -20, length: 45 },
  { role: 'hand-left', parentRole: 'arm-left', x: 0, y: 45, length: 10 },
  { role: 'hips', parentRole: 'torso', x: 0, y: 60, length: 20 },
  { role: 'leg-left', parentRole: 'hips', x: -10, y: 20, length: 70, leg: true },
  { role: 'foot-left', parentRole: 'leg-left', x: 0, y: 70, length: 15, leg: true },
  { role: 'leg-right', parentRole: 'hips', x: 10, y: 20, length: 70, leg: true },
  { role: 'foot-right', parentRole: 'leg-right', x: 0, y: 70, length: 15, leg: true },
];

function boneId(tag: string, role: string): BoneId {
  return deriveId<BoneId>('bon', `${tag}:${role}`);
}

/** A nine-bone biped: torso, head, one arm, hips and two legs. */
export function bipedRig(shape: BipedShape = {}): Rig {
  const scale = shape.scale ?? 1;
  const legScale = shape.legScale ?? 1;
  const tag = shape.tag ?? `biped-${String(scale)}-${String(legScale)}`;

  const bones = SKELETON.map((spec) => {
    const factor = spec.leg === true ? scale * legScale : scale;
    return {
      id: boneId(tag, spec.role),
      name: spec.role,
      role: spec.role,
      parentId: spec.parentRole === null ? null : boneId(tag, spec.parentRole),
      rest: {
        position: { x: spec.x * factor, y: spec.y * factor },
        rotation: 0,
        length: spec.length * factor,
        scale: { x: 1, y: 1 },
      },
      partIds: [],
      zOrderBias: 0,
    };
  });

  return Rig.parse({
    id: deriveId('rig', tag),
    archetype: 'biped',
    templateId: 'biped-standard',
    bones,
    meshes: [],
    ikChains: [],
    anchors: [
      {
        name: 'crown',
        role: 'head',
        boneId: boneId(tag, 'head'),
        offset: { x: 0, y: -25 * scale },
      },
      {
        name: 'sole',
        role: 'ground',
        boneId: boneId(tag, 'foot-left'),
        offset: { x: 0, y: 15 * scale * legScale },
      },
      { name: 'grip-left', boneId: boneId(tag, 'hand-left'), offset: { x: 0, y: 10 * scale } },
      { name: 'saddle', boneId: boneId(tag, 'hips') },
    ],
  });
}

// ── the clip ────────────────────────────────────────────────────────────────

export interface WalkClipShape {
  /**
   * Whether the `walk-cycle` behaviour is enabled.
   *
   * Off exists to exercise one specific rule - a **disabled** behaviour is excluded from
   * the clip's requirements and still rescaled by retargeting - and not to hide anything.
   * The proportional-motion tests run with it on, because since the bounce became a
   * fraction of the stride there is nothing in a walk cycle that retargeting cannot
   * reach.
   */
  readonly carry?: boolean;
  /** Multiplier on every length-valued value in the clip, matching the rig it fits. */
  readonly scale?: number;
}

function nodeId(role: string): NodeId {
  return deriveId<NodeId>('nod', `walk:${role}`);
}

/**
 * A walk cycle authored against `bipedRig({ scale })`.
 *
 * Body carry as keyframed `position` tracks, leg motion as `sway` (rotation, and
 * therefore proportion-free), plus a `walk-cycle` behaviour whose `strideLength` is the
 * one distance the behaviour set carries.
 */
export function walkClipIr(shape: WalkClipShape = {}): AnimationIR {
  const scale = shape.scale ?? 1;
  const carry = shape.carry ?? true;

  const nodes = SKELETON.map((spec) => ({
    kind: 'group' as const,
    id: nodeId(spec.role),
    name: spec.role,
    parentId: spec.parentRole === null ? null : nodeId(spec.parentRole),
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
  }));

  const rise = (value: number): number => value * scale;

  return AnimationIR.parse({
    irVersion: 1,
    id: deriveId('anm', 'walk'),
    name: 'walk',
    fps: 24,
    durationMs: 1000,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 5,
    nodes,
    tracks: [
      {
        id: deriveId<TrackId>('trk', 'walk:carry-x'),
        nodeId: nodeId('torso'),
        channel: 'position.x',
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 1000, value: rise(44) },
        ],
        before: 'hold',
        after: 'loop',
        additive: true,
      },
      {
        id: deriveId<TrackId>('trk', 'walk:carry-y'),
        nodeId: nodeId('torso'),
        channel: 'position.y',
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 250, value: rise(-9) },
          { timeMs: 500, value: 0 },
          { timeMs: 750, value: rise(-9) },
          { timeMs: 1000, value: 0 },
        ],
        before: 'hold',
        after: 'loop',
        additive: true,
      },
    ],
    behaviours: [
      {
        kind: 'walk-cycle',
        id: deriveId<BehaviourId>('bhv', 'walk:cycle'),
        nodeId: nodeId('torso'),
        enabled: carry,
        seed: 11,
        weight: 1,
        stepsPerSecond: 2,
        strideLength: rise(26),
        bounce: 0.3,
        gait: 'walk',
      },
      {
        kind: 'sway',
        id: deriveId<BehaviourId>('bhv', 'walk:leg-left'),
        nodeId: nodeId('leg-left'),
        enabled: true,
        seed: 0,
        weight: 1,
        hz: 2,
        amplitudeDeg: 14,
        axis: 'rotation',
      },
      {
        kind: 'sway',
        id: deriveId<BehaviourId>('bhv', 'walk:leg-right'),
        nodeId: nodeId('leg-right'),
        enabled: true,
        seed: 3142,
        weight: 1,
        hz: 2,
        amplitudeDeg: 14,
        axis: 'rotation',
      },
    ],
    markers: [],
  });
}

// ── the library ─────────────────────────────────────────────────────────────

/**
 * The walk clip as a library entry, filed under the skeleton it was authored on.
 *
 * `drives` and `alignsTo` are spelled out rather than derived so a test can perturb one
 * of them and watch compatibility react - which is the whole point of the index being a
 * stored field.
 */
export function walkLibraryEntry(overrides: Record<string, unknown> = {}): ClipLibraryEntry {
  const source = rigSignature(bipedRig());
  if (!source.ok) throw new Error(source.error.message);

  return ClipLibraryEntry.parse({
    id: deriveId('clp', 'walk'),
    name: 'walk',
    source: 'template',
    durationMs: 1000,
    fps: 24,
    irHash: 'c'.repeat(64),
    tags: [],
    provenance: {
      source: 'derived',
      parents: [],
      createdAt: '2026-08-24T00:00:00.000Z',
      costNanoUsd: 0,
    },
    sourceRig: source.value,
    drives: ['torso', 'leg-left', 'leg-right'],
    alignsTo: ['ground'],
    ...overrides,
  });
}
