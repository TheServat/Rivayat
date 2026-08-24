/**
 * Scene space to canvas pixels — **a mirror of the renderer's convention, not a second
 * opinion about it.**
 *
 * `packages/render-engine/src/frames/draw-list.ts` fixes the convention and says so at
 * the top of the file: *the origin is the centre of the canvas*, so scene space spans
 * `[-w/2, +w/2] x [-h/2, +h/2]`, and a camera keyframe at `{x: 0, y: 0}` frames the
 * middle of the composition. The fit is **contain** — the whole authoring canvas is
 * always visible, letterboxed if the aspect differs — because cropping belongs to the
 * reframer, which solves it per delivery format against a declared safe area.
 *
 * ## Why this file exists at all, which is a problem worth naming
 *
 * The studio may not import `@rv/render-engine`: it is server code (`sharp`,
 * `@napi-rs/canvas`, Playwright) and `.dependency-cruiser.cjs` fails the build on it.
 * So the *only* way for a browser preview to place a node is to restate the mapping,
 * and restating a mapping is precisely how the Lottie exporter came to put scene (0,0)
 * in the corner while the renderer put it in the middle — a bug its own fidelity metric
 * could not see, because the metric shared the wrong mapping.
 *
 * Two things keep this copy honest, and neither is a comment:
 *
 *  1. `scene-space.spec.ts` pins the convention as *properties* rather than as numbers
 *     copied across — the origin lands at the canvas centre, the fit is contain in both
 *     aspect directions, and the multiplication order matches `transformPoint` in
 *     `@rv/anim-engine`, which the studio *can* import and does.
 *  2. The right fix is upstream and is reported rather than worked around: these six
 *     functions are pure geometry over `@rv/contracts` types and belong in a
 *     browser-safe package that the renderer, the exporter and this player all import.
 *     Until they do, there are three copies and this is the third.
 *
 * Multiplication order is skew, then scale, then rotate, then translate — matching
 * `composeTransform`/`transformPoint` in `@rv/anim-engine` exactly. A different order
 * places every skewed node differently from the evaluator's own `look-at` and parallax
 * maths, and the two drift without anything failing.
 */

import type { Size, Transform2D, Vec2 } from '@rv/contracts';

const DEG_TO_RAD = Math.PI / 180;

/** `x' = a·x + c·y + e`, `y' = b·x + d·y + f` — the canvas convention. */
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
 * `anchor` is deliberately not folded in: it is expressed in the node's own bounds,
 * which the transform does not know. The painter applies it once it has measured the
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

export interface CameraView {
  readonly position: Vec2;
  readonly zoom: number;
  readonly rotation: number;
}

/**
 * Scene space to output pixels, for one frame's camera.
 *
 * A **contain** fit. The letterbox is real and is drawn: a preview that stretched to
 * fill would be showing a composition nobody will render.
 */
export function cameraMatrix(camera: CameraView, scene: Size, output: Size): Matrix2D {
  const fit = Math.min(output.width / scene.width, output.height / scene.height);
  const centre = translation(output.width / 2, output.height / 2);
  const zoomed = multiply(centre, scaling(fit * camera.zoom, fit * camera.zoom));
  // The camera turning left turns the world right, hence the negated angle.
  const turned = multiply(zoomed, rotation(-camera.rotation));
  return multiply(turned, translation(-camera.position.x, -camera.position.y));
}

/**
 * The letterboxed rectangle the scene occupies at zoom 1, in output pixels.
 *
 * Drawn as the frame edge so the user can see what is inside the composition and what
 * is the player's own margin. Derived from the same `fit` as {@link cameraMatrix}, so
 * the two cannot disagree.
 */
export function sceneRect(
  scene: Size,
  output: Size,
): { x: number; y: number; width: number; height: number } {
  const fit = Math.min(output.width / scene.width, output.height / scene.height);
  const width = scene.width * fit;
  const height = scene.height * fit;
  return { x: (output.width - width) / 2, y: (output.height - height) / 2, width, height };
}

/** Centre-origin scene coordinates for a point given as fractions of the canvas. */
export function normPointToScene(point: Vec2, scene: Size): Vec2 {
  return { x: (point.x - 0.5) * scene.width, y: (point.y - 0.5) * scene.height };
}
