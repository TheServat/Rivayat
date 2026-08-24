import { describe, expect, it } from 'vitest';
import { isErr, isOk, unwrap } from '@rv/shared-kernel';
import type { Transform2D } from '@rv/contracts';
import { composeTransform, transformsEqual } from '@rv/anim-engine';

import { DragonBonesExporter, decomposeLocal } from './dragonbones-exporter';
import { SharpPngEncoder } from '../__fixtures__/images';
import { hierarchyIr, richIr, testMotion } from '../__fixtures__/ir';
import { alignedRigFixture, partImages, rigFixture } from '../__fixtures__/rig';
import { readJson } from '../__fixtures__/read';

interface DbSkeleton {
  frameRate: number;
  name: string;
  version: string;
  compatibleVersion: string;
  armature: {
    type: string;
    frameRate: number;
    name: string;
    aabb: { x: number; y: number; width: number; height: number };
    bone: { name: string; parent?: string; length?: number; transform?: Record<string, number> }[];
    slot: { name: string; parent: string; displayIndex: number }[];
    skin: { name: string; slot: { name: string; display: { type: string; name: string }[] }[] }[];
    animation: {
      duration: number;
      playTimes: number;
      name: string;
      bone?: {
        name: string;
        translateFrame?: { duration: number; tweenEasing?: number; x?: number; y?: number }[];
        rotateFrame?: { duration: number; rotate?: number }[];
        scaleFrame?: { duration: number; x?: number; y?: number }[];
      }[];
      slot?: { name: string; colorFrame: { duration: number; value: { aM: number } }[] }[];
      frame?: { duration: number; events: { name: string }[] }[];
    }[];
    defaultActions: { gotoAndPlay: string }[];
  }[];
}

interface DbTextureAtlas {
  width: number;
  height: number;
  imagePath: string;
  SubTexture: {
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    frameX?: number;
    frameY?: number;
    frameWidth?: number;
    frameHeight?: number;
  }[];
}

const motion = testMotion();

