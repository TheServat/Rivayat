/**
 * The bird from `rv animate`, in both of its riggings.
 *
 * This is not a synthetic example. `brokenBird()` is the exact node graph
 * `apps/cli/src/commands/animate.ts` built before RV-QA-GEO: a body ellipse with two wing
 * ellipses parented to it at +/-22 px, every node given `anchor: {x: 0.5, y: 1}` by a
 * shared `add()` helper. Bottom-centre is right for a tree, which rotates about its base,
 * and wrong for a wing, which must rotate about its shoulder - so each wing swings about a
 * point 22 px clear of the body and tears a triangular hole through it in every frame.
 *
 * It shipped. The render was bit-reproducible, `rv anim lint` was clean and every test was
 * green. Keeping the broken rig as a fixture is the only way to keep proving that the gate
 * which now catches it still catches it.
 *
 * **One deviation from the shipped rig, deliberately.** `animate.ts` mirrors the two wings
 * by giving the right one `amplitudeDeg: -46`, and `FlapBehaviour.amplitudeDeg` is
 * `min(0)`, so the scene it builds does not validate - which nobody noticed, because it is
 * cast to `AnimationIR` and never parsed. `flap` carries no phase or mirror field, and the
 * component transform model cannot conjugate a rotation through a negative scale, so a
 * negative amplitude is the only way to express a mirrored flap today. That is a gap in
 * `@rv/contracts` and it is reported as one; here both wings take `+46` so the fixture is
 * a document the schema accepts. The defect these fixtures exist to prove is in the
 * *pivot*, which is a property of the rest pose and is identical either way.
 */

import type { AnimationIR, NodeId } from '@rv/contracts';

import type { NodeExtent } from '../geometry/silhouette';

const NODE_IDS = {
  root: 'nod_01J8ZQ4E7K9M2N4P6R8T0VAA00',
  bird: 'nod_01J8ZQ4E7K9M2N4P6R8T0VAA01',
  wingL: 'nod_01J8ZQ4E7K9M2N4P6R8T0VAA02',
  wingR: 'nod_01J8ZQ4E7K9M2N4P6R8T0VAA03',
} as const;

export const BIRD_NODE_IDS: Readonly<Record<keyof typeof NODE_IDS, NodeId>> = NODE_IDS;

/** The paint table `animate.ts` draws these three nodes with. */
export const BIRD_EXTENTS: ReadonlyMap<NodeId, NodeExtent> = new Map<NodeId, NodeExtent>([
  [NODE_IDS.bird, { width: 46, height: 20, shape: 'ellipse' }],
  [NODE_IDS.wingL, { width: 54, height: 12, shape: 'ellipse' }],
  [NODE_IDS.wingR, { width: 54, height: 12, shape: 'ellipse' }],
]);

interface WingRig {
  readonly x: number;
  readonly y: number;
  readonly anchorX: number;
  readonly anchorY: number;
}

function transform(x: number, y: number, anchorX: number, anchorY: number): unknown {
  return {
    position: { x, y },
    rotation: 0,
    scale: { x: 1, y: 1 },
    skew: { x: 0, y: 0 },
    anchor: { x: anchorX, y: anchorY },
    opacity: 1,
  };
}

function birdIr(left: WingRig, right: WingRig): AnimationIR {
  return {
    irVersion: 1,
    id: 'anm_01J8ZQ4E7K9M2N4P6R8T0VAA99',
    name: 'bird',
    fps: 24,
    durationMs: 6000,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 4242,
    nodes: [
      {
        kind: 'group',
        id: NODE_IDS.root,
        name: 'root',
        parentId: null,
        transform: transform(0, 0, 0.5, 1),
        visible: true,
        depth: 0,
      },
      {
        kind: 'group',
        id: NODE_IDS.bird,
        name: 'bird',
        parentId: NODE_IDS.root,
        transform: transform(0, 0, 0.5, 1),
        visible: true,
        depth: 10,
      },
      {
        kind: 'group',
        id: NODE_IDS.wingL,
        name: 'wing-l',
        parentId: NODE_IDS.bird,
        transform: transform(left.x, left.y, left.anchorX, left.anchorY),
        visible: true,
        depth: 10,
      },
      {
        kind: 'group',
        id: NODE_IDS.wingR,
        name: 'wing-r',
        parentId: NODE_IDS.bird,
        transform: transform(right.x, right.y, right.anchorX, right.anchorY),
        visible: true,
        depth: 10,
      },
    ],
    tracks: [],
    markers: [],
    behaviours: [
      {
        id: 'bhv_01J8ZQ4E7K9M2N4P6R8T0VAA10',
        kind: 'orbit',
        nodeId: NODE_IDS.bird,
        enabled: true,
        seed: 77,
        weight: 1,
        centre: { x: 980, y: 420 },
        radius: { x: 620, y: 130 },
        periodMs: 6000,
        phase: 0,
      },
      {
        id: 'bhv_01J8ZQ4E7K9M2N4P6R8T0VAA11',
        kind: 'flap',
        nodeId: NODE_IDS.wingL,
        enabled: true,
        seed: 11,
        weight: 1,
        hz: 5.5,
        amplitudeDeg: 46,
        downstrokeBias: 0.35,
      },
      {
        id: 'bhv_01J8ZQ4E7K9M2N4P6R8T0VAA12',
        kind: 'flap',
        nodeId: NODE_IDS.wingR,
        enabled: true,
        seed: 12,
        weight: 1,
        hz: 5.5,
        amplitudeDeg: 46,
        downstrokeBias: 0.35,
      },
    ],
    camera: {
      keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
      focusNodeId: NODE_IDS.bird,
      shakeAmplitude: 0,
      shakeSeed: 0,
      projection: 'orthographic',
    },
  } as unknown as AnimationIR;
}

/** The rig that shipped: wings offset 22 px, pivoting at their own bottom-centre. */
export function brokenBird(): AnimationIR {
  return birdIr(
    { x: -22, y: 0, anchorX: 0.5, anchorY: 1 },
    { x: 22, y: 0, anchorX: 0.5, anchorY: 1 },
  );
}

/** The fix: each wing pivots at its shoulder - its inner end, at mid-height, on the body. */
export function shoulderPivotedBird(): AnimationIR {
  return birdIr(
    { x: -6, y: -12, anchorX: 1, anchorY: 0.5 },
    { x: 6, y: -12, anchorX: 0, anchorY: 0.5 },
  );
}
