/**
 * Where the origin is, decided once for every projection of the IR.
 *
 * `AnimationIR` declares `sceneSpace` as a `Size` and never says where its origin sits.
 * `@rv/render-engine` fixes it - `frames/draw-list.ts`: "the origin is the centre of the
 * canvas, so the canvas spans `[-w/2, +w/2] x [-h/2, +h/2]`" - and implements it in
 * `frames/matrix.ts#cameraMatrix` and `reframe/focus-track.ts#worldToNorm`.
 *
 * **The renderer is the reference implementation and every exporter follows it.** It is
 * what produces the actual video; an export is a projection of the same document and does
 * not get to hold a different opinion about where nothing is. Formats whose own origin is
 * elsewhere - Lottie's composition and a DragonBones armature are both top-left - are
 * converted here, on the way out, rather than each deciding for itself.
 *
 * The alternative was to leave a root-level export at the raw scene origin and let the
 * integrator place it. That trade is the wrong way round: repositioning an armature is a
 * transform an integrator can see and expects to apply, while a silent half-canvas offset
 * is something nothing in the file mentions and only a debugging session finds. Between an
 * adjustment somebody can see and a shift somebody has to discover, we owe them the first.
 *
 * This module exists because the same geometry lived in two exporters independently once
 * already, and the copies disagreed with the renderer in two different ways.
 */

import type { Size, Transform2D, Vec2 } from '@rv/contracts';
import { rotateVec } from '@rv/anim-engine';

/** The camera as the evaluator resolves it for one instant. */
export interface ResolvedCamera {
  readonly position: Vec2;
  readonly zoom: number;
  readonly rotation: number;
}

/**
 * The middle of the authoring canvas, which is scene-space `(0, 0)`.
 *
 * Also the offset between the two spaces: a format with a top-left origin needs exactly
 * this added to every scene coordinate.
 */
export function sceneCentreOf(sceneSpace: Size): Vec2 {
  return { x: sceneSpace.width / 2, y: sceneSpace.height / 2 };
}

/**
 * A scene-space point in a top-left-origin output space.
 *
 * With no camera this is the centre shift alone, which is what a format that has no
 * camera concept needs. With one, it mirrors `cameraMatrix` in `@rv/render-engine` term
 * for term:
 *
 * ```
 *   screen = sceneCentre + zoom · R(-cameraRotation) · (position - cameraPosition)
 * ```
 *
 * The subtraction is against the **camera position**, not against the scene centre: the
 * camera pans, zooms and rolls about itself, so a pan of 100 units under a 2x zoom moves
 * content 200 pixels. Rotating about the scene centre and then translating by the raw pan
 * agrees with the renderer only at zoom 1 with the camera at the origin.
 *
 * An identity camera is an identity: `(p - 0) · 1` rotated by nothing is `p`.
 */
export function toCompositionSpace(
  position: Vec2,
  sceneSpace: Size,
  camera?: ResolvedCamera,
): Vec2 {
  const centre = sceneCentreOf(sceneSpace);
  if (camera === undefined) return { x: centre.x + position.x, y: centre.y + position.y };

  const relative = { x: position.x - camera.position.x, y: position.y - camera.position.y };
  const rotated = rotateVec(relative, -camera.rotation);
  return { x: centre.x + rotated.x * camera.zoom, y: centre.y + rotated.y * camera.zoom };
}

/**
 * A whole world transform moved into the output space.
 *
 * Position only. Rotation, scale, skew and opacity are unaffected by where the origin is,
 * and a format that also folds a camera in has to scale and turn them itself - which is
 * why this deliberately does not take a camera. Used by the projections that have no
 * camera concept at all, where the shift is the entire conversion.
 */
export function transformInCompositionSpace(transform: Transform2D, sceneSpace: Size): Transform2D {
  return { ...transform, position: toCompositionSpace(transform.position, sceneSpace) };
}
