/**
 * Representations, and the 2.5D loop the `parallax` behaviour has been waiting for.
 *
 * Two halves. The first is the union itself: what each kind carries, what a router does
 * when it cannot serve one, and the exhaustiveness that makes a fifth kind a compile
 * error rather than a missing bitmap.
 *
 * The second is the part that matters - closing the loop. `NodeBase.depth` has existed
 * since the IR was written and the `parallax` behaviour reads it, and until now nothing
 * in the system produced depth layers for it to read. So these tests take a layered
 * representation, derive the node depths from it, build an `AnimationIR` that places
 * them, and assert the geometry those depths actually produce - including, explicitly,
 * that reversing the depth ladder breaks the assertion. A monotonicity test that passes
 * on a reversed input is not a test.
 */

import { at } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { testIds } from '../__fixtures__/builders';
import { AnimationIR, projectScenePoint } from '../anim/ir';
import {
  AssetRepresentation,
  CutoutRepresentation,
  DEPTH_FAR_PLANE,
  DepthBand,
  FlatRepresentation,
  IMPLEMENTED_REPRESENTATION_KINDS,
  Layered25dRepresentation,
  REPRESENTATION_KINDS,
  REPRESENTATION_LABELS,
  RESERVED_REPRESENTATION_KINDS,
  VideoRepresentation,
  findRepresentation,
  layerDepth,
  layerDepths,
  representationBlobs,
  selectRepresentation,
} from './representation';

const ids = testIds();
/** A distinct, valid sha256 hex for each fixture blob. */
const HASH = (seed: string): string => {
  const digit = 'abcdef0123456789'[seed.length % 16] ?? '0';
  return `${digit.repeat(63)}${'0123456789abcdef'[seed.charCodeAt(0) % 16] ?? '0'}`;
};

// ── fixtures ────────────────────────────────────────────────────────────────

function layer(name: string, near: number, far: number): Record<string, unknown> {
  return {
    id: ids.part(),
    name,
    imageHash: HASH(name),
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    band: { near, far },
    alphaCoverage: 0.6,
  };
}

/** A five-slab painted exterior: the shape a depth pass is expected to produce. */
function forest(overrides: Record<string, unknown> = {}): Layered25dRepresentation {
  return Layered25dRepresentation.parse({
    kind: 'layered-2.5d',
    depthMapHash: HASH('depth-map'),
    estimator: 'depth-anything-v2:vits',
    canvas: { width: 1920, height: 1080 },
    layers: [
      layer('foreground-ferns', 0.0, 0.08),
      layer('character-plane', 0.18, 0.26),
      layer('near-trees', 0.36, 0.48),
      layer('far-trees', 0.6, 0.72),
      layer('sky', 0.92, 1.0),
    ],
    ...overrides,
  });
}

function flat(): FlatRepresentation {
  return FlatRepresentation.parse({
    kind: 'flat',
    imageHash: HASH('flat'),
    size: { width: 512, height: 512 },
  });
}

function cutout(rigId = ids.rig(), partIds = [ids.part()]): CutoutRepresentation {
  return CutoutRepresentation.parse({ kind: 'cutout', rigId, partIds });
}

function video(): VideoRepresentation {
  return VideoRepresentation.parse({
    kind: 'video',
    videoHash: HASH('video'),
    size: { width: 1080, height: 1920 },
    fps: 24,
    durationMs: 1000,
  });
}

// ── the vocabulary ──────────────────────────────────────────────────────────

