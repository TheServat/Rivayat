import { describe, expect, it } from 'vitest';
import {
  AuthoredMotion,
  MotionRequest,
  Track,
  type MotionCapabilities,
  type MotionProviderKind,
  type NodeId,
} from '@rv/contracts';
import { ok, type AppError, type Result } from '@rv/shared-kernel';

import { deriveId, deriveSeed } from './derive';
import { KeyframeMotionProvider } from './keyframe-provider';
import type { MotionProvider } from './port';
import { ProceduralMotionProvider } from './procedural-provider';
import { MotionProviderRegistry } from './registry';
import { motionRequirements } from './requirements';

const NODE_A: NodeId = `nod_${'0'.repeat(24)}A1`;
const NODE_B: NodeId = `nod_${'0'.repeat(24)}A2`;

function keyframeRequest(overrides: Record<string, unknown> = {}): MotionRequest {
  return MotionRequest.parse({
    kind: 'keyframe',
    key: 'door-slam',
    curves: [
      {
        nodeId: NODE_A,
        channel: 'rotation',
        keys: [
          { timeMs: 400, value: 90 },
          { timeMs: 0, value: 0 },
          { timeMs: 200, value: 45 },
        ],
      },
    ],
    ...overrides,
  });
}

function proceduralRequest(overrides: Record<string, unknown> = {}): MotionRequest {
  return MotionRequest.parse({
    kind: 'procedural',
    key: 'grove-wind',
    seed: 17,
    nodeIds: [NODE_A, NODE_B],
    plans: [{ kind: 'wind' }, { kind: 'boil' }],
    ...overrides,
  });
}

function stub(
  id: string,
  kind: MotionProviderKind,
  capabilities: MotionCapabilities,
): MotionProvider & { calls: number } {
  return {
    id,
    kind,
    capabilities,
    calls: 0,
    author(): Promise<Result<AuthoredMotion, AppError>> {
      this.calls += 1;
      return Promise.resolve(ok({ tracks: [], behaviours: [] }));
    },
  };
}

// ── requirements ────────────────────────────────────────────────────────────

describe('what a request needs of a provider', () => {
  it('asks for exactly the channels a keyframe request writes, without repeats', () => {
    const request = keyframeRequest({
      curves: [
        { nodeId: NODE_A, channel: 'rotation', keys: [{ timeMs: 0, value: 0 }] },
        { nodeId: NODE_B, channel: 'rotation', keys: [{ timeMs: 0, value: 0 }] },
        { nodeId: NODE_A, channel: 'opacity', keys: [{ timeMs: 0, value: 0 }] },
      ],
    });
    expect(motionRequirements(request)).toEqual({
      channels: ['rotation', 'opacity'],
      behaviours: [],
    });
  });

  it('asks for the behaviour kinds a procedural request plans', () => {
    expect(motionRequirements(proceduralRequest())).toEqual({
      channels: [],
      behaviours: ['wind', 'boil'],
    });
  });

  it('names the three channels a physics bake writes, and no others', () => {
    // A solver produces a position and an orientation per body. Declaring that is what
    // lets a physics request be routed away from a provider that only serves rotation.
    const request = MotionRequest.parse({
      kind: 'physics',
      key: 'banner',
      seed: 1,
      bodies: [{ nodeId: NODE_A, massKg: 1 }],
      durationMs: 1000,
      sampleFps: 24,
    });
    expect(motionRequirements(request)).toEqual({
      channels: ['position.x', 'position.y', 'rotation'],
      behaviours: [],
    });
  });

  it('asks for nothing from a library request, because the fragment is not loaded yet', () => {
    // Honest rather than convenient: what a library clip drives is a property of a
    // content-addressed document nobody has read. Inventing a requirement would route
    // correctly only by luck.
    const request = MotionRequest.parse({
      kind: 'retargeted-library',
      key: 'hero-walk',
      clipName: 'walk',
      targetRig: {
        archetype: 'biped',
        bones: [
          {
            role: 'torso',
            parentRole: null,
            rest: { position: { x: 0, y: 0 }, rotation: 0, length: 10, scale: { x: 1, y: 1 } },
          },
        ],
      },
    });
    expect(motionRequirements(request)).toEqual({ channels: [], behaviours: [] });
  });

  it('rejects a request kind nobody has decided about', () => {
    // Adding a fifth motion source without saying what it needs is a build error at the
    // switch and a loud throw if it is forced past the type system.
    const rogue = { kind: 'mocap', key: 'take-3' } as unknown as MotionRequest;
    expect(() => motionRequirements(rogue)).toThrow(/Unhandled motion request kind/);
  });
});

// ── the registry ────────────────────────────────────────────────────────────

