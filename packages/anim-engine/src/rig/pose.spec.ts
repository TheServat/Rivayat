import { describe, expect, it } from 'vitest';
import type { Rig, Transform2D } from '@rv/contracts';

import { bipedRig, walkClipIr } from '../__fixtures__/rigs';
import { evaluate } from '../evaluate';
import { identityTransform } from '../transform';
import {
  anchorPoint,
  anchorPointByRole,
  anchorTransform,
  attachmentFrame,
  clipDeltasByRole,
  orderBonesParentFirst,
  poseRig,
  restPose,
} from './pose';

function worldOf(rig: Rig, pose: ReadonlyMap<string, Transform2D>, role: string): Transform2D {
  const bone = rig.bones.find((candidate) => candidate.role === role);
  if (bone === undefined) throw new Error(`no ${role} bone`);
  const world = pose.get(bone.id);
  if (world === undefined) throw new Error(`no pose for ${role}`);
  return world;
}

function delta(overrides: Partial<Transform2D> = {}): Transform2D {
  return { ...identityTransform(), ...overrides };
}

describe('ordering', () => {
  it('puts every parent before its children', () => {
    const rig = bipedRig();
    const seen = new Set<string>();
    for (const bone of orderBonesParentFirst(rig)) {
      if (bone.parentId !== null) expect(seen.has(bone.parentId), bone.role).toBe(true);
      seen.add(bone.id);
    }
    expect(seen.size).toBe(rig.bones.length);
  });
});

describe('restPose', () => {
  const rig = bipedRig();
  const pose = restPose(rig);

  it('composes each bone through its parents', () => {
    // torso 0 -> hips +60 -> leg +20 -> foot +70
    expect(worldOf(rig, pose, 'hips').position).toEqual({ x: 0, y: 60 });
    expect(worldOf(rig, pose, 'leg-left').position).toEqual({ x: -10, y: 80 });
    expect(worldOf(rig, pose, 'foot-left').position).toEqual({ x: -10, y: 150 });
  });

  it('scales with the rig, because that is what a taller character is', () => {
    const tall = bipedRig({ scale: 2 });
    const tallPose = restPose(tall);
    expect(worldOf(tall, tallPose, 'foot-left').position).toEqual({ x: -20, y: 300 });
  });
});

describe('poseRig', () => {
  const rig = bipedRig();

  it('leaves a bone with no delta at rest, so a partial clip still plays', () => {
    const posed = poseRig(rig, new Map([['torso', delta({ position: { x: 5, y: 5 } })]]));
    expect(worldOf(rig, posed, 'torso').position).toEqual({ x: 5, y: 5 });
    // hips moved only because torso did; its own local is untouched.
    expect(worldOf(rig, posed, 'hips').position).toEqual({ x: 5, y: 65 });
  });

  it('rotates a bone about its own origin, not about the canvas', () => {
    const posed = poseRig(rig, new Map([['leg-left', delta({ rotation: 90 })]]));
    const leg = worldOf(rig, posed, 'leg-left');
    const foot = worldOf(rig, posed, 'foot-left');

    // The leg's own origin is unmoved; the foot swung a quarter turn about it.
    expect(leg.position).toEqual({ x: -10, y: 80 });
    expect(foot.position.x).toBeCloseTo(-80, 9);
    expect(foot.position.y).toBeCloseTo(80, 9);
  });
});

describe('anchors - a named point, and nothing about bones at the call site', () => {
  const rig = bipedRig();
  const pose = restPose(rig);

  it('resolves a name to a world point', () => {
    const sole = anchorPoint(rig, pose, 'sole');
    expect(sole.ok).toBe(true);
    expect(sole.ok && sole.value).toEqual({ x: -10, y: 165 });
  });

  it('applies the offset in the bone’s own space, so it travels with the bone', () => {
    // The whole reason the offset is bone-local: rotate the arm and the grip follows it
    // without anything recomputing a canvas coordinate.
    const posed = poseRig(rig, new Map([['arm-left', delta({ rotation: 180 })]]));
    const grip = anchorPoint(rig, posed, 'grip-left');
    expect(grip.ok).toBe(true);
    // Arm origin (-20,-20); hand hangs 45 below it at rest, grip 10 further. Turned
    // upside down, both distances run the other way.
    expect(grip.ok && grip.value.y).toBeCloseTo(-75, 9);
  });

  it('fails loudly for an anchor the rig does not carry', () => {
    // An anchor that silently resolved to the origin puts the sword on the floor and
    // says nothing. The error names what was available so the caller can see the typo.
    const missing = anchorPoint(rig, pose, 'scabbard');
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error.kind).toBe('not-found');
    expect(!missing.ok && missing.error.context).toMatchObject({
      resource: 'rig anchor',
      id: 'scabbard',
    });
  });

  it('resolves by role, which is the form that means the same on every skeleton', () => {
    const ground = anchorPointByRole(rig, pose, 'ground');
    expect(ground.ok && ground.value).toEqual({ x: -10, y: 165 });

    // `grip-left` carries no explicit role and is picked up from its name.
    expect(anchorPointByRole(rig, pose, 'grip-left').ok).toBe(true);
  });

  it('fails for a role the rig does not declare, listing the roles it does', () => {
    const missing = anchorPointByRole(rig, pose, 'foot-right');
    expect(missing.ok).toBe(false);
    // `saddle` has no role at all and must not appear as `undefined` in the list.
    expect(!missing.ok && missing.error.context.available).toEqual(['head', 'ground', 'grip-left']);
  });
});

