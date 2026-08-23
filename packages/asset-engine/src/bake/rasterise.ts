/**
 * Drawing a transformed part onto a canvas, in software.
 *
 * Baking is head-less by definition - `bakeSheet` renders a clip with no browser and
 * no GPU (architecture §6) - and the transform it has to apply is the ordinary 2D
 * affine the evaluator produced. Inverse-mapping each destination pixel is the whole
 * algorithm, and it has the property the baker needs above speed: it is exactly
 * reproducible, so the same clip bakes to the same bytes on any machine.
 *
 * Nearest-neighbour sampling, deliberately. Bilinear would soften every part's edge by
 * half a pixel per frame, and `alphaCleanliness` counts exactly those pixels; a baked
 * sheet that scores worse than the parts it was baked from would be measuring the
 * sampler, not the art.
 */

import type { Transform2D } from '@rv/contracts';

import type { RgbaImage } from '../ports/raster-port';
import { px } from '../raster/pixels';

/** `[a, b, c, d, tx, ty]`, applied as `x' = a·x + c·y + tx`. */
export type Matrix2D = readonly [number, number, number, number, number, number];

export function identityMatrix(): Matrix2D {
  return [1, 0, 0, 1, 0, 0];
}

export function multiply(left: Matrix2D, right: Matrix2D): Matrix2D {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

/**
 * The matrix that places a part's bitmap on the canvas for one frame.
 *
 * Built pivot-first: translate the pivot to the origin, apply the pose, then move the
 * pivot to where the frame says it goes. Rotating about the bitmap's top-left instead
 * is the classic 2D bug that makes a swaying branch orbit the canvas.
 */
export function placementMatrix(input: {
  readonly transform: Transform2D;
  /** Where the part's pivot sits on the canvas at rest, in pixels. */
  readonly restPivot: { readonly x: number; readonly y: number };
  /** The pivot inside the part's own bitmap, in pixels. */
  readonly localPivot: { readonly x: number; readonly y: number };
}): Matrix2D {
  const { transform } = input;
  const radians = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const skewX = Math.tan((transform.skew.x * Math.PI) / 180);
  const skewY = Math.tan((transform.skew.y * Math.PI) / 180);

  const scale: Matrix2D = [transform.scale.x, 0, 0, transform.scale.y, 0, 0];
  const shear: Matrix2D = [1, skewY, skewX, 1, 0, 0];
  const rotate: Matrix2D = [cos, sin, -sin, cos, 0, 0];
  const toOrigin: Matrix2D = [1, 0, 0, 1, -input.localPivot.x, -input.localPivot.y];
  const toPlace: Matrix2D = [
    1,
    0,
    0,
    1,
    input.restPivot.x + transform.position.x,
    input.restPivot.y + transform.position.y,
  ];

  return multiply(toPlace, multiply(rotate, multiply(shear, multiply(scale, toOrigin))));
}

/**
 * Source-over draw of `source` through `matrix` onto `target`, in place.
 *
 * Only the destination pixels inside the transformed bounding box are visited, so a
 * small part on a large canvas costs its own area rather than the canvas's.
 */
export function drawAffine(
  target: RgbaImage,
  source: RgbaImage,
  matrix: Matrix2D,
  opacity: number,
): void {
  const inverse = invert(matrix);
  if (inverse === null || opacity <= 0) return;

  const corners = [
    apply(matrix, 0, 0),
    apply(matrix, source.width, 0),
    apply(matrix, 0, source.height),
    apply(matrix, source.width, source.height),
  ];
  const minX = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.x))));
  const maxX = Math.min(target.width - 1, Math.ceil(Math.max(...corners.map((point) => point.x))));
  const minY = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.y))));
  const maxY = Math.min(target.height - 1, Math.ceil(Math.max(...corners.map((point) => point.y))));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      // Sample at the pixel centre: sampling the corner shifts the whole part half a
      // pixel up-left, which is invisible per frame and visible as a shimmer in a loop.
      const local = apply(inverse, x + 0.5, y + 0.5);
      const sx = Math.floor(local.x);
      const sy = Math.floor(local.y);
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;

      const s = (sy * source.width + sx) * 4;
      const alpha = (px(source.data, s + 3) / 255) * opacity;
      if (alpha <= 0) continue;

      const d = (y * target.width + x) * 4;
      const under = px(target.data, d + 3) / 255;
      const out = alpha + under * (1 - alpha);
      for (let c = 0; c < 3; c += 1) {
        const src = px(source.data, s + c);
        const dst = px(target.data, d + c);
        target.data[d + c] = Math.round((src * alpha + dst * under * (1 - alpha)) / out);
      }
      target.data[d + 3] = Math.round(out * 255);
    }
  }
}

function apply(matrix: Matrix2D, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

/** `null` for a degenerate matrix - a part scaled to zero draws nothing, not NaN. */
function invert(matrix: Matrix2D): Matrix2D | null {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (Math.abs(determinant) < 1e-9) return null;
  const a = matrix[3] / determinant;
  const b = -matrix[1] / determinant;
  const c = -matrix[2] / determinant;
  const d = matrix[0] / determinant;
  return [a, b, c, d, -(a * matrix[4] + c * matrix[5]), -(b * matrix[4] + d * matrix[5])];
}
