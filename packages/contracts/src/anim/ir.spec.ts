import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { animationIr, foreignIds, testIds } from '../__fixtures__/builders';
import {
  AnimChannel,
  AnimNode,
  AnimationIR,
  Behaviour,
  CameraTrack,
  IR_VERSION,
  Marker,
  Track,
} from './ir';

describe('AnimationIR structural integrity', () => {
  it('accepts a minimal valid document', () => {
    expect(AnimationIR.safeParse(animationIr()).success).toBe(true);
  });

  it('pins the schema version so a future migration is forced to be explicit', () => {
    expect(IR_VERSION).toBe(1);
    const result = AnimationIR.safeParse(animationIr({ irVersion: 2 }));
    expect(result.success).toBe(false);
  });

  it('rejects duplicate node ids', () => {
    const ir = animationIr();
    const first = ir.nodes[0]!;
    const result = AnimationIR.safeParse({ ...ir, nodes: [first, { ...first, name: 'clone' }] });
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/duplicate node id/);
  });

  it('rejects a node whose parent does not exist', () => {
    const ids = foreignIds();
    const ir = animationIr();
    const orphaned = { ...ir.nodes[0]!, parentId: ids.node() };
    const result = AnimationIR.safeParse({ ...ir, nodes: [orphaned], tracks: [] });
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/unknown parent/);
  });

  it('rejects a cycle in the node hierarchy rather than hanging the evaluator', () => {
    const ids = testIds();
    const a = ids.node();
    const b = ids.node();
    const base = animationIr();
    const result = AnimationIR.safeParse({
      ...base,
      nodes: [
        { kind: 'group', id: a, name: 'a', parentId: b, transform: {}, visible: true, depth: 0 },
        { kind: 'group', id: b, name: 'b', parentId: a, transform: {}, visible: true, depth: 0 },
      ],
      tracks: [],
    });
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/cycle/);
  });

  it('rejects a track pointing at a node that is not in the document', () => {
    const ids = foreignIds();
    const ir = animationIr();
    const result = AnimationIR.safeParse({
      ...ir,
      tracks: [{ ...ir.tracks![0]!, nodeId: ids.node() }],
    });
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/targets unknown node/);
  });

  it('rejects a behaviour pointing at a node that is not in the document', () => {
    const ids = foreignIds();
    const ir = animationIr();
    const result = AnimationIR.safeParse({
      ...ir,
      behaviours: [
        {
          kind: 'wind',
          id: ids.behaviour(),
          nodeId: ids.node(),
          enabled: true,
          seed: 1,
          weight: 1,
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/targets unknown node/);
  });

  it('rejects a behaviour window that ends at or before it starts', () => {
    const ids = testIds();
    const ir = animationIr();
    const nodeId = ir.nodes[0]!.id;
    for (const [startMs, endMs] of [
      [1000, 1000],
      [1000, 500],
    ]) {
      const result = AnimationIR.safeParse({
        ...ir,
        behaviours: [
          {
            kind: 'sway',
            id: ids.behaviour(),
            nodeId,
            enabled: true,
            seed: 1,
            weight: 1,
            startMs,
            endMs,
          },
        ],
      });
      expect(result.success).toBe(false);
      expect(z.prettifyError(result.error!)).toMatch(/ends at or before it starts/);
    }
  });

  it('accepts a behaviour window that is well ordered', () => {
    const ids = testIds();
    const ir = animationIr();
    const result = AnimationIR.safeParse({
      ...ir,
      behaviours: [
        {
          kind: 'sway',
          id: ids.behaviour(),
          nodeId: ir.nodes[0]!.id,
          enabled: true,
          seed: 1,
          weight: 1,
          startMs: 500,
          endMs: 1500,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a camera focusing a node that is not in the document', () => {
    const ids = foreignIds();
    const ir = animationIr();
    const result = AnimationIR.safeParse({
      ...ir,
      camera: {
        keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
        focusNodeId: ids.node(),
        shakeAmplitude: 0,
        shakeSeed: 0,
      },
    });
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/camera focus targets an unknown node/);
  });

  it('accepts a camera focusing a node that exists', () => {
    const ir = animationIr();
    const result = AnimationIR.safeParse({
      ...ir,
      camera: {
        keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
        focusNodeId: ir.nodes[0]!.id,
      },
    });
    expect(result.success).toBe(true);
  });

  it('requires at least one node and a positive duration', () => {
    expect(AnimationIR.safeParse(animationIr({ nodes: [], tracks: [] })).success).toBe(false);
    expect(AnimationIR.safeParse(animationIr({ durationMs: 0 })).success).toBe(false);
    expect(AnimationIR.safeParse(animationIr({ durationMs: -1 })).success).toBe(false);
  });
});

describe('Track', () => {
  const ids = testIds();
  const nodeId = ids.node();
  const base = {
    id: ids.track(),
    nodeId,
    channel: 'opacity' as const,
    before: 'hold' as const,
    after: 'hold' as const,
    additive: false,
  };

  it('requires strictly increasing keyframe times', () => {
    // Equal times are rejected too: two values at the same instant makes the
    // evaluator's answer depend on array order, which is not a definition.
    for (const times of [
      [0, 0],
      [100, 50],
      [0, 500, 400],
    ]) {
      const result = Track.safeParse({
        ...base,
        keyframes: times.map((timeMs) => ({ timeMs, value: 1 })),
      });
      expect(result.success).toBe(false);
      expect(z.prettifyError(result.error!)).toMatch(/strictly ordered by time/);
    }
  });

  it('accepts an ordered track and a single-keyframe track', () => {
    expect(
      Track.safeParse({
        ...base,
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 1, value: 1 },
        ],
      }).success,
    ).toBe(true);
    expect(Track.safeParse({ ...base, keyframes: [{ timeMs: 0, value: 0 }] }).success).toBe(true);
  });

  it('rejects an empty keyframe list', () => {
    expect(Track.safeParse({ ...base, keyframes: [] }).success).toBe(false);
  });

  it('defaults extrapolation to hold and additive to false', () => {
    const parsed = Track.parse({
      id: ids.track(),
      nodeId,
      channel: 'rotation',
      keyframes: [{ timeMs: 0, value: 0 }],
    });
    expect(parsed).toMatchObject({ before: 'hold', after: 'hold', additive: false });
  });
});

describe('node union', () => {
  const ids = testIds();
  const shared = {
    id: ids.node(),
    name: 'n',
    parentId: null,
    transform: {},
    visible: true,
    depth: 0,
  };

  it('routes each kind to its own payload', () => {
    expect(AnimNode.safeParse({ ...shared, kind: 'group' }).success).toBe(true);
    expect(
      AnimNode.safeParse({ ...shared, kind: 'text', text: 'سلام', direction: 'rtl' }).success,
    ).toBe(true);
    expect(AnimNode.safeParse({ ...shared, kind: 'shape', shape: 'rect' }).success).toBe(true);
  });

  it('rejects a payload that does not match its kind', () => {
    // A text node without text is not a text node.
    expect(AnimNode.safeParse({ ...shared, kind: 'text' }).success).toBe(false);
    // An fx emitter without a seed would be non-deterministic, so it is not allowed.
    expect(
      AnimNode.safeParse({
        ...shared,
        kind: 'fx-emitter',
        effect: 'dust',
        rate: 10,
        area: { width: 100, height: 100 },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(AnimNode.safeParse({ ...shared, kind: 'hologram' }).success).toBe(false);
  });

  it('defaults text direction to auto so Persian content is not forced LTR', () => {
    const parsed = AnimNode.parse({ ...shared, kind: 'text', text: 'روایت' });
    expect(parsed).toMatchObject({ direction: 'auto' });
  });
});

describe('behaviour union', () => {
  const ids = testIds();
  const shared = { id: ids.behaviour(), nodeId: ids.node(), enabled: true, seed: 42, weight: 1 };

  it('covers every declared kind', () => {
    const kinds = [
      { kind: 'wind' },
      { kind: 'breathe' },
      { kind: 'blink' },
      { kind: 'sway' },
      { kind: 'walk-cycle' },
      { kind: 'flap' },
      { kind: 'orbit', centre: { x: 0, y: 0 }, radius: { x: 10, y: 10 } },
      { kind: 'parallax' },
      { kind: 'boil' },
      { kind: 'spring' },
      { kind: 'look-at', targetNodeId: ids.node() },
      { kind: 'follow-path', path: 'M0,0 L10,10', durationMs: 1000 },
      { kind: 'lip-sync', phonemes: [{ timeMs: 0, viseme: 'aa', durationMs: 80 }] },
    ];
    for (const extra of kinds) {
      const result = Behaviour.safeParse({ ...shared, ...extra });
      expect(result.success, `${extra.kind} should parse`).toBe(true);
    }
  });

  it('requires a seed on every behaviour, because determinism is not optional', () => {
    const { seed: _seed, ...withoutSeed } = shared;
    expect(Behaviour.safeParse({ ...withoutSeed, kind: 'wind' }).success).toBe(false);
  });

  it('rejects a negative seed', () => {
    expect(Behaviour.safeParse({ ...shared, seed: -1, kind: 'wind' }).success).toBe(false);
  });

  it('applies documented defaults', () => {
    const parsed = Behaviour.parse({ ...shared, kind: 'blink' });
    expect(parsed).toMatchObject({ intervalMs: 4200, varianceMs: 1800, closeDurationMs: 110 });
  });
});

describe('camera and markers', () => {
  it('requires at least one camera keyframe', () => {
    expect(CameraTrack.safeParse({ keyframes: [] }).success).toBe(false);
  });

  it('defaults shake to nothing', () => {
    const parsed = CameraTrack.parse({
      keyframes: [{ timeMs: 0, position: { x: 0, y: 0 } }],
    });
    expect(parsed).toMatchObject({ shakeAmplitude: 0, shakeSeed: 0 });
    expect(parsed.keyframes[0]).toMatchObject({ zoom: 1, rotation: 0 });
  });

  it('accepts every marker kind', () => {
    const ids = testIds();
    for (const kind of ['beat', 'cut', 'dialogue', 'sfx', 'music', 'custom']) {
      expect(Marker.safeParse({ id: ids.marker(), timeMs: 0, kind, label: 'x' }).success).toBe(
        true,
      );
    }
  });
});

describe('JSON Schema emission', () => {
  it('emits a schema an LLM can be constrained by', () => {
    // Structured output is the only sanctioned way we get JSON out of a model, so a
    // schema that cannot be converted is a schema that cannot be generated.
    const schema = z.toJSONSchema(AnimNode, { io: 'input' }) as { oneOf?: unknown[] };
    // Zod emits `oneOf` for a discriminated union - one branch per node kind.
    expect(schema.oneOf).toHaveLength(7);
  });

  it('enumerates the animatable channels in the emitted schema', () => {
    const schema = z.toJSONSchema(AnimChannel) as { enum?: string[] };
    expect(schema.enum).toContain('position.x');
    expect(schema.enum).toContain('opacity');
  });
});

// ── nothing floating reaches a render ───────────────────────────────────────
//
// The IR is the render document, and CLAUDE.md non-negotiable #1 requires a render to
// be bit-reproducible. "Whatever version is current" cannot be resolved consistently by
// a replay, a shard or a resumed worker, so the schema refuses to express it.

describe('an IR cannot hold an unpinned asset reference', () => {
  const ids = testIds();
  const assetId = ids.asset();
  const versionId = ids.assetVersion();
  const nodeId = ids.node();

  const placement = {
    kind: 'asset-instance',
    id: nodeId,
    name: 'oak',
    parentId: null,
    transform: {},
    visible: true,
    depth: 0,
  };

  it('accepts a placement that names the exact version', () => {
    const result = AnimNode.safeParse({ ...placement, asset: { assetId, versionId } });
    expect(result.success).toBe(true);
  });

  it('rejects a placement that leaves the version to be resolved later', () => {
    const result = AnimNode.safeParse({ ...placement, asset: { assetId } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['asset.versionId']);
  });

  it('refuses a whole IR built on an unpinned placement, not just the node', () => {
    expect(
      AnimationIR.safeParse(animationIr({ nodes: [{ ...placement, asset: { assetId } }] })).success,
    ).toBe(false);
  });

  it('renders a variant by the key the author wrote, carried through compilation', () => {
    const parsed = AnimNode.parse({
      ...placement,
      asset: { assetId, versionId, variantKey: 'winter' },
    });
    expect(parsed).toMatchObject({ asset: { variantKey: 'winter' } });
  });
});

describe('part and bone overrides address a real instance', () => {
  const ids = testIds();
  const assetId = ids.asset();
  const versionId = ids.assetVersion();
  const instanceNode = ids.node();
  const groupNode = ids.node();

  const instance = {
    kind: 'asset-instance',
    id: instanceNode,
    name: 'oak',
    parentId: null,
    transform: {},
    visible: true,
    depth: 0,
    asset: { assetId, versionId },
  };

  const group = {
    kind: 'group',
    id: groupNode,
    name: 'staging',
    parentId: null,
    transform: {},
    visible: true,
    depth: 0,
  };

  function override(kind: 'part' | 'bone', instanceId: string): Record<string, unknown> {
    return {
      kind,
      id: ids.node(),
      name: `${kind}-override`,
      parentId: null,
      transform: {},
      visible: true,
      depth: 0,
      instanceId,
      ...(kind === 'part' ? { partId: ids.part() } : { boneId: ids.bone() }),
    };
  }

  it('accepts an override pointed at an asset-instance node', () => {
    expect(
      AnimationIR.safeParse(
        animationIr({ nodes: [instance, override('part', instanceNode)], tracks: [] }),
      ).success,
    ).toBe(true);
  });

  it('rejects a part override pointed at a group, which has no parts to override', () => {
    const result = AnimationIR.safeParse(
      animationIr({ nodes: [group, override('part', groupNode)], tracks: [] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'nodes.1.instanceId',
    ]);
  });

  it('rejects a bone override pointed at a node that is not in the document at all', () => {
    const stranger = foreignIds().node();
    const result = AnimationIR.safeParse(
      animationIr({ nodes: [instance, override('bone', stranger)], tracks: [] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'nodes.1.instanceId',
    ]);
  });
});