describe('registration', () => {
  it('refuses a provider that declares nothing, which nothing could ever route to', () => {
    const registry = new MotionProviderRegistry();
    expect(() =>
      registry.register(stub('mute', 'procedural', { channels: [], behaviours: [] })),
    ).toThrow(/declared no capabilities/);
  });

  it('refuses a second provider under the same id', () => {
    const registry = new MotionProviderRegistry();
    registry.register(new KeyframeMotionProvider());
    expect(() => registry.register(new KeyframeMotionProvider())).toThrow(/already registered/);
  });

  it('refuses a provider that declares a capability it has no method for', () => {
    // The only place the declaration and the implementation are compared. An adapter that
    // claims something it cannot serve is a routing hole.
    const registry = new MotionProviderRegistry();
    const hollow = {
      id: 'hollow',
      kind: 'procedural',
      capabilities: { channels: [], behaviours: ['wind'] },
    } as unknown as MotionProvider;
    expect(() => registry.register(hollow)).toThrow(/cannot serve/);
  });

  it('registers a batch and keeps registration order', () => {
    const registry = new MotionProviderRegistry();
    registry.registerAll([new KeyframeMotionProvider(), new ProceduralMotionProvider()]);
    expect(registry.providers().map((provider) => provider.id)).toEqual(['keyframe', 'procedural']);
    expect(registry.get('procedural')?.kind).toBe('procedural');
    expect(registry.get('physics')).toBeUndefined();
  });
});

describe('selection', () => {
  function loaded(): MotionProviderRegistry {
    const registry = new MotionProviderRegistry();
    registry.registerAll([new KeyframeMotionProvider(), new ProceduralMotionProvider()]);
    return registry;
  }

  it('routes on kind, without a switch on a provider name anywhere in core', () => {
    const registry = loaded();
    expect(registry.select(keyframeRequest()).ok).toBe(true);
    const chosen = registry.select(proceduralRequest());
    expect(chosen.ok && chosen.value.id).toBe('procedural');
  });

  it('reports nothing registered for a kind, listing what is', () => {
    const registry = loaded();
    const physics = MotionRequest.parse({
      kind: 'physics',
      key: 'banner',
      seed: 1,
      bodies: [{ nodeId: NODE_A, massKg: 1 }],
      durationMs: 1000,
      sampleFps: 24,
    });
    const result = registry.select(physics);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('not-found');
    expect(!result.ok && result.error.context.registered).toEqual(['keyframe', 'procedural']);
  });

  it('routes around a provider that serves only part of the request', () => {
    // Partial service is worse than none: the document would be missing behaviours and
    // nothing downstream distinguishes one that was dropped from one never asked for.
    const registry = new MotionProviderRegistry();
    registry.register(stub('windy', 'procedural', { channels: [], behaviours: ['wind'] }));
    const result = registry.select(proceduralRequest());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('unsupported');
    expect(!result.ok && result.error.message).toContain('boil');
  });

  it('picks a later provider that covers what an earlier one does not', () => {
    const registry = new MotionProviderRegistry();
    const narrow = stub('windy', 'procedural', { channels: [], behaviours: ['wind'] });
    registry.register(narrow);
    registry.register(new ProceduralMotionProvider());

    const chosen = registry.select(proceduralRequest());
    expect(chosen.ok && chosen.value.id).toBe('procedural');
    expect(narrow.calls).toBe(0);
  });

  it('selects and calls in one step, and reports a selection failure as the result', async () => {
    const registry = loaded();
    const authored = await registry.author(proceduralRequest());
    expect(authored.ok && authored.value.behaviours).toHaveLength(4);

    const empty = new MotionProviderRegistry();
    const missed = await empty.author(proceduralRequest());
    expect(missed.ok).toBe(false);
  });
});

// ── the keyframe source ─────────────────────────────────────────────────────

describe('the keyframe provider', () => {
  const provider = new KeyframeMotionProvider();

  it('turns keys that arrived in any order into a legal track', async () => {
    // `Track` refines its keyframes to be strictly increasing and nothing that produces
    // keys guarantees it: a drag moves one past its neighbour, a model emits them in the
    // order it thought of them.
    const authored = await provider.author(keyframeRequest());
    expect(authored.ok).toBe(true);
    if (!authored.ok) return;

    const track = authored.value.tracks[0];
    expect(track?.keyframes.map((key) => key.timeMs)).toEqual([0, 200, 400]);
    expect(Track.safeParse(track).success).toBe(true);
  });

  it('lets the later key win a collision, because the later key is the edit', async () => {
    const authored = await provider.author(
      keyframeRequest({
        curves: [
          {
            nodeId: NODE_A,
            channel: 'rotation',
            keys: [
              { timeMs: 100, value: 10 },
              { timeMs: 100, value: 20 },
            ],
          },
        ],
      }),
    );
    expect(authored.ok && authored.value.tracks[0]?.keyframes).toEqual([
      { timeMs: 100, value: 20 },
    ]);
  });

  it('derives track ids from the request, so authoring twice is one document', async () => {
    const first = await provider.author(keyframeRequest());
    const second = await provider.author(keyframeRequest());
    expect(first.ok && second.ok && first.value).toEqual(second.ok ? second.value : undefined);
  });

  it('gives two curves on one node two ids', async () => {
    const authored = await provider.author(
      keyframeRequest({
        curves: [
          { nodeId: NODE_A, channel: 'rotation', keys: [{ timeMs: 0, value: 0 }] },
          { nodeId: NODE_A, channel: 'opacity', keys: [{ timeMs: 0, value: 0 }] },
        ],
      }),
    );
    expect(authored.ok && new Set(authored.value.tracks.map((track) => track.id)).size).toBe(2);
  });

  it('carries the extrapolation and additive flags the caller chose', async () => {
    const authored = await provider.author(
      keyframeRequest({
        curves: [
          {
            nodeId: NODE_A,
            channel: 'rotation',
            keys: [{ timeMs: 0, value: 0 }],
            before: 'loop',
            after: 'ping-pong',
            additive: true,
          },
        ],
      }),
    );
    expect(authored.ok && authored.value.tracks[0]).toMatchObject({
      before: 'loop',
      after: 'ping-pong',
      additive: true,
    });
  });

  it('refuses a request of another kind rather than guessing', async () => {
    // The registry routes on kind, so reaching this means something bypassed it - a
    // caller's mistake, which is what `Result` is for.
    const refused = await provider.author(proceduralRequest());
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.kind).toBe('unsupported');
  });

  it('can be registered twice under two ids, which is what per-instance ids are for', () => {
    const registry = new MotionProviderRegistry();
    registry.register(new KeyframeMotionProvider('mocap-import'));
    registry.register(new KeyframeMotionProvider('timeline'));
    expect(registry.providers()).toHaveLength(2);
  });
});

