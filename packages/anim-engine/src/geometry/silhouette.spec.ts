import { describe, expect, it } from 'vitest';
import type { AnimationIR, Transform2D } from '@rv/contracts';
import { FORMAT_PRESETS } from '@rv/contracts';

import { polygonArea, signedDistanceToConvex } from './polygon';
import {
  DEFAULT_ELLIPSE_SEGMENTS,
  extentsFromIr,
  seamToleranceScenePx,
  silhouetteOf,
  type NodeExtent,
} from './silhouette';

function pose(overrides: Partial<Transform2D> = {}): Transform2D {
  return {
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    skew: { x: 0, y: 0 },
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
    ...overrides,
  };
}

const RECT_100: NodeExtent = { width: 100, height: 100, shape: 'rect' };
const ELLIPSE_100: NodeExtent = { width: 100, height: 100, shape: 'ellipse' };

describe('silhouetteOf', () => {
  it('places the artwork where the anchor says it goes, not where the origin is', () => {
    const bottomCentre = silhouetteOf(pose({ anchor: { x: 0.5, y: 1 } }), RECT_100);
    const ys = bottomCentre.map((vertex) => vertex.y);
    // Anchored at its bottom edge, the box hangs entirely above the node's own origin.
    expect(Math.max(...ys)).toBeCloseTo(0, 9);
    expect(Math.min(...ys)).toBeCloseTo(-100, 9);
  });

  it('keeps a rigid part the same size however it is rotated', () => {
    const upright = polygonArea(silhouetteOf(pose(), RECT_100));
    const turned = polygonArea(silhouetteOf(pose({ rotation: 37 }), RECT_100));
    expect(turned).toBeCloseTo(upright, 6);
  });

  it('scales area with the product of the two scale factors', () => {
    const doubled = polygonArea(silhouetteOf(pose({ scale: { x: 2, y: 3 } }), RECT_100));
    expect(doubled).toBeCloseTo(100 * 100 * 6, 6);
  });

  it('measures an ellipse as an ellipse, not as the box that contains it', () => {
    const asEllipse = polygonArea(silhouetteOf(pose(), ELLIPSE_100));
    const asRect = polygonArea(silhouetteOf(pose(), RECT_100));
    // pi/4 of the box, give or take the polygon overshoot.
    expect(asEllipse / asRect).toBeGreaterThan(0.78);
    expect(asEllipse / asRect).toBeLessThan(0.8);
  });

  it('contains the ellipse it approximates, so a reported gap is never an artefact', () => {
    const polygon = silhouetteOf(pose(), ELLIPSE_100);
    // Every point on the true ellipse must be inside the polygon.
    for (let step = 0; step < 360; step += 1) {
      const angle = (step * Math.PI) / 180;
      const onEllipse = { x: Math.cos(angle) * 50, y: Math.sin(angle) * 50 };
      // A rounding-scale epsilon: the claim is containment, not exact arithmetic.
      expect(signedDistanceToConvex(polygon, onEllipse)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('overshoots the ellipse by less than one part in two hundred at the default fineness', () => {
    const polygon = silhouetteOf(pose(), ELLIPSE_100);
    const worst = Math.max(...polygon.map((vertex) => Math.hypot(vertex.x, vertex.y)));
    expect(worst / 50 - 1).toBeLessThan(1 / 200);
  });

  it('takes a finer approximation when asked, and a coarser one when told to', () => {
    expect(silhouetteOf(pose(), ELLIPSE_100, 8)).toHaveLength(8);
    expect(silhouetteOf(pose(), ELLIPSE_100)).toHaveLength(DEFAULT_ELLIPSE_SEGMENTS);
  });
});

function irWith(nodes: readonly unknown[]): AnimationIR {
  return {
    irVersion: 1,
    id: 'anm_01J8ZQ4E7K9M2N4P6R8T0VB99',
    name: 'sizes',
    fps: 24,
    durationMs: 1000,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 1,
    nodes,
    tracks: [],
    behaviours: [],
    markers: [],
  } as unknown as AnimationIR;
}

const BASE_TRANSFORM = pose();

describe('extentsFromIr', () => {
  it('reads a shape node its own declared size, so a self-describing IR needs no help', () => {
    const extents = extentsFromIr(
      irWith([
        {
          kind: 'shape',
          id: 'nod_01J8ZQ4E7K9M2N4P6R8T0VB01',
          name: 'a',
          parentId: null,
          transform: BASE_TRANSFORM,
          visible: true,
          depth: 0,
          shape: 'ellipse',
          strokeWidth: 0,
          size: { width: 46, height: 20 },
        },
      ]),
    );
    expect(extents.get('nod_01J8ZQ4E7K9M2N4P6R8T0VB01')).toEqual({
      width: 46,
      height: 20,
      shape: 'ellipse',
    });
  });

  it('measures a path, a line and a polygon as their box, never guessing at their outline', () => {
    const extents = extentsFromIr(
      irWith(
        (['line', 'polygon', 'path'] as const).map((shape, index) => ({
          kind: 'shape',
          id: `nod_01J8ZQ4E7K9M2N4P6R8T0VB1${String(index)}`,
          name: `s${String(index)}`,
          parentId: null,
          transform: BASE_TRANSFORM,
          visible: true,
          depth: 0,
          shape,
          strokeWidth: 0,
          size: { width: 10, height: 10 },
        })),
      ),
    );
    expect([...extents.values()].map((extent) => extent.shape)).toEqual(['rect', 'rect', 'rect']);
  });

  it('takes an emitter area as the emitter extent, because that is what it covers', () => {
    const extents = extentsFromIr(
      irWith([
        {
          kind: 'fx-emitter',
          id: 'nod_01J8ZQ4E7K9M2N4P6R8T0VB02',
          name: 'dust',
          parentId: null,
          transform: BASE_TRANSFORM,
          visible: true,
          depth: 0,
          effect: 'dust',
          rate: 10,
          area: { width: 200, height: 80 },
          seed: 1,
          intensity: 0.5,
        },
      ]),
    );
    expect(extents.get('nod_01J8ZQ4E7K9M2N4P6R8T0VB02')).toEqual({
      width: 200,
      height: 80,
      shape: 'rect',
    });
  });

  it('reports no extent rather than a guessed one for nodes whose size lives elsewhere', () => {
    const extents = extentsFromIr(
      irWith([
        {
          kind: 'group',
          id: 'nod_01J8ZQ4E7K9M2N4P6R8T0VB03',
          name: 'g',
          parentId: null,
          transform: BASE_TRANSFORM,
          visible: true,
          depth: 0,
        },
        {
          kind: 'shape',
          id: 'nod_01J8ZQ4E7K9M2N4P6R8T0VB04',
          name: 'sizeless',
          parentId: null,
          transform: BASE_TRANSFORM,
          visible: true,
          depth: 0,
          shape: 'rect',
          strokeWidth: 0,
        },
      ]),
    );
    expect(extents.size).toBe(0);
  });
});

describe('seamToleranceScenePx', () => {
  it('is one pixel of the sharpest format the project ships', () => {
    // 1920x1080 authored, delivered at 3840x2160: one output pixel is half a scene pixel.
    expect(seamToleranceScenePx({ width: 1920, height: 1080 })).toBeCloseTo(0.5, 12);
  });

  it('is set by the finest format, not by the average or the last one listed', () => {
    const coarse = { size: { width: 480, height: 270 } };
    const fine = { size: { width: 3840, height: 2160 } };
    expect(seamToleranceScenePx({ width: 1920, height: 1080 }, [coarse, fine])).toBeCloseTo(
      0.5,
      12,
    );
    expect(seamToleranceScenePx({ width: 1920, height: 1080 }, [fine, coarse])).toBeCloseTo(
      0.5,
      12,
    );
  });

  it('accounts for the crop a taller format takes out of a wide canvas', () => {
    const vertical = FORMAT_PRESETS['tiktok-9x16'];
    // 1080x1920 out of a 1920x1080 canvas crops to 607.5 scene px wide.
    expect(seamToleranceScenePx({ width: 1920, height: 1080 }, [vertical])).toBeCloseTo(
      607.5 / 1080,
      9,
    );
  });

  it('gets tighter as the authoring canvas gets smaller relative to the delivery', () => {
    const small = seamToleranceScenePx({ width: 960, height: 540 });
    const large = seamToleranceScenePx({ width: 3840, height: 2160 });
    expect(small).toBeLessThan(large);
  });

  it('refuses an empty format list instead of reporting an infinitely forgiving gate', () => {
    expect(() => seamToleranceScenePx({ width: 1920, height: 1080 }, [])).toThrow(
      /at least one delivery format/,
    );
  });
});
