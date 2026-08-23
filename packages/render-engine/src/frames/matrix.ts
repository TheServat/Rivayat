/**
 * Affine matrices, for the one step where components are not enough.
 *
 * `@rv/anim-engine` composes transforms **component-wise** and explains why: the editor
 * needs `{position, rotation, scale, skew}` back out, and a matrix cannot be decomposed
 * unambiguously. That trade is right for the IR and wrong for the rasteriser - a canvas
 * takes `setTransform(a, b, c, d, e, f)` and nothing else - so the conversion happens
 * here, once, at the very end of the pipeline where nothing needs the components again.
 *
 * The multiplication order matches `transformPoint` in `@rv/anim-engine` exactly:
 * skew, then scale, then rotate, then translate. A renderer that applied them in a
 * different order would place every skewed node differently from the evaluator's own
 * `look-at` and parallax maths, and the two would drift without anything failing.
 */

import type { Transform2D, Vec2 } from '@rv/contracts';

const DEG_TO_RAD = Math.PI / 180;

/** `x' = a·x + c·y + e`, `y' = b·x + d·y + f` - the canvas convention. */
export interface Matrix2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function translation(x: number, y: number): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scaling(x: number, y: number): Matrix2D {
  return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 };
}

export function rotation(degrees: number): Matrix2D {
  const radians = degrees * DEG_TO_RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** `left ∘ right`: apply `right` first, then `left`. */
export function multiply(left: Matrix2D, right: Matrix2D): Matrix2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function applyPoint(matrix: Matrix2D, point: Vec2): Vec2 {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

/**
 * A resolved world transform as a matrix.
 *
 * `anchor` is deliberately *not* folded in: it is expressed in the node's own bounds,
 * which the transform does not know. The backend applies it once it has measured the
 * thing it is about to draw.
 */
export function fromTransform(transform: Transform2D): Matrix2D {
  const radians = transform.rotation * DEG_TO_RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const tanX = Math.tan(transform.skew.x * DEG_TO_RAD);
  const tanY = Math.tan(transform.skew.y * DEG_TO_RAD);
  const sx = transform.scale.x;
  const sy = transform.scale.y;

  return {
    a: cos * sx - sin * sy * tanY,
    b: sin * sx + cos * sy * tanY,
    c: cos * sx * tanX - sin * sy,
    d: sin * sx * tanX + cos * sy,
    e: transform.position.x,
    f: transform.position.y,
  };
}

/**
 * Scene space to output pixels, for one frame's camera.
 *
 * A **contain** fit: the whole authoring canvas is always visible, letterboxed if the
 * output aspect differs. Cropping belongs to the reframer, which solves it per delivery
 * format against a declared safe area - having the master renderer silently crop too
 * would mean two independent cropping rules, and the one nobody configured wins.
 */
export function cameraMatrix(
  camera: { readonly position: Vec2; readonly zoom: number; readonly rotation: number },
  scene: { readonly width: number; readonly height: number },
  output: { readonly width: number; readonly height: number },
): Matrix2D {
  const fit = Math.min(output.width / scene.width, output.height / scene.height);
  const centre = translation(output.width / 2, output.height / 2);
  const zoomed = multiply(centre, scaling(fit * camera.zoom, fit * camera.zoom));
  // The camera turning left turns the world right, hence the negated angle.
  const turned = multiply(zoomed, rotation(-camera.rotation));
  return multiply(turned, translation(-camera.position.x, -camera.position.y));
}