describe('clipDeltasByRole - the bridge from an evaluated clip to a skeleton', () => {
  const ir = walkClipIr();

  it('recovers a local delta per role, keyed by the node name', () => {
    const deltas = clipDeltasByRole(ir, evaluate(ir, 0));
    expect([...deltas.keys()]).toEqual(ir.nodes.map((node) => node.name));
  });

  it('gives an unanimated role the identity, not its parent’s motion', () => {
    // The failure this guards: reading world transforms straight out of the snapshot
    // would hand `hips` the torso's carry a second time, and the skeleton would stretch.
    const deltas = clipDeltasByRole(ir, evaluate(ir, 400));
    const hips = deltas.get('hips');
    expect(hips?.position).toEqual({ x: 0, y: 0 });
    expect(hips?.rotation).toBe(0);

    const torso = deltas.get('torso');
    expect(torso?.position.x).not.toBe(0);
  });

  it('carries a rotation through unchanged', () => {
    const deltas = clipDeltasByRole(ir, evaluate(ir, 125));
    const leg = deltas.get('leg-left');
    // sway at 2 Hz, 14 degrees, zero phase: a quarter period in is the peak.
    expect(leg?.rotation).toBeCloseTo(14, 9);
  });
});

describe('holding a sword without naming a bone', () => {
  // The end of the chain the whole anchor design exists for. A shot says "hold it at
  // `grip-left`", the IR records that as a `NodeAttachment`, and this resolves it against
  // whatever rig the instance turned out to have. Nothing anywhere names a bone id, so
  // refitting the rig, renaming a bone, or giving the prop to a character with longer arms
  // all leave it in the hand.
  const rig = bipedRig();

  function held(rotation: number): Transform2D {
    const posed = poseRig(rig, new Map([['arm-left', delta({ rotation })]]));
    const frame = attachmentFrame(rig, posed, { anchor: 'grip-left', inheritRotation: true });
    if (!frame.ok) throw new Error(frame.error.message);
    return frame.value;
  }

  it('turns the prop with the limb, not just moves it', () => {
    // A sword that tracks the fist and never rotates slides through it. `anchorPoint`
    // alone cannot say this, which is why the frame exists.
    expect(held(0).rotation).toBe(0);
    expect(held(35).rotation).toBeCloseTo(35, 9);
    expect(held(-90).rotation).toBeCloseTo(-90, 9);
  });

  it('moves the prop with the limb', () => {
    expect(held(180).position.y).toBeCloseTo(-75, 9);
    expect(held(0).position.y).toBeCloseTo(35, 9);
  });

  it('keeps a non-inheriting attachment upright while it tracks the point', () => {
    // What a speech balloon over a tumbling character needs: follow the mouth, stay
    // readable.
    const posed = poseRig(rig, new Map([['arm-left', delta({ rotation: 35 })]]));
    const balloon = attachmentFrame(rig, posed, { anchor: 'grip-left', inheritRotation: false });
    expect(balloon.ok && balloon.value.rotation).toBe(0);
    expect(balloon.ok && balloon.value.position).toEqual(held(35).position);
  });

  it('adds the anchor’s own angle, so a grip can lie across the palm', () => {
    const angled: Rig = {
      ...rig,
      anchors: rig.anchors.map((anchor) =>
        anchor.name === 'grip-left' ? { ...anchor, rotation: 20 } : anchor,
      ),
    };
    const frame = anchorTransform(angled, restPose(angled), 'grip-left');
    expect(frame.ok && frame.value.rotation).toBeCloseTo(20, 9);
  });

  it('fails when the rig has no such anchor, rather than drawing at the origin', () => {
    const frame = attachmentFrame(rig, restPose(rig), {
      anchor: 'scabbard',
      inheritRotation: true,
    });
    expect(frame.ok).toBe(false);
    expect(!frame.ok && frame.error.kind).toBe('not-found');
  });
});
