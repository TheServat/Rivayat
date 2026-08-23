import { describe, expect, it } from 'vitest';
import type { AnimationIR, MotionStyle, NodeId } from '@rv/contracts';

import { evaluate, orderParentFirst } from './evaluate';

/** Valid ULID-shaped ids, written out so the fixtures stay readable. */
const ID = {
  anim: 'anm_01J8ZQ4E7K9M2N4P6R8T0V2W4X',
  root: 'nod_01J8ZQ4E7K9M2N4P6R8T0V2W40',
  child: 'nod_01J8ZQ4E7K9M2N4P6R8T0V2W41',
  grandchild: 'nod_01J8ZQ4E7K9M2N4P6R8T0V2W42',
  sibling: 'nod_01J8ZQ4E7K9M2N4P6R8T0V2W43',
  track: 'trk_01J8ZQ4E7K9M2N4P6R8T0V2W4X',
  track2: 'trk_01J8ZQ4E7K9M2N4P6R8T0V2W4Y',
  behaviour: 'bhv_01J8ZQ4E7K9M2N4P6R8T0V2W4X',
} as const;

function node(id: string, parentId: string | null, extra: Record<string, unknown> = {}): unknown {
  return {
    kind: 'group',
    id,
    name: 'n',
    parentId,
    transform: {
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: { x: 1, y: 1 },
      skew: { x: 0, y: 0 },
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    visible: true,
    depth: 0,
    ...extra,
  };
}

function ir(overrides: Record<string, unknown> = {}): AnimationIR {
  return {
    irVersion: 1,
    id: ID.anim,
    name: 'test',
    fps: 24,
    durationMs: 2000,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 7,
    nodes: [node(ID.root, null)],
    tracks: [],
    behaviours: [],
    markers: [],
    ...overrides,
  } as unknown as AnimationIR;
}

const MOTION: Pick<MotionStyle, 'stepMode' | 'easings' | 'tempo'> = {
  stepMode: 'smooth',
  easings: [{ name: 'linear', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } }],
  tempo: 1,
};

function findNode(snapshot: ReturnType<typeof evaluate>, id: string) {
  const found = snapshot.nodes.find((n) => n.nodeId === id);
  if (found === undefined) throw new Error(`node ${id} not in snapshot`);
  return found;
}

describe('purity - the contract of the whole engine', () => {
  const document = ir({
    nodes: [node(ID.root, null), node(ID.child, ID.root)],
    tracks: [
      {
        id: ID.track,
        nodeId: ID.child,
        channel: 'rotation',
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 2000, value: 90 },
        ],
        before: 'hold',
        after: 'hold',
        additive: false,
      },
    ],
    behaviours: [
      {
        id: ID.behaviour,
        kind: 'wind',
        nodeId: ID.child,
        enabled: true,
        seed: 3,
        weight: 1,
        hz: 0.3,
        amplitude: 0.25,
        gustiness: 0.4,
        direction: 0,
        tipBias: 0.7,
      },
    ],
  });

  it('returns byte-identical output for the same time', () => {
    expect(evaluate(document, 731)).toEqual(evaluate(document, 731));
  });

  it('agrees whether the time was scrubbed to, played to, or seeked cold', () => {
    // Scrubbing, playback, a resumed render and a sharded render must all produce the
    // same frame. Every one of those is this single property.
    const cold = evaluate(document, 731);

    for (let ms = 0; ms <= 2000; ms += 17) evaluate(document, ms);
    const afterForwards = evaluate(document, 731);

    for (let ms = 2000; ms >= 0; ms -= 17) evaluate(document, ms);
    const afterBackwards = evaluate(document, 731);

    expect(afterForwards).toEqual(cold);
    expect(afterBackwards).toEqual(cold);
  });

  it('does not mutate the IR it was given', () => {
    const before = structuredClone(document);
    evaluate(document, 500);
    evaluate(document, 1500);
    expect(document).toEqual(before);
  });
});

