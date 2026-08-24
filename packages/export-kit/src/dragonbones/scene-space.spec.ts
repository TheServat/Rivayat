/**
 * The armature is placed the way the renderer places the scene.
 *
 * Three exporters project one IR, and none of them gets to hold its own opinion about
 * where the origin is - the renderer is the reference implementation, because it is what
 * produces the video. Scene space is centre-origin (`@rv/render-engine`,
 * `frames/draw-list.ts`); a DragonBones armature, like a Lottie composition, is not. So a
 * node's world transform is moved into composition space before any delta is taken.
 *
 * The consequence is deliberately *visible*: a root-mapped bone carries the half-canvas
 * offset in its `translateFrame` values, where an integrator can see it and reposition the
 * armature - a transform they expect to apply. The alternative was to leave the raw scene
 * origin in the file, where the offset is written down nowhere and can only be found by
 * debugging why an armature sits half a canvas from where the video puts it.
 *
 * Every expectation here is computed from `evaluate` - the same evaluator the renderer
 * calls - plus the conversion written out longhand. Nothing is read back from the
 * exporter, so gutting the conversion cannot make any of it pass.
 */

import { describe, expect, it } from 'vitest';
import { unwrap } from '@rv/shared-kernel';
import type { Transform2D, Vec2 } from '@rv/contracts';
import { evaluate } from '@rv/anim-engine';

import { DragonBonesExporter } from './dragonbones-exporter';
import { hierarchyIr, testMotion } from '../__fixtures__/ir';
import { rigFixture } from '../__fixtures__/rig';
import { readJson } from '../__fixtures__/read';

const motion = testMotion();

/** `hierarchyIr`'s canvas, and therefore the offset between the two spaces. */
const SCENE = { width: 1920, height: 1080 };
const CENTRE: Vec2 = { x: SCENE.width / 2, y: SCENE.height / 2 };

/** The rests `rigFixture` declares, restated so the arithmetic below is readable. */
const ROOT_REST: Vec2 = { x: 70, y: 320 };
const BRANCH_REST: Vec2 = { x: 0, y: -180 };

interface BoneTimeline {
  readonly name: string;
  readonly translateFrame?: readonly { x?: number; y?: number }[];
}

interface Skeleton {
  readonly armature: readonly {
    readonly animation: readonly { readonly bone?: readonly BoneTimeline[] }[];
  }[];
}

async function boneTimelines(): Promise<readonly BoneTimeline[]> {
  const { rig } = rigFixture();
  const output = unwrap(await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, motion }));
  const skeleton = readJson<Skeleton>(output, 'hierarchy_ske.json');
  return skeleton.armature[0]?.animation[0]?.bone ?? [];
}

/** The world transform the evaluator resolves for a named node, in raw scene space. */
function worldAt(name: string, frame: number): Transform2D {
  const ir = hierarchyIr();
  const node = ir.nodes.find((candidate) => candidate.name === name);
  const snapshot = evaluate(ir, (frame * 1000) / ir.fps, { motion });
  const resolved = snapshot.nodes.find((candidate) => candidate.nodeId === node?.id);
  if (resolved === undefined) throw new Error(`the evaluator did not resolve ${name}`);
  return resolved.worldTransform;
}

/**
 * `decomposeLocal`, written out rather than imported.
 *
 * The child assertions have to be independent of the exporter's own arithmetic, or they
 * only prove that it agrees with itself.
 */
