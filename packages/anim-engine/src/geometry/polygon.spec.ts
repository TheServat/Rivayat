import { describe, expect, it } from 'vitest';

import {
  convexSeparation,
  excursionBeyondRect,
  intersectConvex,
  polygonArea,
  signedDistanceToConvex,
  type ConvexPolygon,
} from './polygon';

const UNIT_SQUARE: ConvexPolygon = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/** Same square, wound the other way. Producers emit both under a negative scale. */
const UNIT_SQUARE_REVERSED: ConvexPolygon = [...UNIT_SQUARE].reverse();

function box(x: number, y: number, width: number, height: number): ConvexPolygon {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

describe('polygonArea', () => {
  it('measures the enclosed area regardless of which way the vertices wind', () => {
    expect(polygonArea(UNIT_SQUARE)).toBeCloseTo(1, 12);
    expect(polygonArea(UNIT_SQUARE_REVERSED)).toBeCloseTo(1, 12);
  });

  it('reports zero for a shape that encloses nothing, so an empty intersection is not area', () => {
    expect(polygonArea([])).toBe(0);
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toBe(0);
  });
});

describe('intersectConvex', () => {
  it('returns the shared region, and its area is symmetric in the two operands', () => {
    const overlap = intersectConvex(UNIT_SQUARE, box(0.5, 0.5, 1, 1));
    const mirrored = intersectConvex(box(0.5, 0.5, 1, 1), UNIT_SQUARE);
    expect(polygonArea(overlap)).toBeCloseTo(0.25, 12);
    expect(polygonArea(mirrored)).toBeCloseTo(0.25, 12);
  });

  it('gives the same answer whichever way the clipper is wound', () => {
    const clockwise = intersectConvex(box(0.5, 0.5, 1, 1), UNIT_SQUARE);
    const anticlockwise = intersectConvex(box(0.5, 0.5, 1, 1), UNIT_SQUARE_REVERSED);
    expect(polygonArea(clockwise)).toBeCloseTo(polygonArea(anticlockwise), 12);
  });

  it('returns nothing when the shapes are disjoint, rather than a sliver of one of them', () => {
    expect(intersectConvex(UNIT_SQUARE, box(5, 5, 1, 1))).toHaveLength(0);
  });

  it('returns the contained shape whole when one lies entirely inside the other', () => {
    const inner = box(0.25, 0.25, 0.5, 0.5);
    expect(polygonArea(intersectConvex(inner, UNIT_SQUARE))).toBeCloseTo(0.25, 12);
  });

  it('treats a degenerate operand as enclosing nothing rather than clipping against a line', () => {
    expect(intersectConvex([{ x: 0, y: 0 }], UNIT_SQUARE)).toHaveLength(0);
    expect(intersectConvex(UNIT_SQUARE, [{ x: 0, y: 0 }])).toHaveLength(0);
  });

  it('shares no area with a clipper that has collapsed to nothing', () => {
    const collapsed: ConvexPolygon = [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ];
    expect(intersectConvex(UNIT_SQUARE, collapsed)).toHaveLength(0);
  });
});

describe('convexSeparation', () => {
  it('is zero exactly when two shapes share a point, including when they merely touch', () => {
    expect(convexSeparation(UNIT_SQUARE, box(0.5, 0, 1, 1))).toBe(0);
    expect(convexSeparation(UNIT_SQUARE, box(1, 0, 1, 1))).toBe(0);
  });

  it('measures the gap along the axis that separates them', () => {
    expect(convexSeparation(UNIT_SQUARE, box(4, 0, 1, 1))).toBeCloseTo(3, 12);
    expect(convexSeparation(box(4, 0, 1, 1), UNIT_SQUARE)).toBeCloseTo(3, 12);
  });

  it('never overstates the gap, so a reported seam is a floor and not a boast', () => {
    // Diagonally offset: the true distance is 3*sqrt(2) ~ 4.24, attained along a
    // vertex-to-vertex direction that is nobody's edge normal.
    const reported = convexSeparation(UNIT_SQUARE, box(4, 4, 1, 1));
    expect(reported).toBeGreaterThan(0);
    expect(reported).toBeLessThanOrEqual(3 * Math.SQRT2);
  });

  it('still separates a shape collapsed to a point, using the surviving axes', () => {
    const collapsed: ConvexPolygon = [
      { x: 9, y: 9 },
      { x: 9, y: 9 },
      { x: 9, y: 9 },
    ];
    expect(convexSeparation(collapsed, UNIT_SQUARE)).toBeCloseTo(8, 12);
    expect(convexSeparation(collapsed, box(8, 8, 4, 4))).toBe(0);
  });

  it('answers zero when there is no shape to separate from', () => {
    expect(convexSeparation(UNIT_SQUARE, [])).toBe(0);
  });
});

describe('signedDistanceToConvex', () => {
  it('is negative inside and positive outside, which is what tells a joint from a gap', () => {
    expect(signedDistanceToConvex(UNIT_SQUARE, { x: 0.5, y: 0.5 })).toBeCloseTo(-0.5, 12);
    expect(signedDistanceToConvex(UNIT_SQUARE, { x: 3, y: 0.5 })).toBeCloseTo(2, 12);
  });

  it('agrees on the sign whichever way the polygon is wound', () => {
    expect(signedDistanceToConvex(UNIT_SQUARE_REVERSED, { x: 0.5, y: 0.5 })).toBeCloseTo(-0.5, 12);
    expect(signedDistanceToConvex(UNIT_SQUARE_REVERSED, { x: 3, y: 0.5 })).toBeCloseTo(2, 12);
  });

  it('is zero on the boundary, so a pivot placed exactly on an edge is not called outside', () => {
    expect(signedDistanceToConvex(UNIT_SQUARE, { x: 1, y: 0.5 })).toBeCloseTo(0, 12);
  });

  it('measures to the nearest corner when the point is off the end of every edge', () => {
    expect(signedDistanceToConvex(UNIT_SQUARE, { x: 4, y: 5 })).toBeCloseTo(5, 12);
  });

  it('reports an infinite distance from a shape with no interior, never a false containment', () => {
    expect(signedDistanceToConvex([{ x: 0, y: 0 }], { x: 0, y: 0 })).toBe(Infinity);
  });

  it('never places a point inside a shape that has collapsed to nothing', () => {
    const collapsed: ConvexPolygon = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    expect(signedDistanceToConvex(collapsed, { x: 3, y: 4 })).toBeCloseTo(5, 12);
    expect(signedDistanceToConvex(collapsed, { x: 0, y: 0 })).toBeCloseTo(0, 12);
  });
});

describe('excursionBeyondRect', () => {
  const frame = { x: 0, y: 0, width: 10, height: 10 };

  it('is zero for a shape wholly inside the rectangle', () => {
    expect(excursionBeyondRect(box(2, 2, 3, 3), frame)).toBe(0);
  });

  it('reports how far the worst vertex reaches past whichever edge it crossed', () => {
    expect(excursionBeyondRect(box(-4, 2, 3, 3), frame)).toBeCloseTo(4, 12);
    expect(excursionBeyondRect(box(2, 2, 3, 15), frame)).toBeCloseTo(7, 12);
  });

  it('is zero for an empty shape rather than an arbitrary large number', () => {
    expect(excursionBeyondRect([], frame)).toBe(0);
  });
});
