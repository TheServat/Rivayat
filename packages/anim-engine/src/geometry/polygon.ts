/**
 * Convex-polygon arithmetic, for measuring what a frame will actually look like.
 *
 * The animation engine can already say where every node *is*. It could not, until now,
 * say whether the picture those positions describe holds together - and a render that is
 * bit-reproducible, schema-valid and visibly broken is the failure this module exists to
 * make impossible. Measuring the geometry is enough: rasterising a frame to inspect it
 * costs a canvas, a decoder and several milliseconds per frame, which is far too much to
 * run on every clip, whereas a node's silhouette follows from its world transform and its
 * own size by arithmetic that fits in a few hundred operations.
 *
 * Everything here is **convex** on purpose. A node's silhouette is a box or an ellipse
 * under an affine map, both convex, and convexity is what makes intersection, separation
 * and containment exact and cheap. A general polygon would need a full boolean library
 * and would buy nothing the checks need.
 */

import { at } from '@rv/shared-kernel';
import type { Rect, Vec2 } from '@rv/contracts';

/**
 * A convex polygon in scene space, vertices in order.
 *
 * Winding is not part of the contract - every function here derives it from the signed
 * area - because the producers of these polygons (a rotated box, a mirrored sprite under
 * a negative scale) legitimately emit both, and a silent wrong answer for one of them is
 * exactly the class of defect this package is being hardened against.
 */
export type ConvexPolygon = readonly Vec2[];

/** Twice the signed area. Positive and negative both occur; only the sign is read. */
function signedDoubleArea(polygon: ConvexPolygon): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const current = at(polygon, i);
    const next = at(polygon, (i + 1) % polygon.length);
    total += current.x * next.y - next.x * current.y;
  }
  return total;
}

/** Area in square scene units. Zero for a degenerate or empty polygon. */
export function polygonArea(polygon: ConvexPolygon): number {
  if (polygon.length < 3) return 0;
  return Math.abs(signedDoubleArea(polygon)) / 2;
}

/**
 * Where the segment `from -> to` crosses the infinite line through the clip edge.
 *
 * No guard against a zero denominator, deliberately. The only caller reaches this with
 * `from` and `to` on strictly opposite sides of the clip line - that is the condition it
 * tests before calling - and two points on opposite sides of a line cannot lie on a
 * segment parallel to it. A sentinel branch here would be permanently unreachable, and an
 * unreachable branch in a package that owes 100 % coverage is a lie in the report.
 */
function lineIntersection(from: Vec2, to: Vec2, edgeStart: Vec2, edgeEnd: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ex = edgeEnd.x - edgeStart.x;
  const ey = edgeEnd.y - edgeStart.y;
  const t = ((edgeStart.x - from.x) * ey - (edgeStart.y - from.y) * ex) / (dx * ey - dy * ex);
  return { x: from.x + dx * t, y: from.y + dy * t };
}

/**
 * `subject ∩ clipper`, by Sutherland-Hodgman.
 *
 * Correct only for a convex clipper, which is why {@link ConvexPolygon} is the parameter
 * type rather than a bare vertex array: the algorithm clips against each edge's infinite
 * line in turn, and a reflex vertex would carve away area that belongs in the result.
 */
export function intersectConvex(subject: ConvexPolygon, clipper: ConvexPolygon): ConvexPolygon {
  if (subject.length < 3 || clipper.length < 3) return [];
  const clipperArea = signedDoubleArea(clipper);
  // A collapsed clipper has no interior, so nothing is inside it. Without this the
  // half-plane test below reads every zero cross product as "inside" and hands back the
  // subject untouched - which would make a part scaled to nothing appear to still overlap
  // everything it used to.
  if (clipperArea === 0) return [];
  const keepPositive = clipperArea > 0;

  let output: readonly Vec2[] = subject;
  for (let edge = 0; edge < clipper.length && output.length > 0; edge += 1) {
    const start = at(clipper, edge);
    const end = at(clipper, (edge + 1) % clipper.length);
    const inside = (point: Vec2): boolean => {
      const cross =
        (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
      return keepPositive ? cross >= 0 : cross <= 0;
    };

    const clipped: Vec2[] = [];
    for (let i = 0; i < output.length; i += 1) {
      const current = at(output, i);
      const previous = at(output, (i - 1 + output.length) % output.length);
      const currentIn = inside(current);
      if (currentIn) {
        if (!inside(previous)) clipped.push(lineIntersection(previous, current, start, end));
        clipped.push(current);
      } else if (inside(previous)) {
        clipped.push(lineIntersection(previous, current, start, end));
      }
    }
    output = clipped;
  }
  return output;
}

function projectOnto(polygon: ConvexPolygon, axisX: number, axisY: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const vertex of polygon) {
    const distance = vertex.x * axisX + vertex.y * axisY;
    if (distance < min) min = distance;
    if (distance > max) max = distance;
  }
  return [min, max];
}