describe('DragonBonesExporter', () => {
  it('declares what it needs and which version it writes', () => {
    const exporter = new DragonBonesExporter();
    expect(exporter.id).toBe('dragonbones');
    expect(exporter.requires).toEqual(['rig']);
    expect(exporter.formatSpec).toContain('DragonBones 5.5');
  });

  it('refuses to write an armature with no skeleton', async () => {
    const result = await new DragonBonesExporter().export({ ir: hierarchyIr() });
    expect(isErr(result)).toBe(true);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('validation');
  });

  it('writes bones with their parents and rest poses', async () => {
    const { rig } = rigFixture();
    const output = unwrap(
      await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, motion }),
    );
    const skeleton = readJson<DbSkeleton>(output, 'hierarchy_ske.json');

    expect(skeleton.version).toBe('5.5');
    expect(skeleton.compatibleVersion).toBe('5.5');
    expect(skeleton.frameRate).toBe(24);

    const armature = skeleton.armature[0];
    expect(armature?.type).toBe('Armature');
    expect(armature?.bone.map((bone) => bone.name)).toEqual(['rig-root', 'branch']);
    expect(armature?.bone[0]?.parent).toBeUndefined();
    expect(armature?.bone[1]?.parent).toBe('rig-root');
    // A plain rotation is encoded as equal skew components.
    expect(armature?.bone[0]?.transform).toMatchObject({ x: 70, y: 320, skX: 0, skY: 0 });
    expect(armature?.bone[1]?.transform).toMatchObject({ x: 0, y: -180, skX: -20, skY: -20 });
    expect(armature?.defaultActions).toEqual([{ gotoAndPlay: 'hierarchy' }]);
  });

  it('writes one slot and one skin display per part', async () => {
    const { rig, parts } = rigFixture();
    const output = unwrap(
      await new DragonBonesExporter().export({
        ir: hierarchyIr(),
        rig,
        parts: partImages(parts),
        motion,
      }),
    );
    const armature = readJson<DbSkeleton>(output, 'hierarchy_ske.json').armature[0];

    expect(armature?.slot).toEqual([
      { name: 'trunk', parent: 'rig-root', displayIndex: 0 },
      { name: 'branch', parent: 'branch', displayIndex: 0 },
    ]);
    expect(armature?.skin[0]?.slot.map((slot) => slot.name)).toEqual(['trunk', 'branch']);
    expect(armature?.skin[0]?.slot[0]?.display[0]).toMatchObject({ type: 'image', name: 'trunk' });
  });

  it('names one animation per supplied clip, and loops it as the clip asks', async () => {
    const { rig, clips } = rigFixture();
    const output = unwrap(
      await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, clips, motion }),
    );
    const animation = readJson<DbSkeleton>(output, 'hierarchy_ske.json').armature[0]?.animation[0];

    expect(animation?.name).toBe('sway');
    // 1500 ms at 24 fps.
    expect(animation?.duration).toBe(36);
    expect(animation?.playTimes).toBe(0);
  });

  it('falls back to one animation named after the IR when no clips are given', async () => {
    const { rig } = rigFixture();
    const output = unwrap(
      await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, motion }),
    );
    const animation = readJson<DbSkeleton>(output, 'hierarchy_ske.json').armature[0]?.animation[0];
    expect(animation?.name).toBe('hierarchy');
  });

  it('writes bone frames as deltas from the rest pose, on the frame grid', async () => {
    const { rig } = rigFixture();
    const output = unwrap(
      await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, motion }),
    );
    const animation = readJson<DbSkeleton>(output, 'hierarchy_ske.json').armature[0]?.animation[0];
    const root = animation?.bone?.find((bone) => bone.name === 'rig-root');

    expect(root?.rotateFrame).toBeDefined();
    // The IR node `rig-root` sits at rotation 12 and the track adds 0..45; the bone rests
    // at 0, so the first frame is the offset, not the absolute angle.
    expect(root?.rotateFrame?.[0]?.rotate).toBeCloseTo(12, 6);
    expect(root?.rotateFrame?.at(-1)?.rotate).toBeCloseTo(57, 6);
    expect(root?.rotateFrame?.[0]?.duration).toBe(1);
  });

  it('leaves a channel out entirely when it never leaves its neutral value', async () => {
    const { rig } = alignedRigFixture();
    const output = unwrap(
      await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, motion }),
    );
    const animation = readJson<DbSkeleton>(output, 'hierarchy_ske.json').armature[0]?.animation[0];
    const root = animation?.bone?.find((bone) => bone.name === 'rig-root');

    // This rig's rest pose is the node's position *in composition space*, so the delta is
    // always zero and nothing is written; rotation and scale still move and still are.
    expect(root?.translateFrame).toBeUndefined();
    expect(root?.rotateFrame).toBeDefined();
    expect(root?.scaleFrame).toBeDefined();
  });

  it('writes no timeline for a bone the IR has no node for', async () => {
    const { rig } = rigFixture();
    const output = unwrap(await new DragonBonesExporter().export({ ir: richIr(), rig, motion }));
    const animation = readJson<DbSkeleton>(output, 'kitchen-sink_ske.json').armature[0]
      ?.animation[0];
    expect(animation?.bone).toBeUndefined();
  });

  it('writes opacity onto the slots the bone owns, because bones have no alpha', async () => {
    const { rig, parts } = rigFixture();
    const output = unwrap(
      await new DragonBonesExporter().export({
        ir: hierarchyIr(),
        rig,
        parts: partImages(parts),
        motion,
      }),
    );
    const animation = readJson<DbSkeleton>(output, 'hierarchy_ske.json').armature[0]?.animation[0];
    const slot = animation?.slot?.find((entry) => entry.name === 'branch');

    expect(slot).toBeDefined();
    expect(slot?.colorFrame[0]?.value.aM).toBe(90);
    // The IR dips the branch to 45 % opacity halfway through.
    expect(Math.min(...(slot?.colorFrame ?? []).map((frame) => frame.value.aM))).toBe(45);
  });

  it('writes markers as animation frame events', async () => {
    const { rig } = rigFixture();
    const output = unwrap(
      await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, motion }),
    );
    const animation = readJson<DbSkeleton>(output, 'hierarchy_ske.json').armature[0]?.animation[0];

    expect(animation?.frame).toEqual([
      { duration: 24, events: [{ name: 'in' }] },
      { duration: 12, events: [{ name: 'settle' }] },
    ]);
  });

  it('writes a texture page with DragonBones’ own trim encoding when parts are supplied', async () => {
    const { rig, parts } = rigFixture();
    const output = unwrap(
      await new DragonBonesExporter({ encoder: new SharpPngEncoder() }).export({
        ir: hierarchyIr(),
        rig,
        parts: partImages(parts),
        motion,
      }),
    );

    expect(output.artifacts.map((entry) => entry.path)).toEqual([
      'hierarchy_ske.json',
      'hierarchy_tex.png',
      'hierarchy_tex.json',
    ]);

    const atlas = readJson<DbTextureAtlas>(output, 'hierarchy_tex.json');
    expect(atlas.imagePath).toBe('hierarchy_tex.png');
    const trunk = atlas.SubTexture.find((entry) => entry.name === 'trunk');
    // The fixture leaves a 3px left and 2px top margin, which DragonBones records as a
    // negative frame origin against the untrimmed size.
    expect(trunk?.frameX).toBe(-3);
    expect(trunk?.frameY).toBe(-2);
    expect(trunk?.frameWidth).toBe(60);
    expect(trunk?.frameHeight).toBe(200);
  });

  it('says so when it had to write an armature with no texture', async () => {
    const { rig } = rigFixture();
    const output = unwrap(
      await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, motion }),
    );
    const warning = output.warnings.find(
      (candidate) => candidate.feature === 'node:part' && candidate.disposition === 'dropped',
    );
    expect(warning?.detail).toContain('texture atlas');
  });

  it('reports a ping-pong clip as approximated, since DragonBones only loops forwards', async () => {
    const { rig, clips } = rigFixture();
    const output = unwrap(
      await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, clips, motion }),
    );
    const warning = output.warnings.find(
      (candidate) => candidate.feature === 'track:extrapolation',
    );
    expect(warning?.disposition).toBe('approximated');
    expect(warning?.ids).toEqual([clips[0]?.id]);
  });

  it('reports the node kinds an armature cannot hold', async () => {
    const { rig } = rigFixture();
    const output = unwrap(await new DragonBonesExporter().export({ ir: richIr(), rig, motion }));
    const byFeature = new Map(
      output.warnings.map((warning) => [warning.feature, warning.disposition]),
    );

    expect(byFeature.get('node:fx-emitter')).toBe('dropped');
    expect(byFeature.get('camera:track')).toBe('dropped');
    expect(byFeature.get('node:tint')).toBe('dropped');
    expect(byFeature.get('track:anchor')).toBe('dropped');
    expect(byFeature.get('behaviour:blink')).toBe('approximated');
  });

  it('fails under strict when something would be lost', async () => {
    const { rig } = rigFixture();
    const result = await new DragonBonesExporter().export(
      { ir: richIr(), rig, motion },
      { strict: true },
    );
    expect(isErr(result)).toBe(true);
  });

  it('rejects a stride that is not a positive whole number of frames', async () => {
    const { rig } = rigFixture();
    const result = await new DragonBonesExporter().export(
      { ir: hierarchyIr(), rig, motion },
      { dragonBones: { stride: 0 } },
    );
    expect(isErr(result)).toBe(true);
  });

  it('samples fewer frames at a coarser stride', async () => {
    const { rig } = rigFixture();
    const fine = unwrap(await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, motion }));
    const coarse = unwrap(
      await new DragonBonesExporter().export(
        { ir: hierarchyIr(), rig, motion },
        { dragonBones: { stride: 6, name: 'coarse' } },
      ),
    );

    expect(coarse.stats.sampledFrames).toBeLessThan(fine.stats.sampledFrames);
    expect(coarse.stats.totalBytes).toBeLessThan(fine.stats.totalBytes);
  });

  it('works with no style supplied, falling back to the evaluator’s defaults', async () => {
    const { rig } = rigFixture();
    const output = unwrap(await new DragonBonesExporter().export({ ir: hierarchyIr(), rig }));
    expect(readJson<DbSkeleton>(output, 'hierarchy_ske.json').armature[0]?.animation).toHaveLength(
      1,
    );
  });

  it('writes no event track for an animation with no markers', async () => {
    const { rig } = rigFixture();
    const ir = { ...hierarchyIr(), markers: [] };
    const output = unwrap(await new DragonBonesExporter().export({ ir, rig, motion }));
    expect(
      readJson<DbSkeleton>(output, 'hierarchy_ske.json').armature[0]?.animation[0]?.frame,
    ).toBeUndefined();
  });

  it('surfaces a bad texture-page option as a typed failure', async () => {
    const { rig, parts } = rigFixture();
    const result = await new DragonBonesExporter({ encoder: new SharpPngEncoder() }).export(
      { ir: hierarchyIr(), rig, parts: partImages(parts), motion },
      { dragonBones: { atlas: { padding: -2 } } },
    );
    expect(isErr(result)).toBe(true);
  });

  it('warns when the parts overflow the single texture page DragonBones expects', async () => {
    const { rig, parts } = rigFixture();
    const big = parts.map((part) => ({ ...part, size: { width: 100, height: 100 } }));
    const output = unwrap(
      await new DragonBonesExporter({ encoder: new SharpPngEncoder() }).export(
        { ir: hierarchyIr(), rig, parts: partImages(big), motion },
        { dragonBones: { atlas: { maxSize: 128, padding: 0, trim: false } } },
      ),
    );

    expect(output.artifacts.map((entry) => entry.path)).toContain('hierarchy_tex-1.png');
    const warning = output.warnings.find(
      (candidate) => candidate.feature === 'node:part' && candidate.disposition === 'approximated',
    );
    expect(warning?.detail).toContain('single atlas');
  });

  it('uses the parts’ bounds as the armature box, and the scene otherwise', async () => {
    const { rig, parts } = rigFixture();
    const withParts = unwrap(
      await new DragonBonesExporter().export({
        ir: hierarchyIr(),
        rig,
        parts: partImages(parts),
        motion,
      }),
    );
    const without = unwrap(
      await new DragonBonesExporter().export({ ir: hierarchyIr(), rig, motion }),
    );

    expect(readJson<DbSkeleton>(withParts, 'hierarchy_ske.json').armature[0]?.aabb).toEqual({
      x: 10,
      y: 20,
      width: 120,
      height: 300,
    });
    expect(readJson<DbSkeleton>(without, 'hierarchy_ske.json').armature[0]?.aabb).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });
});

