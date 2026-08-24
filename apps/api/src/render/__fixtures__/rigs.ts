/**
 * A skeleton, the same skeleton twice as big, and a walk cycle authored on the first.
 *
 * Deliberately the same shape as `@rv/anim-engine`'s own retargeting fixtures, and
 * deliberately a copy: that package exports one entry point and its fixtures are not
 * part of it. The property the copy has to preserve is the one the tests rest on -
 * `biped(2)` is `biped(1)` with every distance doubled and every angle identical, so a
 * retargeted length must come out as exactly twice the authored one.
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
import { deriveId, rigSignature } from '@rv/anim-engine';

interface BoneSpec {
  readonly role: string;
  readonly parentRole: string | null;
  readonly x: number;
  readonly y: number;
  readonly length: number;
}

const SKELETON: readonly BoneSpec[] = [
  { role: 'torso', parentRole: null, x: 0, y: 0, length: 60 },
  { role: 'hips', parentRole: 'torso', x: 0, y: 60, length: 20 },
  { role: 'leg-left', parentRole: 'hips', x: -10, y: 20, length: 70 },
  { role: 'foot-left', parentRole: 'leg-left', x: 0, y: 70, length: 15 },
];

function boneId(tag: string, role: string): BoneId {
  return deriveId<BoneId>('bon', `${tag}:${role}`);
}

/** A four-bone biped. `scale` multiplies every distance and no angle. */
export function biped(scale = 1): Rig {
  const tag = `biped-${String(scale)}`;
  return Rig.parse({
    id: deriveId('rig', tag),
    archetype: 'biped',
    templateId: 'biped-standard',
    bones: SKELETON.map((spec) => ({
      id: boneId(tag, spec.role),
      name: spec.role,
      role: spec.role,
      parentId: spec.parentRole === null ? null : boneId(tag, spec.parentRole),
      rest: {
        position: { x: spec.x * scale, y: spec.y * scale },
        rotation: 0,
        length: spec.length * scale,
        scale: { x: 1, y: 1 },
      },
      partIds: [],
      zOrderBias: 0,
    })),
    meshes: [],
    ikChains: [],
    anchors: [
      {
        name: 'sole',
        role: 'ground',
        boneId: boneId(tag, 'foot-left'),
        offset: { x: 0, y: 15 * scale },
      },
    ],
  });
}

function nodeId(role: string): NodeId {
  return deriveId<NodeId>('nod', `walk:${role}`);
}

/** The walk cycle as an IR fragment: nodes named after the roles they drive. */
export function walkFragment(scale = 1): AnimationIR {
  return AnimationIR.parse({
    irVersion: 1,
    id: deriveId('anm', 'walk'),
    name: 'walk',
    fps: 24,
    durationMs: 1000,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 5,
    nodes: SKELETON.map((spec) => ({
      kind: 'group',
      id: nodeId(spec.role),
      name: spec.role,
      parentId: spec.parentRole === null ? null : nodeId(spec.parentRole),
      depth: 0,
    })),
    tracks: [
      {
        id: deriveId<TrackId>('trk', 'walk:carry-x'),
        nodeId: nodeId('torso'),
        channel: 'position.x',
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 1000, value: 44 * scale },
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
        enabled: true,
        seed: 11,
        weight: 1,
        stepsPerSecond: 2,
        strideLength: 26 * scale,
        bounce: 0.3,
        gait: 'walk',
      },
    ],
    markers: [],
  });
}

/** The walk cycle as a library entry, filed under the skeleton it was authored on. */
export function walkEntry(overrides: Record<string, unknown> = {}): ClipLibraryEntry {
  const source = rigSignature(biped(1));
  if (!source.ok) throw source.error;

  return ClipLibraryEntry.parse({
    id: deriveId('clp', 'walk'),
    name: 'walk-cycle',
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
    drives: ['torso'],
    alignsTo: ['ground'],
    ...overrides,
  });
}