describe('the snapshot', () => {
  it('reports the time and the frame index', () => {
    const snapshot = evaluate(ir(), 1000);
    expect(snapshot.timeMs).toBe(1000);
    expect(snapshot.frame).toBe(24);
  });

  it('emits one resolved node per node', () => {
    const snapshot = evaluate(ir({ nodes: [node(ID.root, null), node(ID.child, ID.root)] }), 0);
    expect(snapshot.nodes).toHaveLength(2);
  });

  it('marks a fully transparent node invisible, so the renderer can skip it', () => {
    const transparent = ir({
      nodes: [
        node(ID.root, null, {
          transform: {
            position: { x: 0, y: 0 },
            rotation: 0,
            scale: { x: 1, y: 1 },
            skew: { x: 0, y: 0 },
            anchor: { x: 0.5, y: 0.5 },
            opacity: 0,
          },
        }),
      ],
    });
    expect(findNode(evaluate(transparent, 0), ID.root).visible).toBe(false);
  });

  it('respects an explicitly hidden node', () => {
    const hidden = ir({ nodes: [node(ID.root, null, { visible: false })] });
    expect(findNode(evaluate(hidden, 0), ID.root).visible).toBe(false);
  });
});

describe('hierarchy', () => {
  it('orders parents before children, preserving sibling order', () => {
    const nodes = [
      node(ID.grandchild, ID.child),
      node(ID.sibling, ID.root),
      node(ID.root, null),
      node(ID.child, ID.root),
    ] as never[];
    const ordered = orderParentFirst(nodes).map((n) => n.id);
    expect(ordered.indexOf(ID.root as NodeId)).toBeLessThan(ordered.indexOf(ID.child));
    expect(ordered.indexOf(ID.child as NodeId)).toBeLessThan(ordered.indexOf(ID.grandchild));
    // Siblings keep their authored order, because that order is the paint order.
    expect(ordered.indexOf(ID.sibling as NodeId)).toBeLessThan(ordered.indexOf(ID.child));
  });

  it('composes a child transform through its parent', () => {
    const document = ir({
      nodes: [
        node(ID.root, null, {
          transform: {
            position: { x: 100, y: 0 },
            rotation: 90,
            scale: { x: 1, y: 1 },
            skew: { x: 0, y: 0 },
            anchor: { x: 0.5, y: 0.5 },
            opacity: 1,
          },
        }),
        node(ID.child, ID.root, {
          transform: {
            position: { x: 10, y: 0 },
            rotation: 0,
            scale: { x: 1, y: 1 },
            skew: { x: 0, y: 0 },
            anchor: { x: 0.5, y: 0.5 },
            opacity: 1,
          },
        }),
      ],
    });
    const child = findNode(evaluate(document, 0), ID.child);
    expect(child.worldTransform.position.x).toBeCloseTo(100, 9);
    expect(child.worldTransform.position.y).toBeCloseTo(10, 9);
    expect(child.worldTransform.rotation).toBe(90);
  });

  it('multiplies opacity down the tree', () => {
    const half = {
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: { x: 1, y: 1 },
      skew: { x: 0, y: 0 },
      anchor: { x: 0.5, y: 0.5 },
      opacity: 0.5,
    };
    const document = ir({
      nodes: [
        node(ID.root, null, { transform: half }),
        node(ID.child, ID.root, { transform: half }),
      ],
    });
    expect(findNode(evaluate(document, 0), ID.child).worldTransform.opacity).toBe(0.25);
  });
});