describe('decomposeLocal', () => {
  const parent: Transform2D = {
    position: { x: 30, y: -12 },
    rotation: 37,
    scale: { x: 1.4, y: 0.6 },
    skew: { x: 3, y: -2 },
    anchor: { x: 0.5, y: 0.5 },
    opacity: 0.8,
  };
  const local: Transform2D = {
    position: { x: -8, y: 22 },
    rotation: -14,
    scale: { x: 0.5, y: 2 },
    skew: { x: 1, y: 4 },
    anchor: { x: 0.25, y: 0.75 },
    opacity: 0.5,
  };

  it('is the exact inverse of the evaluator’s own composition', () => {
    const world = composeTransform(parent, local);
    expect(transformsEqual(decomposeLocal(parent, world), local, 1e-9)).toBe(true);
  });

  it('returns the world transform unchanged for a root node', () => {
    expect(decomposeLocal(undefined, local)).toBe(local);
  });

  it('degrades rather than dividing by zero when a parent collapses', () => {
    const flat: Transform2D = {
      ...parent,
      scale: { x: 0, y: 0 },
      opacity: 0,
    };
    const result = decomposeLocal(flat, local);
    expect(Number.isFinite(result.position.x)).toBe(true);
    expect(Number.isFinite(result.scale.x)).toBe(true);
    expect(result.opacity).toBe(local.opacity);
  });
});