function localPosition(parent: Transform2D, child: Transform2D): Vec2 {
  const delta = {
    x: child.position.x - parent.position.x,
    y: child.position.y - parent.position.y,
  };
  const radians = (-parent.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const unrotated = { x: delta.x * cos - delta.y * sin, y: delta.x * sin + delta.y * cos };
  return { x: unrotated.x / parent.scale.x, y: unrotated.y / parent.scale.y };
}

/** Sampled frames of `hierarchyIr` (1500 ms at 24 fps, stride 1) that the file carries. */
const FRAMES = [0, 12, 24, 36] as const;

describe('a root-mapped bone carries the composition offset', () => {
  it.each(FRAMES)(
    'at frame %i, translate is the composition position minus the rest',
    async (frame) => {
      const timelines = await boneTimelines();
      const root = timelines.find((bone) => bone.name === 'rig-root');
      expect(root?.translateFrame).toBeDefined();

      // A root bone has nothing to be relative to, so the whole conversion reaches the
      // file: composition position = scene centre + world position.
      const world = worldAt('rig-root', frame);
      const expected = {
        x: CENTRE.x + world.position.x - ROOT_REST.x,
        y: CENTRE.y + world.position.y - ROOT_REST.y,
      };

      const written = root?.translateFrame?.[frame];
      expect(written?.x ?? 0).toBeCloseTo(expected.x, 6);
      expect(written?.y ?? 0).toBeCloseTo(expected.y, 6);
    },
  );

  it('is offset from the raw scene reading by exactly half the canvas, on every frame', async () => {
    // Stated as the difference, so the regression is named rather than implied: the old
    // behaviour wrote `world.position - rest`, and this writes that plus the centre.
    const timelines = await boneTimelines();
    const root = timelines.find((bone) => bone.name === 'rig-root');

    for (const frame of FRAMES) {
      const raw = worldAt('rig-root', frame).position;
      const written = root?.translateFrame?.[frame];
      expect((written?.x ?? 0) - (raw.x - ROOT_REST.x)).toBeCloseTo(CENTRE.x, 6);
      expect((written?.y ?? 0) - (raw.y - ROOT_REST.y)).toBeCloseTo(CENTRE.y, 6);
    }
  });
});

describe('a child bone is unaffected, because a delta cannot see the origin', () => {
  it.each(FRAMES)(
    'at frame %i, translate is the parent-local position minus the rest',
    async (frame) => {
      const timelines = await boneTimelines();
      const branch = timelines.find((bone) => bone.name === 'branch');
      expect(branch?.translateFrame).toBeDefined();

      const local = localPosition(worldAt('rig-root', frame), worldAt('branch', frame));
      const expected = { x: local.x - BRANCH_REST.x, y: local.y - BRANCH_REST.y };

      const written = branch?.translateFrame?.[frame];
      expect(written?.x ?? 0).toBeCloseTo(expected.x, 6);
      expect(written?.y ?? 0).toBeCloseTo(expected.y, 6);
    },
  );

  it('computes the same local position from shifted and unshifted transforms', () => {
    // Why the child is unaffected, asserted rather than left implicit: both operands move
    // by the same constant, so the difference between them does not move at all. That is
    // what makes converting once, at the snapshot, safe for the whole bone tree.
    const shift = (transform: Transform2D): Transform2D => ({
      ...transform,
      position: { x: CENTRE.x + transform.position.x, y: CENTRE.y + transform.position.y },
    });

    for (const frame of FRAMES) {
      const parent = worldAt('rig-root', frame);
      const child = worldAt('branch', frame);
      const raw = localPosition(parent, child);
      const shifted = localPosition(shift(parent), shift(child));
      expect(shifted.x).toBeCloseTo(raw.x, 9);
      expect(shifted.y).toBeCloseTo(raw.y, 9);
    }
  });
});

describe('the convention is the one the other exporters use', () => {
  it('places a node at scene (0,0) half a canvas from the armature origin, as Lottie does', async () => {
    // The same sentence `../lottie/scene-space.spec.ts` asserts for Lottie. Two formats,
    // one answer, and the number is the scene centre in both.
    const { rig } = rigFixture();
    const ir = hierarchyIr();
    const centred = {
      ...ir,
      nodes: ir.nodes.map((node) =>
        node.name === 'rig-root'
          ? { ...node, transform: { ...node.transform, position: { x: 0, y: 0 } } }
          : node,
      ),
      tracks: [],
    };

    const output = unwrap(await new DragonBonesExporter().export({ ir: centred, rig, motion }));
    const skeleton = readJson<Skeleton>(output, 'hierarchy_ske.json');
    const root = skeleton.armature[0]?.animation[0]?.bone?.find((bone) => bone.name === 'rig-root');

    expect(root?.translateFrame?.[0]?.x ?? 0).toBeCloseTo(CENTRE.x - ROOT_REST.x, 6);
    expect(root?.translateFrame?.[0]?.y ?? 0).toBeCloseTo(CENTRE.y - ROOT_REST.y, 6);
  });
});
