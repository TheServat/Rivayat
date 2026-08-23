/**
 * 2D transform composition.
 *
 * Component-wise rather than matrix-based, and that is a deliberate trade. A matrix
 * composes shear correctly but cannot be decomposed back into
 * `{position, rotation, scale, skew}` without ambiguity - and the editor, the timeline
 * and the exporters all need those components back. Composing the components directly
 * keeps them meaningful all the way through.
 *
 * The cost: non-uniform scale on a rotated parent produces shear that this model
 * cannot represent, so a child under such a parent will differ from what a full matrix
 * pipeline would draw. That combination is rare in 2D cutout work and the alternative
 * is losing editability everywhere, so it is accepted and documented rather than hidden.
 */

import type { Transform2D, Vec2 } from '@rv/contracts';

const DEG_TO_RAD = Math.PI / 180;

export function identityTransform(): Transform2D {
  return {
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    skew: { x: 0, y: 0 },
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  };
}

/** Rotates a vector about the origin. */
export function rotateVec(vector: Vec2, degrees: number): Vec2 {
  if (degrees === 0) return vector;
  const radians = degrees * DEG_TO_RAD;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  };
}

/**
 * `parent ∘ local` - the child's transform in world space.
 *
 * `anchor` is *not* composed: it is the child's own pivot, expressed in its own bounds,
 * and inheriting a parent's pivot would move a child every time its parent's pivot
 * moved.
 */
export function composeTransform(parent: Transform2D, local: Transform2D): Transform2D {
  const scaled: Vec2 = {
    x: local.position.x * parent.scale.x,
    y: local.position.y * parent.scale.y,
  };
  const rotated = rotateVec(scaled, parent.rotation);

  return {
    position: { x: parent.position.x + rotated.x, y: parent.position.y + rotated.y },
    rotation: parent.rotation + local.rotation,
    scale: { x: parent.scale.x * local.scale.x, y: parent.scale.y * local.scale.y },
    skew: { x: parent.skew.x + local.skew.x, y: parent.skew.y + local.skew.y },
    anchor: local.anchor,
    opacity: parent.opacity * local.opacity,
  };
}

/** Maps a point from the transform's local space into its parent's space. */
export function transformPoint(transform: Transform2D, point: Vec2): Vec2 {
  const skewed: Vec2 = {
    x: point.x + point.y * Math.tan(transform.skew.x * DEG_TO_RAD),
    y: point.y + point.x * Math.tan(transform.skew.y * DEG_TO_RAD),
  };
  const scaled: Vec2 = { x: skewed.x * transform.scale.x, y: skewed.y * transform.scale.y };
  const rotated = rotateVec(scaled, transform.rotation);
  return { x: rotated.x + transform.position.x, y: rotated.y + transform.position.y };
}

/** True when two transforms agree to within `epsilon` on every component. */
export function transformsEqual(a: Transform2D, b: Transform2D, epsilon = 1e-9): boolean {
  const close = (x: number, y: number): boolean => Math.abs(x - y) <= epsilon;
  return (
    close(a.position.x, b.position.x) &&
    close(a.position.y, b.position.y) &&
    close(a.rotation, b.rotation) &&
    close(a.scale.x, b.scale.x) &&
    close(a.scale.y, b.scale.y) &&
    close(a.skew.x, b.skew.x) &&
    close(a.skew.y, b.skew.y) &&
    close(a.anchor.x, b.anchor.x) &&
    close(a.anchor.y, b.anchor.y) &&
    close(a.opacity, b.opacity)
  );
}
