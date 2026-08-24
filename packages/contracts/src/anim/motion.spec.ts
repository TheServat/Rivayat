import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { testIds } from '../__fixtures__/builders';
import { BehaviourKind } from './ir';
import {
  AuthoredMotion,
  BehaviourPlan,
  KeyframeCurve,
  MOTION_PROVIDER_PURPOSE,
  MotionCapabilities,
  MotionProviderKind,
  MotionRequest,
  NO_MOTION,
  PhysicsMotionRequest,
} from './motion';

const ids = testIds();
const NODE = ids.node();

describe('the motion sources we admit', () => {
  it('explains why every kind exists, so a fifth has to argue for itself', () => {
    for (const kind of MotionProviderKind.options) {
      expect(MOTION_PROVIDER_PURPOSE[kind].length, kind).toBeGreaterThan(20);
    }
  });

  it('does not admit AI video, which is footage rather than a function of time', () => {
    // ADR-0008 §2. Modelling video as motion means either the evaluator learns to
    // decode video - it does not, it is pure - or "motion" means two incompatible
    // things. It enters as an asset representation instead.
    expect(MotionProviderKind.options).not.toContain('ai-video');
  });
});

describe('MotionCapabilities - what a provider declares it can author', () => {
  it('declares nothing by default, which is a provider the router skips', () => {
    const parsed = MotionCapabilities.parse({});
    expect(parsed).toEqual({ channels: [], behaviours: [] });
  });

  it('rejects a behaviour kind that does not exist', () => {
    expect(MotionCapabilities.safeParse({ behaviours: ['teleport'] }).success).toBe(false);
  });

  it('names behaviours in the same vocabulary the IR does', () => {
    const parsed = MotionCapabilities.parse({ behaviours: [...BehaviourKind.options] });
    expect(parsed.behaviours).toHaveLength(BehaviourKind.options.length);
  });
});

describe('a keyframe request carries keys as they arrived, not as a legal track', () => {
  const curve = {
    nodeId: NODE,
    channel: 'rotation',
    keys: [
      { timeMs: 400, value: 12 },
      { timeMs: 0, value: 0 },
      { timeMs: 400, value: 30 },
    ],
  };

  it('accepts out-of-order and colliding keys, because that is what a drag produces', () => {
    // `Track` refines its keyframes to be strictly increasing. A request that demanded
    // the same would leave the provider with nothing to do and push normalisation onto
    // every caller - a timeline drag, an LLM and a mocap import all produce this.
    const result = KeyframeCurve.safeParse(curve);
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('holds outside its span by default', () => {
    const parsed = KeyframeCurve.parse(curve);
    expect([parsed.before, parsed.after, parsed.additive]).toEqual(['hold', 'hold', false]);
  });

  it('requires at least one key', () => {
    expect(KeyframeCurve.safeParse({ ...curve, keys: [] }).success).toBe(false);
  });
});

describe('a procedural request is a behaviour without its identity', () => {
  it('has no place to put an id, a node or a seed', () => {
    // Removed rather than made optional: a caller supplying its own seed is exactly the
    // failure the IR's docstring warns about, and an optional field is an invitation.
    const plan = BehaviourPlan.parse({ kind: 'sway', hz: 0.5, amplitudeDeg: 4, axis: 'rotation' });
    expect(plan).not.toHaveProperty('id');
    expect(plan).not.toHaveProperty('nodeId');
    expect(plan).not.toHaveProperty('seed');
  });

  it('keeps the parameters and the window, which are the author’s to choose', () => {
    const plan = BehaviourPlan.parse({ kind: 'wind', hz: 1.5, startMs: 200, endMs: 900 });
    expect(plan).toMatchObject({ kind: 'wind', hz: 1.5, startMs: 200, endMs: 900, weight: 1 });
  });

  it('covers every behaviour kind, so no behaviour is unrequestable', () => {
    const planned = new Set(BehaviourPlan.options.map((option) => option.shape.kind.value));
    expect([...BehaviourKind.options].filter((kind) => !planned.has(kind))).toEqual([]);
  });

  it('rejects a plan for a behaviour kind that does not exist', () => {
    expect(BehaviourPlan.safeParse({ kind: 'teleport' }).success).toBe(false);
  });
});

describe('the request union', () => {
  function parse(value: unknown): z.ZodSafeParseResult<MotionRequest> {
    return MotionRequest.safeParse(value);
  }

  it('accepts each of the four sources', () => {
    expect(
      parse({
        kind: 'keyframe',
        key: 'door-slam',
        curves: [{ nodeId: NODE, channel: 'rotation', keys: [{ timeMs: 0, value: 0 }] }],
      }).success,
    ).toBe(true);

    expect(
      parse({
        kind: 'procedural',
        key: 'grove-wind',
        seed: 7,
        nodeIds: [NODE],
        plans: [{ kind: 'wind' }],
      }).success,
    ).toBe(true);

    expect(
      parse({
        kind: 'physics',
        key: 'banner-drop',
        seed: 3,
        bodies: [{ nodeId: NODE, massKg: 1 }],
        durationMs: 2000,
        sampleFps: 24,
      }).success,
    ).toBe(true);

    expect(
      parse({
        kind: 'retargeted-library',
        key: 'hero-walk',
        clipName: 'walk',
        targetRig: {
          archetype: 'biped',
          bones: [
            {
              role: 'torso',
              parentRole: null,
              rest: { position: { x: 0, y: 0 }, rotation: 0, length: 100, scale: { x: 1, y: 1 } },
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('carries no notion of "at time t" - a provider is asked for a clip, never a frame', () => {
    // One of the three things that keep a provider outside the determinism boundary:
    // there is nowhere in a request to put the instant the evaluator is at.
    for (const option of MotionRequest.options) {
      expect(Object.keys(option.shape)).not.toContain('timeMs');
      expect(Object.keys(option.shape)).not.toContain('atMs');
    }
  });

  it('rejects a request whose kind is not a source we admit', () => {
    expect(parse({ kind: 'ai-video', key: 'shot-4' }).success).toBe(false);
  });

  it('gives a physics bake a sample rate, because a bake at 12 fps is a different artefact', () => {
    const parsed = PhysicsMotionRequest.parse({
      kind: 'physics',
      key: 'banner-drop',
      seed: 3,
      bodies: [{ nodeId: NODE, massKg: 1 }],
      durationMs: 2000,
      sampleFps: 12,
    });
    expect(parsed.sampleFps).toBe(12);
    expect(parsed.gravity).toEqual({ x: 0, y: 980 });
    expect(parsed.bodies[0]).toMatchObject({ restitution: 0.2, drag: 0.05, pinned: false });
  });
});

describe('what a provider may hand back', () => {
  it('is tracks and behaviours, and nothing that could be called later', () => {
    // A sampler, a callback or a frame would all be ways of putting the provider back
    // inside the boundary. The result shape is the boundary.
    expect(Object.keys(AuthoredMotion.shape).sort()).toEqual(['behaviours', 'tracks']);
  });

  it('has an empty form for a provider that legitimately had no opinion', () => {
    expect(AuthoredMotion.parse(NO_MOTION)).toEqual({ tracks: [], behaviours: [] });
  });
});