describe('the representation vocabulary', () => {
  it('names every kind the union implements, plus the two held in reserve', () => {
    expect([...IMPLEMENTED_REPRESENTATION_KINDS, ...RESERVED_REPRESENTATION_KINDS].sort()).toEqual(
      [...REPRESENTATION_KINDS].sort(),
    );
    expect(RESERVED_REPRESENTATION_KINDS).toEqual(['isometric', 'mesh']);
  });

  it('derives the implemented list from the union, so the two cannot drift', () => {
    expect([...IMPLEMENTED_REPRESENTATION_KINDS].sort()).toEqual(
      AssetRepresentation.options.map((option) => option.shape.kind.value).sort(),
    );
  });

  it('refuses to parse a reserved kind, so nothing can claim to serve one yet', () => {
    expect(AssetRepresentation.safeParse({ kind: 'mesh' }).success).toBe(false);
    expect(AssetRepresentation.safeParse({ kind: 'isometric' }).success).toBe(false);
  });

  it('has a sentence for every kind, reserved ones included', () => {
    for (const kind of REPRESENTATION_KINDS) {
      expect(REPRESENTATION_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('the blobs a representation needs before it can be drawn', () => {
  it('asks for the image, the layers and the depth map, or the footage', () => {
    expect(representationBlobs(flat())).toEqual([HASH('flat')]);
    expect(representationBlobs(video())).toEqual([HASH('video')]);

    const stack = forest();
    expect(representationBlobs(stack)).toEqual([
      stack.depthMapHash,
      ...stack.layers.map((each) => each.imageHash),
    ]);
  });

  it('asks for nothing for a cutout, whose pixels are already the version’s parts', () => {
    expect(representationBlobs(cutout())).toEqual([]);
  });

  it('refuses an unknown kind loudly rather than returning an empty prefetch list', () => {
    const rogue = { kind: 'holograph' } as unknown as AssetRepresentation;
    expect(() => representationBlobs(rogue)).toThrow(/holograph/);
  });
});

// ── routing ─────────────────────────────────────────────────────────────────

describe('routing to a representation an adapter can actually serve', () => {
  const available: readonly AssetRepresentation[] = [flat(), cutout(), forest()];

  it('takes the first preference that is both present and servable', () => {
    const chosen = selectRepresentation(
      available,
      ['layered-2.5d', 'cutout', 'flat'],
      new Set(['layered-2.5d', 'flat']),
    );
    expect(chosen?.kind).toBe('layered-2.5d');
  });

  it('routes around a preference the adapter declared it cannot serve', () => {
    const chosen = selectRepresentation(
      available,
      ['layered-2.5d', 'cutout', 'flat'],
      new Set(['cutout', 'flat']),
    );
    expect(chosen?.kind).toBe('cutout');
  });

  it('routes around a preference the asset does not carry', () => {
    const chosen = selectRepresentation(available, ['video', 'flat'], new Set(['video', 'flat']));
    expect(chosen?.kind).toBe('flat');
  });

  it('returns nothing rather than substituting something nobody asked for', () => {
    expect(selectRepresentation(available, ['video'], new Set(['video']))).toBeNull();
    expect(selectRepresentation(available, ['flat'], new Set())).toBeNull();
  });

  it('finds a kind directly, and says so when it is absent', () => {
    expect(findRepresentation(available, 'flat')?.kind).toBe('flat');
    expect(findRepresentation(available, 'video')).toBeNull();
  });
});

// ── the 2.5D payload ────────────────────────────────────────────────────────

describe('a depth band', () => {
  it('rejects a band that ends nearer the camera than it starts', () => {
    expect(DepthBand.safeParse({ near: 0.6, far: 0.2 }).success).toBe(false);
    expect(DepthBand.safeParse({ near: 0.2, far: 0.2 }).success).toBe(true);
  });
});

describe('a layered 2.5D representation', () => {
  it('rejects a stack of one, which is a flat image with extra steps', () => {
    const single = Layered25dRepresentation.safeParse({
      kind: 'layered-2.5d',
      depthMapHash: HASH('depth-map'),
      estimator: 'x',
      canvas: { width: 8, height: 8 },
      layers: [layer('only', 0, 1)],
    });
    expect(single.success).toBe(false);
  });

  it('rejects layers that are not ordered near to far, because paint order is derived from that order', () => {
    const scrambled = Layered25dRepresentation.safeParse({
      kind: 'layered-2.5d',
      depthMapHash: HASH('depth-map'),
      estimator: 'x',
      canvas: { width: 8, height: 8 },
      layers: [layer('sky', 0.9, 1), layer('ferns', 0, 0.1)],
    });
    expect(scrambled.success).toBe(false);
    expect(scrambled.error?.issues.at(0)?.path).toEqual(['layers', 1, 'band']);
  });

  it('rejects two layers on the same plane, which have no defined order', () => {
    const tied = Layered25dRepresentation.safeParse({
      kind: 'layered-2.5d',
      depthMapHash: HASH('depth-map'),
      estimator: 'x',
      canvas: { width: 8, height: 8 },
      layers: [layer('a', 0.4, 0.6), layer('b', 0.4, 0.6)],
    });
    expect(tied.success).toBe(false);
  });

  it('rejects two layers with the same name, which a compiler could not tell apart', () => {
    const duplicated = Layered25dRepresentation.safeParse({
      kind: 'layered-2.5d',
      depthMapHash: HASH('depth-map'),
      estimator: 'x',
      canvas: { width: 8, height: 8 },
      layers: [layer('trees', 0, 0.1), layer('trees', 0.5, 0.6)],
    });
    expect(duplicated.success).toBe(false);
    expect(duplicated.error?.issues.some((issue) => issue.message.includes('duplicate'))).toBe(
      true,
    );
  });

  it('defaults the depth scale to the far plane the parallax behaviour normalises against', () => {
    expect(forest().depthScale).toBe(DEPTH_FAR_PLANE);
  });

  it('records whether the holes behind a layer were filled, because a camera move reveals them', () => {
    expect(forest().layers.every((each) => each.inpainted === false)).toBe(true);
  });
});

// ── the loop: representation → node depth → screen geometry ─────────────────

/**
 * Element-wise, to a tolerance well under a scene unit.
 *
 * Band centres are averages of decimal fractions, so `(0.6 + 0.72) / 2 * 100` is
 * 65.99999999999999 and not 66. Exact equality here would be asserting the shape of
 * IEEE-754 rather than the shape of the depth ladder, and one re-authored fixture band
 * would break it for no reason worth anyone's time.
 */
function expectDepths(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(at(expected, index), 9);
  });
}

describe('a layered representation produces the depths the IR consumes', () => {
  const stack = forest();
  const depths = layerDepths(stack);

  it('places each layer at the centre of the band it was cut from, on the scene depth scale', () => {
    expectDepths(depths, [4, 22, 42, 66, 96]);
    expect(layerDepth(at(stack.layers, 0), 100)).toBe(4);
  });

  it('is strictly increasing from the nearest layer to the furthest', () => {
    for (const [index, depth] of depths.entries()) {
      const previous = depths[index - 1];
      if (previous !== undefined) expect(depth).toBeGreaterThan(previous);
    }
  });

  it('stays inside the range the parallax behaviour is defined over', () => {
    for (const depth of depths) {
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(DEPTH_FAR_PLANE);
    }
  });

  it('honours a shallower stack without rescaling a single band', () => {
    const interior = layerDepths(forest({ depthScale: 25 }));
    expectDepths(interior, [1, 5.5, 10.5, 16.5, 24]);
    // Same ladder, quarter the range: the *relationships* are what the depth map decided.
    expectDepths(
      interior.map((each) => each * 4),
      [...depths],
    );
  });
});

describe('an IR built from a layered representation', () => {
  /**
   * The compile step, written out rather than imported.
   *
   * The real compiler lives in an engine; what belongs here is proof that the shape a
   * compiler would produce is one the IR accepts and one the renderer's paint rule
   * orders correctly. Every number in it comes from the representation.
   */
  function irFor(rep: Layered25dRepresentation): AnimationIR {
    const local = testIds();
    const root = local.node();
    const depths = layerDepths(rep);
    const nodes = rep.layers.map((each, index) => ({
      kind: 'shape' as const,
      id: local.node(),
      name: each.name,
      parentId: root,
      depth: depths[index],
      shape: 'rect' as const,
      size: { width: rep.canvas.width, height: rep.canvas.height },
      transform: { position: { x: 0, y: 0 } },
    }));

    return AnimationIR.parse({
      irVersion: 1,
      id: local.animation(),
      name: 'forest push-in',
      fps: 24,
      durationMs: 3000,
      sceneSpace: rep.canvas,
      seed: 11,
      nodes: [{ kind: 'group', id: root, name: 'stack', parentId: null, depth: 0 }, ...nodes],
      behaviours: nodes.map((node) => ({
        id: local.behaviour(),
        nodeId: node.id,
        kind: 'parallax',
        seed: 3,
        strength: 1,
        curve: 'linear',
      })),
      camera: {
        keyframes: [
          { timeMs: 0, position: { x: -400, y: 0 } },
          { timeMs: 3000, position: { x: 400, y: 0 } },
        ],
      },
    });
  }

  it('parses, and gives every layer a parallax behaviour to consume its depth', () => {
    const ir = irFor(stackFixture());
    expect(ir.behaviours).toHaveLength(5);
    expect(ir.behaviours.every((each) => each.kind === 'parallax')).toBe(true);
    for (const behaviour of ir.behaviours) {
      const node = ir.nodes.find((each) => each.id === behaviour.nodeId);
      expect(node?.depth).toBeGreaterThan(0);
    }
  });

  it('paints far layers first under the renderer’s documented rule, depth descending', () => {
    const ir = irFor(stackFixture());
    const painted = ir.nodes
      .filter((node) => node.kind === 'shape')
      .slice()
      .sort((left, right) => right.depth - left.depth)
      .map((node) => node.name);
    expect(painted).toEqual([
      'sky',
      'far-trees',
      'near-trees',
      'character-plane',
      'foreground-ferns',
    ]);
  });
});

function stackFixture(): Layered25dRepresentation {
  return forest();
}

// ── the loop: depth actually separates the layers on screen ─────────────────

describe('depth separates the layers, and reversing it breaks the separation', () => {
  const stack = forest();
  const depths = layerDepths(stack);

  /** Vertical screen offset a layer gets from its depth alone, under isometric. */
  function lift(depth: number): number {
    const at = projectScenePoint('isometric', { x: 0, y: 0 }, depth);
    const flatPlane = projectScenePoint('isometric', { x: 0, y: 0 }, 0);
    return flatPlane.y - at.y;
  }

  it('lifts a further layer further, monotonically, with no two layers coincident', () => {
    const lifts = depths.map(lift);
    expectDepths(lifts, [4, 22, 42, 66, 96]);
    for (const [index, value] of lifts.entries()) {
      const previous = lifts[index - 1];
      if (previous !== undefined) expect(value).toBeGreaterThan(previous);
    }
    expect(new Set(lifts).size).toBe(lifts.length);
  });

  it('fails on a reversed ladder, which is what makes the test above worth having', () => {
    const reversed = [...depths].reverse().map(lift);
    const monotonic = reversed.every((value, index) => {
      const previous = reversed[index - 1];
      return previous === undefined || value > previous;
    });
    expect(monotonic).toBe(false);
  });

  it('separates nothing under an orthographic projection, which is why parallax is a behaviour', () => {
    // Depth alone does not move a node in 2D; it sorts. The *camera* is what turns
    // depth into displacement, via the `parallax` behaviour in `@rv/anim-engine` -
    // which is the consumer this whole representation exists to feed.
    expect(
      depths.map((depth) => projectScenePoint('orthographic', { x: 10, y: 20 }, depth)),
    ).toEqual(depths.map(() => ({ x: 10, y: 20 })));
  });
});
