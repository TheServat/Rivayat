import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { animationIr, foreignIds, testIds } from '../__fixtures__/builders';
import {
  AnimChannel,
  AnimNode,
  AnimationIR,
  Behaviour,
  CAMERA_PROJECTIONS,
  CameraTrack,
  IR_VERSION,
  Marker,
  NodeAttachment,
  PROJECTION_BASES,
  Track,
  projectScenePoint,
  projectedExtent,
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

  it('defaults the projection to orthographic, which is what every existing document meant', () => {
    const parsed = CameraTrack.parse({ keyframes: [{ timeMs: 0, position: { x: 0, y: 0 } }] });
    expect(parsed.projection).toBe('orthographic');
  });

  it('keeps the projection off the keyframe, because tweening one is a cut and not a move', () => {
    const rejected = CameraTrack.safeParse({
      keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, projection: 'isometric' }],
    });
    // Not an error - unknown keys are stripped - but it must not survive into the
    // document, or two keyframes could disagree about what projection the shot is in.
    expect(rejected.success).toBe(true);
    expect(rejected.data?.keyframes[0]).not.toHaveProperty('projection');
  });
});

// ── projection ───────────────────────────────────────────────────────────────

describe('camera projection', () => {
  it('has a basis for every projection in the vocabulary', () => {
    for (const projection of CAMERA_PROJECTIONS) {
      expect(PROJECTION_BASES[projection]).toBeDefined();
    }
    expect(Object.keys(PROJECTION_BASES).sort()).toEqual([...CAMERA_PROJECTIONS].sort());
  });

  it('is invertible for every projection, or the reframer could not solve a crop in it', () => {
    for (const projection of CAMERA_PROJECTIONS) {
      const basis = PROJECTION_BASES[projection];
      const determinant = basis.xAxis.x * basis.yAxis.y - basis.yAxis.x * basis.xAxis.y;
      expect(Math.abs(determinant)).toBeGreaterThan(0.1);
    }
  });

  describe('orthographic is exactly the identity, so today renders byte-identically', () => {
    const cases = [
      { x: 0, y: 0 },
      { x: 1, y: -1 },
      { x: 960, y: -540 },
      { x: -0.1, y: 0.7 },
      { x: 1e-9, y: 1e9 },
      { x: 1 / 3, y: 2 / 3 },
    ];

    it('returns the point unchanged at any depth, by identity and not by rounding', () => {
      for (const point of cases) {
        for (const depth of [0, 1, 42, -17, 1e6]) {
          const projected = projectScenePoint('orthographic', point, depth);
          // `toBe` is Object.is: this is exact equality, not a tolerance.
          expect(projected.x).toBe(point.x);
          expect(projected.y).toBe(point.y);
        }
      }
    });

    it('leaves the composition extent alone, so no crop moves', () => {
      expect(projectedExtent('orthographic', { width: 1920, height: 1080 })).toEqual({
        width: 1920,
        height: 1080,
      });
    });

    it('defaults the depth argument, so a 2D caller need not think about it', () => {
      expect(projectScenePoint('orthographic', { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
    });

    it('sorts by depth, which is the rule the renderer already implements', () => {
      expect(PROJECTION_BASES.orthographic.sort).toBe('depth');
    });
  });

  describe('isometric is a matrix and a sort order, and nothing else', () => {
    const SQRT3_OVER_2 = Math.sqrt(3) / 2;

    it('turns the scene axes into a true isometric diamond', () => {
      // One scene unit along x goes right and down; one along y goes left and down, by
      // the same amount. That is a 30-degree elevation, and the diamond it traces is
      // sqrt(3) wide for every 1 tall.
      const alongX = projectScenePoint('isometric', { x: 1, y: 0 });
      const alongY = projectScenePoint('isometric', { x: 0, y: 1 });
      expect(alongX.x).toBeCloseTo(SQRT3_OVER_2, 12);
      expect(alongX.y).toBeCloseTo(0.5, 12);
      expect(alongY.x).toBeCloseTo(-SQRT3_OVER_2, 12);
      expect(alongY.y).toBeCloseTo(0.5, 12);
      expect(alongX.y).toBeCloseTo(alongY.y, 12);
    });

    it('sends the scene diagonal straight down the screen, which is what makes it read as a floor', () => {
      const diagonal = projectScenePoint('isometric', { x: 1, y: 1 });
      expect(diagonal.x).toBeCloseTo(0, 12);
      expect(diagonal.y).toBeCloseTo(1, 12);
    });

    it('lifts depth up the screen, so what is further away draws higher', () => {
      const ground = projectScenePoint('isometric', { x: 3, y: 5 }, 0);
      const raised = projectScenePoint('isometric', { x: 3, y: 5 }, 40);
      expect(raised.x).toBe(ground.x);
      expect(raised.y).toBe(ground.y - 40);
    });

    it('is linear in depth, so a stack of layers separates evenly', () => {
      const at = (depth: number): number => projectScenePoint('isometric', { x: 0, y: 0 }, depth).y;
      expect(at(20) - at(10)).toBeCloseTo(at(60) - at(50), 12);
    });

    it('widens and shortens the composition, which is what the reframer must normalise against', () => {
      const extent = projectedExtent('isometric', { width: 1000, height: 1000 });
      expect(extent.width).toBeCloseTo(2 * SQRT3_OVER_2 * 1000, 9);
      expect(extent.height).toBeCloseTo(1000, 9);
      expect(extent.width).toBeGreaterThan(1000);
    });

    it('sorts by projected y, because depth no longer decides who occludes whom', () => {
      expect(PROJECTION_BASES.isometric.sort).toBe('projected-y');
    });
  });

  it('is linear, so translating the camera commutes with projecting the scene', () => {
    // The property that lets a renderer insert the projection into the existing camera
    // matrix as one extra multiply, with the camera position still authored in scene
    // space: P(p - c) === P(p) - P(c).
    const point = { x: 130, y: -70 };
    const camera = { x: -400, y: 25 };
    const before = projectScenePoint('isometric', {
      x: point.x - camera.x,
      y: point.y - camera.y,
    });
    const pp = projectScenePoint('isometric', point);
    const pc = projectScenePoint('isometric', camera);
    expect(before.x).toBeCloseTo(pp.x - pc.x, 9);
    expect(before.y).toBeCloseTo(pp.y - pc.y, 9);
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

// ── attachments: a prop on a rig anchor, with no bone named anywhere ────────

describe('NodeAttachment', () => {
  it('inherits the anchor’s rotation by default, because a held prop turns with the hand', () => {
    expect(NodeAttachment.parse({ anchor: 'grip-right' })).toEqual({
      anchor: 'grip-right',
      inheritRotation: true,
    });
  });

  it('can opt out, for something that tracks a point and must stay upright', () => {
    // A speech balloon over a tumbling character.
    expect(NodeAttachment.parse({ anchor: 'speech', inheritRotation: false }).inheritRotation).toBe(
      false,
    );
  });

  it('requires a machine-safe anchor name', () => {
    expect(NodeAttachment.safeParse({ anchor: 'Grip Right' }).success).toBe(false);
  });
});

describe('an attachment hangs off something with a rig', () => {
  const ids = testIds();
  const instanceNode = ids.node();
  const groupNode = ids.node();

  const instance = {
    kind: 'asset-instance',
    id: instanceNode,
    name: 'kael',
    parentId: null,
    transform: {},
    visible: true,
    depth: 0,
    asset: { assetId: ids.asset(), versionId: ids.assetVersion() },
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

  function prop(parentId: string | null): Record<string, unknown> {
    return {
      kind: 'asset-instance',
      id: ids.node(),
      name: 'lantern',
      parentId,
      transform: {},
      visible: true,
      depth: 0,
      asset: { assetId: ids.asset(), versionId: ids.assetVersion() },
      attachment: { anchor: 'grip-right' },
    };
  }

  function paths(nodes: readonly unknown[]): string[] {
    const result = AnimationIR.safeParse(animationIr({ nodes, tracks: [] }));
    return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
  }

  it('accepts a prop attached to an asset instance', () => {
    const result = AnimationIR.safeParse(
      animationIr({ nodes: [instance, prop(instanceNode)], tracks: [] }),
    );
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('rejects one attached to a group, which has no rig and therefore no anchors', () => {
    // Otherwise a silent no-op: the prop draws at the origin and nothing says why.
    expect(paths([group, prop(groupNode)])).toEqual(['nodes.1.attachment']);
  });

  it('rejects one with no parent at all to attach to', () => {
    expect(paths([instance, prop(null)])).toEqual(['nodes.1.attachment']);
  });

  it('leaves the anchor name unchecked, because the rig is not in this document', () => {
    // The IR names an `AssetVersion`; the rig lives on it. That failure belongs where the
    // rig is in scope - `anchorPoint` in `@rv/anim-engine` returns a `NotFoundError`.
    const nonsense = { ...prop(instanceNode), attachment: { anchor: 'no-such-anchor' } };
    expect(
      AnimationIR.safeParse(animationIr({ nodes: [instance, nonsense], tracks: [] })).success,
    ).toBe(true);
  });

  it('is absent on an ordinary node rather than defaulted to something', () => {
    const parsed = AnimationIR.parse(animationIr({ nodes: [instance], tracks: [] }));
    expect(parsed.nodes[0]?.attachment).toBeUndefined();
  });
});
