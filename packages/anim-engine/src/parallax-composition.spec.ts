/**
 * Parallax, measured where a viewer sees it: on screen.
 *
 * The `parallax` behaviour's delta is meaningless on its own. It is defined *against*
 * the camera transform, and the camera transform - `cameraMatrix` in
 * `@rv/render-engine` - already subtracts the camera position. So the number that
 * decides whether a scene has depth or has depth inverted is the composition:
 *
 *     screenX = worldX - cameraX
 *
 * and nothing that stops at `worldX` can see it. The behaviour shipped with its sign
 * negated, which made the composed displacement `-pan * (1 + factor)` instead of
 * `-pan * (1 - factor)`. On a 400 px pan the far plane swept 746 px against the camera
 * plane's 400: the sky raced past the foreground at 1.86x, which is not "slightly wrong
 * parallax", it is the effect running backwards. The two tests it had - `Math.abs` on
 * one delta, and `parallaxFactor` monotonicity - passed with the sign either way,
 * because neither of them composed.
 *
 * That is the point of this file, and of the shape of its assertions. They are about the
 * **relationship between layers**, not about any one number: nothing displaces more than
 * the camera plane, and displacement falls strictly as depth grows. Reverse the depths
 * and every one of them fails, which is the property a test of an ordering needs.
 *
 * The camera transform is reproduced here as a subtraction rather than imported.
 * `@rv/render-engine` depends on this package, so importing it back would be a cycle;
 * and the translation term is the whole of what matters - `fit` and `zoom` are uniform
 * scale factors applied to every layer alike and cannot change an ordering.
 */

import { describe, expect, it } from 'vitest';
import { DEPTH_FAR_PLANE, type AnimationIR, type NodeId } from '@rv/contracts';

import { evaluate } from './evaluate';

const PAN = 400;
const DEPTHS = [0, 25, 50, 75, DEPTH_FAR_PLANE] as const;

function nodeId(index: number): NodeId {
  const id: NodeId = `nod_01J8ZQ4E7K9M2N4P6R8T0V2W4${index.toString(36).toUpperCase()}`;
  return id;
}

function behaviourId(index: number): string {
  return `bhv_01J8ZQ4E7K9M2N4P6R8T0V2W4${index.toString(36).toUpperCase()}`;
}

/**
 * A backdrop of layers at increasing depth, all starting at the origin, and a camera
 * that pans `PAN` px to the right over one second.
 *
 * `depths` is a parameter so the reversal check can hand it the same scene with the
 * layer order flipped: a test of an ordering that still passes when the ordering is
 * inverted is not testing anything.
 */