/**
 * How far apart two convex polygons are: `0` exactly when they touch or overlap.
 *
 * By the separating-axis theorem, and therefore **exact as a predicate** - a zero here
 * means the two shapes genuinely share a point. The *magnitude* is a lower bound rather
 * than the true distance, because only edge normals are tested and two shapes offset
 * diagonally are furthest apart along a vertex-to-vertex direction that is nobody's edge
 * normal.
 *
 * Under-reporting the magnitude is the direction a gate should err in: a finding this
 * function produces is never larger than the real gap, so "the wing is 3.4 px off the
 * body" is a floor and not a boast. A shape collapsed to a point contributes no edge
 * normals of its own and is therefore judged entirely by the other's, which for two
 * collapsed shapes leaves no axis at all and answers `0` - the conservative answer, and
 * unreachable through {@link ConvexPolygon}s built from a silhouette, whose collapse
 * would already have removed them from consideration for want of area.
 */
export function convexSeparation(a: ConvexPolygon, b: ConvexPolygon): number {
  if (a.length < 3 || b.length < 3) return 0;
  let widest = 0;
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i += 1) {
      const start = at(polygon, i);
      const end = at(polygon, (i + 1) % polygon.length);
      const nx = -(end.y - start.y);
      const ny = end.x - start.x;
      const length = Math.hypot(nx, ny);
      if (length === 0) continue;
      const [aMin, aMax] = projectOnto(a, nx / length, ny / length);
      const [bMin, bMax] = projectOnto(b, nx / length, ny / length);
      const gap = Math.max(bMin - aMax, aMin - bMax);
      if (gap > widest) widest = gap;
    }
  }
  return widest;
}

/**
 * Distance from a point to a convex polygon; **negative inside**.
 *
 * The sign is the whole value of it. "The wing pivots 5.3 px outside the body" and "the
 * wing pivots 7.6 px inside the body" are the difference between a joint that will open
 * under rotation and one that cannot, and a magnitude alone cannot tell them apart.
 */
export function signedDistanceToConvex(polygon: ConvexPolygon, point: Vec2): number {
  if (polygon.length < 3) return Infinity;
  const doubleArea = signedDoubleArea(polygon);
  const keepPositive = doubleArea > 0;

  // A polygon with no area has no interior: every cross product is zero, which the
  // half-plane test would otherwise read as "on the inside of every edge" and report a
  // containment that does not exist.
  let outside = doubleArea === 0;
  let nearest = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const start = at(polygon, i);
    const end = at(polygon, (i + 1) % polygon.length);
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    if (keepPositive ? cross < 0 : cross > 0) outside = true;

    const ex = end.x - start.x;
    const ey = end.y - start.y;
    const lengthSquared = ex * ex + ey * ey;
    const along =
      lengthSquared === 0
        ? 0
        : Math.min(
            1,
            Math.max(0, ((point.x - start.x) * ex + (point.y - start.y) * ey) / lengthSquared),
          );
    const distance = Math.hypot(point.x - (start.x + ex * along), point.y - (start.y + ey * along));
    if (distance < nearest) nearest = distance;
  }
  return outside ? nearest : -nearest;
}

/**
 * How far a polygon reaches outside an axis-aligned rectangle, in scene units.
 *
 * Zero when contained. One number rather than four so a finding can carry "how far out of
 * tolerance" without the caller having to decide which edge to complain about first.
 */
export function excursionBeyondRect(polygon: ConvexPolygon, rect: Rect): number {
  let worst = 0;
  for (const vertex of polygon) {
    const overflow = Math.max(
      rect.x - vertex.x,
      vertex.x - (rect.x + rect.width),
      rect.y - vertex.y,
      vertex.y - (rect.y + rect.height),
    );
    if (overflow > worst) worst = overflow;
  }
  return worst;
}
