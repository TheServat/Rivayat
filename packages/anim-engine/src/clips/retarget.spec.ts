import { describe, expect, it } from 'vitest';
import { RigSignature, type AnimationIR, type Behaviour, type Rig } from '@rv/contracts';

import { bipedRig, walkClipIr } from '../__fixtures__/rigs';
import { evaluate } from '../evaluate';
import { anchorPointByRole, clipDeltasByRole, poseRig, restPose } from '../rig/pose';
import { rigSignature, statureOf } from './signature';
import { retargetClip, scaleBehaviour } from './retarget';

function signatureOf(rig: Rig): RigSignature {
  const result = rigSignature(rig);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function retarget(ir: AnimationIR, source: RigSignature, target: RigSignature): AnimationIR {
  const result = retargetClip(ir, source, target);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function strideOf(ir: AnimationIR): number {
  const cycle = ir.behaviours.find((behaviour) => behaviour.kind === 'walk-cycle');
  if (cycle?.kind !== 'walk-cycle') throw new Error('no walk cycle in the fixture');
  return cycle.strideLength;
}

/** Sampled once per frame across the clip, plus a little past its end. */
const SAMPLES = Array.from({ length: 40 }, (_, index) => index * 33);

// ── the acceptance criterion ────────────────────────────────────────────────

describe('retargeting onto identical proportions is the identity', () => {
  // ADR-0008 §5's acceptance criterion, and the reason the implementation multiplies by
  // an exact 1 rather than short-circuiting: `x * 1 === x` for every finite double, so
  // the property holds by arithmetic and would still hold if the fast path were deleted.
  const same = signatureOf(bipedRig());
  const ir = walkClipIr();
  const retargeted = retarget(ir, same, same);

  it('produces a byte-identical document', () => {
    expect(retargeted).toEqual(ir);
  });

  it('evaluates identically at every sampled time - exactly, not approximately', () => {
    for (const timeMs of SAMPLES) {
      expect(evaluate(retargeted, timeMs), `t=${String(timeMs)}`).toEqual(evaluate(ir, timeMs));
    }
  });

  it('holds for a second rig that merely happens to have the same proportions', () => {
    // Two different assets, two different sets of bone ids, one shape. This is the case
    // the library exists for, and "identical" must not secretly mean "the same object".
    const twin = signatureOf(bipedRig({ tag: 'understudy' }));
    expect(retarget(ir, same, twin)).toEqual(ir);
  });
});

// ── proportions that differ ─────────────────────────────────────────────────

describe('a short character and a tall one running the same walk', () => {
  const shortRig = bipedRig({ scale: 1 });
  const tallRig = bipedRig({ scale: 2 });
  const short = signatureOf(shortRig);
  const tall = signatureOf(tallRig);
  const authored = walkClipIr();

  it('gives each a stride that is the same fraction of its own stature', () => {
    // The anti-slide condition, and the property worth asserting rather than any
    // particular number. Limb angles are proportion-free, so a leg of length L swinging
    // through a fixed angle covers a distance proportional to L; if the body does not
    // advance proportionally too, the feet skate. Forget to scale and this fails.
    const onShort = retarget(authored, short, short);
    const onTall = retarget(authored, short, tall);

    expect(strideOf(onShort) / statureOf(short)).toBeCloseTo(
      strideOf(onTall) / statureOf(tall),
      12,
    );
    expect(strideOf(onTall)).toBe(strideOf(onShort) * 2);
  });

  it('keeps both sets of feet out of the floor at every sampled time', () => {
    // "Feet on the ground" has two halves. This is the half that holds for any clip: the
    // ground anchor never passes below the plane it rests on. (+y is down, so below the
    // floor is a *larger* y.)
    for (const [rig, signature] of [
      [shortRig, short],
      [tallRig, tall],
    ] as const) {
      const clip = retarget(authored, short, signature);
      const floor = groundY(rig, restPose(rig));

      for (const timeMs of SAMPLES) {
        const pose = poseRig(rig, clipDeltasByRole(clip, evaluate(clip, timeMs)));
        expect(
          groundY(rig, pose),
          `${String(statureOf(signature))} at t=${String(timeMs)}`,
        ).toBeLessThanOrEqual(floor + 1e-9);
      }
    }
  });

  it('lifts each set of feet by the same fraction of its own stature, frame for frame', () => {
    // The other half, and the one that actually tests the arithmetic: the clearance
    // above the floor, divided by stature, must be identical on both characters at every
    // instant. A tall character whose body rose by the same *pixels* as a short one
    // would be crouching - which is exactly what the `walk-cycle` behaviour used to do,
    // when its vertical rise was a literal eight pixels instead of a fraction of the
    // stride. A full walk cycle, behaviour and all, is now proportional end to end.
    const clip = walkClipIr();
    const onShort = retarget(clip, short, short);
    const onTall = retarget(clip, short, tall);

    for (const timeMs of SAMPLES) {
      const shortLift = clearance(shortRig, onShort, timeMs) / statureOf(short);
      const tallLift = clearance(tallRig, onTall, timeMs) / statureOf(tall);
      expect(tallLift, `t=${String(timeMs)}`).toBeCloseTo(shortLift, 12);
    }
  });

  it('scales a role by its own frame, not by one number for the whole skeleton', () => {
    // A rig that is not a uniform scaling: same torso, longer legs. The root's carry is
    // measured against stature and the legs against the hips, so the two factors differ -
    // which is the entire reason the scale is per role.
    const longLegged = signatureOf(bipedRig({ legScale: 2, tag: 'wader' }));
    const clip = retarget(authored, short, longLegged);

    expect(statureOf(longLegged)).toBeGreaterThan(statureOf(short));
    expect(strideOf(clip)).toBeCloseTo(
      strideOf(authored) * (statureOf(longLegged) / statureOf(short)),
      9,
    );
  });
});

function groundY(rig: Rig, pose: ReturnType<typeof restPose>): number {
  const point = anchorPointByRole(rig, pose, 'ground');
  if (!point.ok) throw new Error(point.error.message);
  return point.value.y;
}

/** How far the ground anchor sits above the floor at `timeMs`. */
function clearance(rig: Rig, clip: AnimationIR, timeMs: number): number {
  const pose = poseRig(rig, clipDeltasByRole(clip, evaluate(clip, timeMs)));
  return groundY(rig, restPose(rig)) - groundY(rig, pose);
}

// ── what is and is not rescaled ─────────────────────────────────────────────

describe('what carries over unchanged', () => {
  const short = signatureOf(bipedRig());
  const tall = signatureOf(bipedRig({ scale: 2 }));
  const authored = walkClipIr();
  const retargeted = retarget(authored, short, tall);

  it('leaves the structure, the ids, the seeds and the timings alone', () => {
    expect(retargeted.nodes).toEqual(authored.nodes);
    expect(retargeted.markers).toEqual(authored.markers);
    expect(retargeted.seed).toBe(authored.seed);
    expect(retargeted.durationMs).toBe(authored.durationMs);
    expect(retargeted.tracks.map((track) => track.id)).toEqual(
      authored.tracks.map((track) => track.id),
    );
    expect(retargeted.behaviours.map((behaviour) => behaviour.seed)).toEqual(
      authored.behaviours.map((behaviour) => behaviour.seed),
    );
  });

  it('leaves rotation angles alone - a knee bends the same at any size', () => {
    const sway = retargeted.behaviours.find((behaviour) => behaviour.kind === 'sway');
    expect(sway?.kind === 'sway' && sway.amplitudeDeg).toBe(14);
  });

  it('leaves a rotation track alone, keyframe for keyframe', () => {
    // The other half of "angles carry over": a lean authored on a short character is the
    // same lean on a tall one. Scaling it would tip the figure over.
    const lean = authored.tracks[0];
    if (lean === undefined) throw new Error('fixture');
    const withLean = {
      ...authored,
      tracks: [
        ...authored.tracks,
        { ...lean, id: `trk_${'0'.repeat(24)}A9`, channel: 'rotation' as const },
      ],
    };

    const result = retarget(withLean, short, tall);
    expect(result.tracks[2]).toEqual(withLean.tracks[2]);
  });

  it('rescales position keyframes and only position keyframes', () => {
    const carryY = retargeted.tracks.find((track) => track.channel === 'position.y');
    const authoredY = authored.tracks.find((track) => track.channel === 'position.y');
    expect(carryY?.keyframes.map((key) => key.value)).toEqual(
      authoredY?.keyframes.map((key) => key.value * 2),
    );
  });

  it('rescales a disabled behaviour too, so enabling it later is not a surprise', () => {
    const parked = retarget(walkClipIr({ carry: false }), short, tall);
    expect(strideOf(parked)).toBe(strideOf(walkClipIr({ carry: false })) * 2);
  });
});

describe('scaleBehaviour', () => {
  const base = { id: 'bhv_x', nodeId: 'nod_x', enabled: true, seed: 1, weight: 1 } as const;

  it('rescales the one distance in the behaviour set', () => {
    const walk = {
      ...base,
      kind: 'walk-cycle',
      stepsPerSecond: 2,
      strideLength: 30,
      bounce: 0.3,
      gait: 'walk',
    } as unknown as Behaviour;
    const scaled = scaleBehaviour(walk, 1.5);
    expect(scaled.kind === 'walk-cycle' && scaled.strideLength).toBe(45);
  });

  it('rescales an orbit’s centre and radius, which are both distances', () => {
    const orbit = {
      ...base,
      kind: 'orbit',
      centre: { x: 10, y: -20 },
      radius: { x: 4, y: 8 },
      periodMs: 1000,
      phase: 0,
    } as unknown as Behaviour;
    const scaled = scaleBehaviour(orbit, 2);
    expect(scaled.kind === 'orbit' && scaled.centre).toEqual({ x: 20, y: -40 });
    expect(scaled.kind === 'orbit' && scaled.radius).toEqual({ x: 8, y: 16 });
  });

  it('leaves a scene-space path alone - a taller character crosses the same courtyard', () => {
    const path = {
      ...base,
      kind: 'follow-path',
      path: 'M0 0 L100 0',
      durationMs: 1000,
      orientToPath: true,
      loop: 'loop',
    } as unknown as Behaviour;
    expect(scaleBehaviour(path, 3)).toEqual(path);
  });

  it('leaves angles, rates and normalised weights alone', () => {
    const wind = {
      ...base,
      kind: 'wind',
      hz: 0.3,
      amplitude: 0.25,
      gustiness: 0.4,
      direction: 0,
      tipBias: 0.7,
    } as unknown as Behaviour;
    expect(scaleBehaviour(wind, 4)).toEqual(wind);
  });

  it('rejects an unknown kind loudly rather than silently passing it through', () => {
    // A fourteenth behaviour that carries a distance and is not handled here would be a
    // clip that skates on every rig but the one it was authored on.
    const rogue = { ...base, kind: 'teleport' } as unknown as Behaviour;
    expect(() => scaleBehaviour(rogue, 2)).toThrow(/Unhandled behaviour kind/);
  });
});

// ── failure paths ───────────────────────────────────────────────────────────

describe('when a clip cannot be measured', () => {
  const short = signatureOf(bipedRig());

  /** The signature with `role` and everything hanging off it amputated. */
  function without(signature: RigSignature, role: string): RigSignature {
    const removed = new Set<string>([role]);
    for (const _pass of signature.bones) {
      for (const bone of signature.bones) {
        if (bone.parentRole !== null && removed.has(bone.parentRole)) removed.add(bone.role);
      }
    }
    return RigSignature.parse({
      ...signature,
      bones: signature.bones.filter((bone) => !removed.has(bone.role)),
      anchors: signature.anchors.filter((anchor) => !removed.has(anchor.boneRole)),
    });
  }

  it('fails when the target skeleton lacks a role the clip drives', () => {
    const legless = without(short, 'leg-left');
    const result = retargetClip(walkClipIr(), short, legless);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.context).toMatchObject({ role: 'leg-left', side: 'target' });
  });

  it('fails when the source skeleton lacks a role the clip drives', () => {
    const legless = without(short, 'leg-left');
    const result = retargetClip(walkClipIr(), legless, short);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.context).toMatchObject({ role: 'leg-left', side: 'source' });
  });

  it('fails when the source has no measurable proportion, rather than dividing by zero', () => {
    // The alternative is `Infinity` in every position keyframe, discovered a hundred
    // frames into a render.
    const flat = RigSignature.parse({
      archetype: 'biped',
      bones: short.bones.map((bone) => ({
        ...bone,
        rest: { ...bone.rest, position: { x: 0, y: 0 }, length: 0 },
      })),
      anchors: [],
    });
    const result = retargetClip(walkClipIr(), flat, short);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.context).toMatchObject({ side: 'source' });
    expect(!result.ok && result.error.message).toMatch(/no measurable proportion/);
  });

  it('carries an inert record on a role the target lacks through verbatim', () => {
    // Not fatal: nothing evaluates it, and rejecting the whole clip over it would fail
    // exactly the case the library exists to serve - a rig with most of a template's
    // bones. The disabled behaviour keeps its authored stride because there is nothing
    // to measure it against.
    const clip = walkClipIr({ carry: false });
    const cycle = clip.behaviours.find((behaviour) => behaviour.kind === 'walk-cycle');
    const leg = clip.nodes.find((node) => node.name === 'leg-left');
    if (cycle === undefined || leg === undefined) throw new Error('fixture');

    const parked = { ...clip, tracks: [], behaviours: [{ ...cycle, nodeId: leg.id }] };
    const result = retargetClip(parked, short, without(short, 'leg-left'));

    expect(result.ok).toBe(true);
    expect(result.ok && strideOf(result.value)).toBe(strideOf(parked));
  });
});
