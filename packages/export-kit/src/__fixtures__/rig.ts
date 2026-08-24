/**
 * A two-bone rig and its parts, for the skeletal and atlas exports.
 *
 * The bone *roles* deliberately match the node names in {@link hierarchyIr}, because that
 * is the join the DragonBones exporter uses - the same role-based join `bakeSheet` uses,
 * so one clip fragment animates every asset of its archetype.
 */

import type { AnimationClip, Part, Rig } from '@rv/contracts';
import {
  AnimationClip as AnimationClipSchema,
  Part as PartSchema,
  Rig as RigSchema,
} from '@rv/contracts';

import { testIds } from './ids';
import { withMargin, type Rgba } from './images';
import type { PartImage } from '../port';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

export interface RigFixture {
  readonly rig: Rig;
  readonly parts: readonly Part[];
  readonly clips: readonly AnimationClip[];
}

export function rigFixture(): RigFixture {
  const ids = testIds();
  const rootBone = ids.bone();
  const branchBone = ids.bone();
  const trunkPart = ids.part();
  const leafPart = ids.part();

  const parts = [
    PartSchema.parse({
      id: trunkPart,
      name: 'trunk',
      role: 'rig-root',
      imageHash: HASH_A,
      bounds: { x: 40, y: 120, width: 60, height: 200 },
      size: { width: 60, height: 200 },
      zOrder: 0,
      alphaCoverage: 0.6,
    }),
    PartSchema.parse({
      id: leafPart,
      name: 'branch',
      role: 'branch',
      imageHash: HASH_B,
      bounds: { x: 10, y: 20, width: 120, height: 90 },
      size: { width: 120, height: 90 },
      pivot: { x: 0.1, y: 0.9 },
      zOrder: 1,
      alphaCoverage: 0.4,
    }),
  ];

  const rig = RigSchema.parse({
    id: ids.rig(),
    archetype: 'tree',
    templateId: 'tree-basic',
    bones: [
      {
        id: rootBone,
        name: 'rig-root',
        role: 'rig-root',
        parentId: null,
        rest: { position: { x: 70, y: 320 }, rotation: 0, length: 200 },
        partIds: [trunkPart],
      },
      {
        id: branchBone,
        name: 'branch',
        role: 'branch',
        parentId: rootBone,
        rest: { position: { x: 0, y: -180 }, rotation: -20, length: 90 },
        partIds: [leafPart],
      },
    ],
  });

  const clips = [
    AnimationClipSchema.parse({
      id: ids.clip(),
      name: 'sway',
      source: 'template',
      durationMs: 1500,
      fps: 24,
      loop: 'ping-pong',
      irHash: HASH_A,
      provenance: { source: 'derived', createdAt: '2026-08-23T00:00:00.000Z' },
    }),
  ];

  return { rig, parts, clips };
}

/**
 * The same rig, with the root bone resting exactly where {@link hierarchyIr} puts its
 * node.
 *
 * Exists so a test can see the case where an animated channel never leaves its neutral
 * value and is therefore omitted from the DragonBones timeline entirely - a real and
 * common situation (a bone that only rotates) that the misaligned fixture cannot show.
 */
export function alignedRigFixture(): RigFixture {
  const base = rigFixture();
  // `hierarchyIr`'s `rig-root` node is authored at scene `(400, 300)`, and scene space is
  // centre-origin. An armature is not, so the exporter writes that node at composition
  // `(400 + 1920/2, 300 + 1080/2)` - see `src/scene-space.ts`. "Aligned" has to mean
  // aligned *in the space the file is written in*, or the fixture is asserting that two
  // different coordinate systems happen to share a number.
  const bones = base.rig.bones.map((bone) =>
    bone.name === 'rig-root'
      ? { ...bone, rest: { ...bone.rest, position: { x: 400 + 1920 / 2, y: 300 + 1080 / 2 } } }
      : bone,
  );
  return { ...base, rig: RigSchema.parse({ ...base.rig, bones }) };
}

/** Parts paired with bitmaps that carry a deliberate transparent margin. */
export function partImages(parts: readonly Part[], colour?: Rgba): readonly PartImage[] {
  return parts.map((part, index) => ({
    part,
    image: withMargin(
      { width: part.size.width, height: part.size.height },
      {
        // A margin on the left and top, so a trim that forgets its offset is visibly wrong.
        x: 3 + index,
        y: 2 + index,
        width: Math.max(1, part.size.width - 8 - index),
        height: Math.max(1, part.size.height - 6 - index),
      },
      colour,
    ),
  }));
}