// ── the procedural source ───────────────────────────────────────────────────

describe('the procedural provider', () => {
  const provider = new ProceduralMotionProvider();

  it('applies every plan to every node, which is what makes a forest one request', async () => {
    const authored = await provider.author(proceduralRequest());
    expect(authored.ok).toBe(true);
    if (!authored.ok) return;
    expect(authored.value.behaviours).toHaveLength(4);
    expect(authored.value.behaviours.map((behaviour) => behaviour.nodeId)).toEqual([
      NODE_A,
      NODE_A,
      NODE_B,
      NODE_B,
    ]);
  });

  it('derives a different seed per node, so two trees gust differently', async () => {
    // The IR's own docstring asks for exactly this and nothing enforced it. A plan has
    // no seed field at all, so a caller cannot supply one.
    const authored = await provider.author(proceduralRequest());
    if (!authored.ok) return;
    const seeds = authored.value.behaviours
      .filter((behaviour) => behaviour.kind === 'wind')
      .map((behaviour) => behaviour.seed);
    expect(new Set(seeds).size).toBe(2);
  });

  it('derives the same seeds again for the same request', async () => {
    const first = await provider.author(proceduralRequest());
    const second = await provider.author(proceduralRequest());
    expect(first.ok && second.ok && first.value).toEqual(second.ok ? second.value : undefined);
  });

  it('moves every seed when the request’s root seed moves', async () => {
    const first = await provider.author(proceduralRequest());
    const second = await provider.author(proceduralRequest({ seed: 18 }));
    if (!first.ok || !second.ok) return;
    const before = first.value.behaviours.map((behaviour) => behaviour.seed);
    const after = second.value.behaviours.map((behaviour) => behaviour.seed);
    expect(after).not.toEqual(before);
    // The ids do not move: the same plan on the same node is the same record.
    expect(second.value.behaviours.map((behaviour) => behaviour.id)).toEqual(
      first.value.behaviours.map((behaviour) => behaviour.id),
    );
  });

  it('keeps the plan’s parameters and window verbatim', async () => {
    const authored = await provider.author(
      proceduralRequest({
        nodeIds: [NODE_A],
        plans: [{ kind: 'sway', hz: 3, amplitudeDeg: 21, startMs: 100, endMs: 900, weight: 0.5 }],
      }),
    );
    expect(authored.ok && authored.value.behaviours[0]).toMatchObject({
      kind: 'sway',
      hz: 3,
      amplitudeDeg: 21,
      startMs: 100,
      endMs: 900,
      weight: 0.5,
    });
  });

  it('produces behaviours that parse as behaviours', async () => {
    const authored = await provider.author(proceduralRequest());
    expect(authored.ok && AuthoredMotion.safeParse(authored.value).success).toBe(true);
  });

  it('refuses a request of another kind', async () => {
    const refused = await provider.author(keyframeRequest());
    expect(refused.ok).toBe(false);
  });
});

// ── derived identity ────────────────────────────────────────────────────────

describe('derived ids and seeds', () => {
  it('produces a ULID-shaped id the contracts accept', () => {
    expect(deriveId('trk', 'anything')).toMatch(/^trk_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is a pure function of the seed string', () => {
    expect(deriveId('trk', 'a')).toBe(deriveId('trk', 'a'));
    expect(deriveId('trk', 'a')).not.toBe(deriveId('trk', 'b'));
  });

  it('turns an address into a non-negative integer seed', () => {
    const seed = deriveSeed([17, 'grove-wind', 'wind', 0, NODE_A]);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(deriveSeed([17, 'grove-wind'])).not.toBe(deriveSeed([18, 'grove-wind']));
  });
});