describe('tracks versus behaviours', () => {
  function withTrack(additive: boolean): AnimationIR {
    return ir({
      nodes: [node(ID.root, null)],
      tracks: [
        {
          id: ID.track,
          nodeId: ID.root,
          channel: 'rotation',
          keyframes: [{ timeMs: 0, value: 45 }],
          before: 'hold',
          after: 'hold',
          additive,
        },
      ],
      behaviours: [
        {
          id: ID.behaviour,
          kind: 'sway',
          nodeId: ID.root,
          enabled: true,
          seed: 1,
          weight: 1,
          hz: 0.5,
          amplitudeDeg: 10,
          axis: 'rotation',
        },
      ],
    });
  }

  it('a plain track replaces the behaviour - a keyframe is a deliberate statement', () => {
    expect(findNode(evaluate(withTrack(false), 700), ID.root).worldTransform.rotation).toBe(45);
  });

  it('an additive track layers on top of the behaviour instead', () => {
    const rotation = findNode(evaluate(withTrack(true), 700), ID.root).worldTransform.rotation;
    expect(rotation).not.toBe(45);
    expect(Math.abs(rotation - 45)).toBeGreaterThan(0);
  });

  it('several behaviours on one channel all contribute', () => {
    // A tree that both sways and boils should do both, not pick a winner.
    const both = ir({
      behaviours: [
        {
          id: ID.behaviour,
          kind: 'sway',
          nodeId: ID.root,
          enabled: true,
          seed: 1,
          weight: 1,
          hz: 0.5,
          amplitudeDeg: 10,
          axis: 'rotation',
        },
        {
          id: 'bhv_01J8ZQ4E7K9M2N4P6R8T0V2W4Y',
          kind: 'boil',
          nodeId: ID.root,
          enabled: true,
          seed: 2,
          weight: 1,
          amplitude: 0.5,
          hz: 8,
        },
      ],
    });
    const onlySway = ir({
      behaviours: [
        {
          id: ID.behaviour,
          kind: 'sway',
          nodeId: ID.root,
          enabled: true,
          seed: 1,
          weight: 1,
          hz: 0.5,
          amplitudeDeg: 10,
          axis: 'rotation',
        },
      ],
    });
    expect(findNode(evaluate(both, 700), ID.root).worldTransform.rotation).not.toBe(
      findNode(evaluate(onlySway, 700), ID.root).worldTransform.rotation,
    );
  });

  it('treats scale as a multiplier and position as an offset', () => {
    const scaled = ir({
      nodes: [
        node(ID.root, null, {
          transform: {
            position: { x: 10, y: 0 },
            rotation: 0,
            scale: { x: 2, y: 1 },
            skew: { x: 0, y: 0 },
            anchor: { x: 0.5, y: 0.5 },
            opacity: 1,
          },
        }),
      ],
      tracks: [
        {
          id: ID.track,
          nodeId: ID.root,
          channel: 'scale.x',
          keyframes: [{ timeMs: 0, value: 0.5 }],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
        {
          id: ID.track2,
          nodeId: ID.root,
          channel: 'position.x',
          keyframes: [{ timeMs: 0, value: 5 }],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
      ],
    });
    const resolved = findNode(evaluate(scaled, 0), ID.root).worldTransform;
    // scale multiplies: 2 * (1 + 0.5) = 3. position offsets: 10 + 5 = 15.
    expect(resolved.scale.x).toBe(3);
    expect(resolved.position.x).toBe(15);
  });

  it('starts an additive track from zero on a channel no behaviour touched', () => {
    const document = ir({
      tracks: [
        {
          id: ID.track,
          nodeId: ID.root,
          channel: 'position.x',
          keyframes: [{ timeMs: 0, value: 12 }],
          before: 'hold',
          after: 'hold',
          additive: true,
        },
      ],
    });
    expect(findNode(evaluate(document, 0), ID.root).worldTransform.position.x).toBe(12);
  });

  it('clamps a negative opacity to zero, not to a negative alpha', () => {
    const document = ir({
      tracks: [
        {
          id: ID.track,
          nodeId: ID.root,
          channel: 'opacity',
          keyframes: [{ timeMs: 0, value: -3 }],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
      ],
    });
    expect(findNode(evaluate(document, 0), ID.root).worldTransform.opacity).toBe(0);
  });

  it('clamps an anchor driven outside its own bounds', () => {
    const document = ir({
      tracks: [
        {
          id: ID.track,
          nodeId: ID.root,
          channel: 'anchor.x',
          keyframes: [{ timeMs: 0, value: -9 }],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
        {
          id: ID.track2,
          nodeId: ID.root,
          channel: 'anchor.y',
          keyframes: [{ timeMs: 0, value: 9 }],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
      ],
    });
    const anchor = findNode(evaluate(document, 0), ID.root).worldTransform.anchor;
    expect(anchor).toEqual({ x: 0, y: 1 });
  });

  it('clamps opacity into range rather than emitting a nonsense value', () => {
    const overdriven = ir({
      tracks: [
        {
          id: ID.track,
          nodeId: ID.root,
          channel: 'opacity',
          keyframes: [{ timeMs: 0, value: 5 }],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
      ],
    });
    expect(findNode(evaluate(overdriven, 0), ID.root).worldTransform.opacity).toBe(1);
  });
});

describe('camera', () => {
  it('defaults to the origin at unit zoom when no camera track exists', () => {
    expect(evaluate(ir(), 0).camera).toEqual({ position: { x: 0, y: 0 }, zoom: 1, rotation: 0 });
  });

  it('holds before the first and after the last keyframe', () => {
    const document = ir({
      camera: {
        keyframes: [
          { timeMs: 500, position: { x: 10, y: 0 }, zoom: 1, rotation: 0 },
          { timeMs: 1500, position: { x: 30, y: 0 }, zoom: 2, rotation: 0 },
        ],
        shakeAmplitude: 0,
        shakeSeed: 0,
      },
    });
    expect(evaluate(document, 0).camera.position.x).toBe(10);
    expect(evaluate(document, 9999).camera.position.x).toBe(30);
  });

  it('interpolates between keyframes', () => {
    const document = ir({
      camera: {
        keyframes: [
          { timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
          { timeMs: 1000, position: { x: 100, y: 50 }, zoom: 3, rotation: 20 },
        ],
        shakeAmplitude: 0,
        shakeSeed: 0,
      },
    });
    const camera = evaluate(document, 500).camera;
    expect(camera.position.x).toBeCloseTo(50, 9);
    expect(camera.position.y).toBeCloseTo(25, 9);
    expect(camera.zoom).toBeCloseTo(2, 9);
    expect(camera.rotation).toBeCloseTo(10, 9);
  });

  it('picks the right segment when there are more than two keyframes', () => {
    const document = ir({
      camera: {
        keyframes: [
          { timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
          { timeMs: 1000, position: { x: 100, y: 0 }, zoom: 1, rotation: 0 },
          { timeMs: 2000, position: { x: 300, y: 0 }, zoom: 1, rotation: 0 },
        ],
        shakeAmplitude: 0,
        shakeSeed: 0,
      },
    });
    expect(evaluate(document, 500).camera.position.x).toBeCloseTo(50, 9);
    // Inside the second segment, which is where the scan has to advance past index 0.
    expect(evaluate(document, 1500).camera.position.x).toBeCloseTo(200, 9);
  });

  it('does not divide by zero when two camera keyframes share a time', () => {
    const document = ir({
      camera: {
        keyframes: [
          { timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
          { timeMs: 1000, position: { x: 10, y: 0 }, zoom: 1, rotation: 0 },
          { timeMs: 1000, position: { x: 90, y: 0 }, zoom: 1, rotation: 0 },
          { timeMs: 2000, position: { x: 100, y: 0 }, zoom: 1, rotation: 0 },
        ],
        shakeAmplitude: 0,
        shakeSeed: 0,
      },
    });
    // A hard cut is a legal camera move; it must not produce NaN.
    const camera = evaluate(document, 1000).camera;
    expect(Number.isFinite(camera.position.x)).toBe(true);
  });

  it('handles a single-keyframe camera', () => {
    const document = ir({
      camera: { keyframes: [{ timeMs: 0, position: { x: 7, y: 8 }, zoom: 1.5, rotation: 3 }] },
    });
    expect(evaluate(document, 5000).camera).toMatchObject({ zoom: 1.5, rotation: 3 });
  });

  it('shakes deterministically - a re-render of the same explosion shakes identically', () => {
    const document = ir({
      camera: {
        keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
        shakeAmplitude: 0.5,
        shakeSeed: 99,
      },
    });
    expect(evaluate(document, 400).camera).toEqual(evaluate(document, 400).camera);
    expect(evaluate(document, 400).camera.position.x).not.toBe(0);
  });
});

describe('style motion', () => {
  it('quantises time to the step cadence, so every channel steps together', () => {
    const document = ir({
      tracks: [
        {
          id: ID.track,
          nodeId: ID.root,
          channel: 'rotation',
          keyframes: [
            { timeMs: 0, value: 0 },
            { timeMs: 2000, value: 100 },
          ],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
      ],
    });

    const smooth = evaluate(document, 100, { motion: MOTION });
    const stepped = evaluate(document, 100, { motion: { ...MOTION, stepMode: 'on-2s' } });
    expect(stepped.timeMs).toBeLessThan(smooth.timeMs);
    expect(stepped.nodes[0]?.worldTransform.rotation).toBeLessThan(
      smooth.nodes[0]?.worldTransform.rotation ?? 0,
    );
  });

  it('holds a stepped frame across the whole hold, then jumps', () => {
    const document = ir({
      tracks: [
        {
          id: ID.track,
          nodeId: ID.root,
          channel: 'rotation',
          keyframes: [
            { timeMs: 0, value: 0 },
            { timeMs: 1000, value: 100 },
          ],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
      ],
    });
    const stepped = { motion: { ...MOTION, stepMode: 'on-2s' as const } };
    const frame = 1000 / 24;
    expect(evaluate(document, frame * 2.1, stepped).nodes[0]?.worldTransform.rotation).toBe(
      evaluate(document, frame * 3.9, stepped).nodes[0]?.worldTransform.rotation,
    );
    expect(evaluate(document, frame * 4.1, stepped).nodes[0]?.worldTransform.rotation).not.toBe(
      evaluate(document, frame * 3.9, stepped).nodes[0]?.worldTransform.rotation,
    );
  });

  it('scales the whole clip by tempo', () => {
    const document = ir({
      tracks: [
        {
          id: ID.track,
          nodeId: ID.root,
          channel: 'rotation',
          keyframes: [
            { timeMs: 0, value: 0 },
            { timeMs: 1000, value: 100 },
          ],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
      ],
    });
    const normal = evaluate(document, 500, { motion: MOTION });
    const double = evaluate(document, 500, { motion: { ...MOTION, tempo: 2 } });
    expect(double.nodes[0]?.worldTransform.rotation).toBeCloseTo(
      (normal.nodes[0]?.worldTransform.rotation ?? 0) * 2,
      6,
    );
  });

  it('resolves a named easing from the style bible, not from a hard-coded table', () => {
    const document = ir({
      tracks: [
        {
          id: ID.track,
          nodeId: ID.root,
          channel: 'rotation',
          keyframes: [
            { timeMs: 0, value: 0, easing: { kind: 'named', name: 'snappy' } },
            { timeMs: 1000, value: 100 },
          ],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
      ],
    });
    const snappy = {
      motion: {
        ...MOTION,
        easings: [{ name: 'snappy', p1: { x: 0.9, y: 0.1 }, p2: { x: 1, y: 1 } }],
      },
    };
    // Editing one curve in the style bible restyles every clip that names it.
    expect(evaluate(document, 500, snappy).nodes[0]?.worldTransform.rotation).toBeLessThan(50);
  });
});

describe('asset instances', () => {
  const ASSET = {
    assetId: 'ast_01J8ZQ4E7K9M2N4P6R8T0V2W4X',
    versionId: 'asv_01J8ZQ4E7K9M2N4P6R8T0V2W4X',
  };

  function instance(extra: Record<string, unknown> = {}): unknown {
    return node(ID.child, ID.root, {
      kind: 'asset-instance',
      asset: ASSET,
      clipLoop: 'loop',
      clipOffsetMs: 0,
      clipSpeed: 1,
      flipX: false,
      ...extra,
    });
  }

  it('carries a tint through to the resolved node', () => {
    const document = ir({ nodes: [node(ID.root, null), instance({ tint: '#ff8800' })] });
    expect(findNode(evaluate(document, 0), ID.child).tint).toBe('#ff8800');
  });

  it('omits tint entirely when the instance has none', () => {
    const document = ir({ nodes: [node(ID.root, null), instance()] });
    expect(findNode(evaluate(document, 0), ID.child).tint).toBeUndefined();
  });

  it('never invents a tint for a node kind that cannot carry one', () => {
    expect(findNode(evaluate(ir(), 0), ID.root).tint).toBeUndefined();
  });
});

describe('look-at, the deferred pass', () => {
  const target = node(ID.child, null, {
    transform: {
      position: { x: 0, y: 100 },
      rotation: 0,
      scale: { x: 1, y: 1 },
      skew: { x: 0, y: 0 },
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
  });

  function looker(extra: Record<string, unknown> = {}): AnimationIR {
    return ir({
      nodes: [node(ID.root, null), target],
      behaviours: [
        {
          id: ID.behaviour,
          kind: 'look-at',
          nodeId: ID.root,
          enabled: true,
          seed: 1,
          weight: 1,
          targetNodeId: ID.child,
          maxAngleDeg: 35,
          responsiveness: 1,
          ...extra,
        },
      ],
    });
  }

  it('turns towards the target once world positions are known', () => {
    expect(findNode(evaluate(looker(), 0), ID.root).worldTransform.rotation).toBeGreaterThan(0);
  });

  it('never turns further than its limit', () => {
    const rotation = findNode(evaluate(looker(), 0), ID.root).worldTransform.rotation;
    expect(Math.abs(rotation)).toBeLessThanOrEqual(35 + 1e-9);
  });

  it('scales the turn by responsiveness', () => {
    const full = findNode(evaluate(looker(), 0), ID.root).worldTransform.rotation;
    const lazy = findNode(evaluate(looker({ responsiveness: 0.25 }), 0), ID.root).worldTransform
      .rotation;
    expect(Math.abs(lazy)).toBeLessThan(Math.abs(full));
  });

  it('does nothing when disabled or outside its window', () => {
    expect(findNode(evaluate(looker({ enabled: false }), 0), ID.root).worldTransform.rotation).toBe(
      0,
    );
    expect(
      findNode(evaluate(looker({ startMs: 500, endMs: 600 }), 0), ID.root).worldTransform.rotation,
    ).toBe(0);
    expect(
      findNode(evaluate(looker({ startMs: 0, endMs: 100 }), 200), ID.root).worldTransform.rotation,
    ).toBe(0);
  });

  it('runs one pass, not to a fixed point - two nodes looking at each other must terminate', () => {
    const mutual = ir({
      nodes: [node(ID.root, null), target],
      behaviours: [
        {
          id: ID.behaviour,
          kind: 'look-at',
          nodeId: ID.root,
          enabled: true,
          seed: 1,
          weight: 1,
          targetNodeId: ID.child,
          maxAngleDeg: 35,
          responsiveness: 1,
        },
        {
          id: 'bhv_01J8ZQ4E7K9M2N4P6R8T0V2W4Y',
          kind: 'look-at',
          nodeId: ID.child,
          enabled: true,
          seed: 2,
          weight: 1,
          targetNodeId: ID.root,
          maxAngleDeg: 35,
          responsiveness: 1,
        },
      ],
    });
    expect(() => evaluate(mutual, 0)).not.toThrow();
    expect(evaluate(mutual, 0)).toEqual(evaluate(mutual, 0));
  });
});