function scene(depths: readonly number[], curve = 'exponential'): AnimationIR {
  return {
    irVersion: 1,
    id: 'anm_01J8ZQ4E7K9M2N4P6R8T0V2W4X',
    name: 'parallax',
    fps: 24,
    durationMs: 1000,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 1,
    nodes: depths.map((depth, index) => ({
      kind: 'group',
      id: nodeId(index),
      name: `layer-${String(index)}`,
      parentId: null,
      transform: {
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      visible: true,
      depth,
    })),
    tracks: [],
    behaviours: depths.map((_, index) => ({
      kind: 'parallax',
      id: behaviourId(index),
      nodeId: nodeId(index),
      enabled: true,
      seed: 0,
      weight: 1,
      strength: 1,
      curve,
    })),
    markers: [],
    camera: {
      keyframes: [
        { timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
        { timeMs: 1000, position: { x: PAN, y: 0 }, zoom: 1, rotation: 0 },
      ],
      shakeAmplitude: 0,
      shakeSeed: 0,
    },
  } as unknown as AnimationIR;
}

/**
 * How far each layer has travelled across the frame after the pan.
 *
 * The camera transform's translation term, and nothing else: `screen = world - camera`.
 */
function screenTravel(ir: AnimationIR): readonly number[] {
  const start = evaluate(ir, 0);
  const end = evaluate(ir, 1000);

  return ir.nodes.map((node, index) => {
    const from = start.nodes[index];
    const to = end.nodes[index];
    if (from === undefined || to === undefined) throw new Error(`no resolved node ${node.id}`);
    const before = from.worldTransform.position.x - start.camera.position.x;
    const after = to.worldTransform.position.x - end.camera.position.x;
    return Math.abs(after - before);
  });
}

describe('what a pan does to a stack of layers, on screen', () => {
  it('sweeps the camera plane by exactly the pan', () => {
    // Depth 0 *is* the camera plane: it has no parallax offset, so it slides across the
    // frame by the full pan. Anything else means the behaviour is moving a layer that
    // should be still.
    const travel = screenTravel(scene(DEPTHS));
    expect(travel[0]).toBeCloseTo(PAN, 9);
  });

  it('never moves any layer further than the camera plane', () => {
    // The assertion the shipped bug failed by 86 %: the far plane swept 746 px.
    for (const [index, distance] of screenTravel(scene(DEPTHS)).entries()) {
      expect(distance, `layer ${String(index)}`).toBeLessThanOrEqual(PAN + 1e-9);
    }
  });

  it('moves each layer strictly less than the one in front of it', () => {
    const travel = screenTravel(scene(DEPTHS));
    for (let index = 1; index < travel.length; index += 1) {
      const nearer = travel[index - 1];
      const further = travel[index];
      if (nearer === undefined || further === undefined) throw new Error('missing layer');
      expect(further, `layer ${String(index)} vs ${String(index - 1)}`).toBeLessThan(nearer);
    }
  });

  it('fails on the same scene with its depths reversed, which is what makes it a test', () => {
    // If the ordering assertion above passed here too it would be asserting nothing at
    // all. Reversing the depths inverts the expected order exactly.
    const travel = screenTravel(scene([...DEPTHS].reverse()));
    const ascending = travel.every(
      (distance, index) => index === 0 || distance <= (travel[index - 1] ?? 0),
    );
    expect(ascending).toBe(false);
  });

  it('holds on every curve, because the curve only reshapes the fall-off', () => {
    for (const curve of ['linear', 'exponential', 'logarithmic'] as const) {
      const travel = screenTravel(scene(DEPTHS, curve));
      expect(travel[0], curve).toBeCloseTo(PAN, 9);
      expect(travel[travel.length - 1], curve).toBeLessThan(PAN);
    }
  });

  it('pins the far plane when the fall-off reaches 1 there', () => {
    // `linear` reaches a factor of exactly 1 at `DEPTH_FAR_PLANE`, so that layer travels
    // with the camera and does not move across the frame at all - which is what a sky at
    // infinity does.
    const travel = screenTravel(scene(DEPTHS, 'linear'));
    expect(travel[travel.length - 1]).toBeCloseTo(0, 9);
  });

  it('moves every layer in the same direction as the pan', () => {
    // A layer that drifted the *other* way would be the sign error's more obvious
    // cousin, and no magnitude assertion above would catch it.
    const ir = scene(DEPTHS);
    const start = evaluate(ir, 0);
    const end = evaluate(ir, 1000);

    for (const [index] of DEPTHS.entries()) {
      const from = start.nodes[index];
      const to = end.nodes[index];
      if (from === undefined || to === undefined) throw new Error('missing layer');
      const before = from.worldTransform.position.x - start.camera.position.x;
      const after = to.worldTransform.position.x - end.camera.position.x;
      // The camera pans right, so every layer travels left across the frame - or, at the
      // far plane, not at all.
      expect(after - before, `layer ${String(index)}`).toBeLessThanOrEqual(0);
    }
  });

  it('sweeps a layer in front of the plane faster than the plane itself', () => {
    // Over-travel, measured where it is visible. `depth` is a signed distance, so a layer
    // at -DEPTH_FAR_PLANE under the linear fall-off has factor -1 and sweeps exactly twice
    // the pan. Under the old clamp every negative depth behaved as 0 and this was flat.
    const travel = screenTravel(scene([-DEPTH_FAR_PLANE, -50, 0, 50], 'linear'));
    expect(travel[0]).toBeCloseTo(PAN * 2, 9);
    expect(travel[1]).toBeCloseTo(PAN * 1.5, 9);
    expect(travel[2]).toBeCloseTo(PAN, 9);
    expect(travel[3]).toBeCloseTo(PAN * 0.5, 9);
  });

  it('still orders a stack that straddles the camera plane', () => {
    // The ordering property is what parallax *is*, and it must not stop at 0.
    const travel = screenTravel(scene([-80, -30, 0, 30, 80], 'exponential'));
    for (let index = 1; index < travel.length; index += 1) {
      const nearer = travel[index - 1];
      const further = travel[index];
      if (nearer === undefined || further === undefined) throw new Error('missing layer');
      expect(further, `layer ${String(index)}`).toBeLessThan(nearer);
    }
  });

  it('is proportional to the pan, so a slower move is the same scene more slowly', () => {
    const ir = scene(DEPTHS);
    const half = evaluate(ir, 500);
    const full = evaluate(ir, 1000);

    for (const [index] of DEPTHS.entries()) {
      const atHalf = half.nodes[index];
      const atFull = full.nodes[index];
      if (atHalf === undefined || atFull === undefined) throw new Error('missing layer');
      const halfTravel = Math.abs(atHalf.worldTransform.position.x - half.camera.position.x);
      const fullTravel = Math.abs(atFull.worldTransform.position.x - full.camera.position.x);
      expect(fullTravel, `layer ${String(index)}`).toBeCloseTo(halfTravel * 2, 6);
    }
  });
});
