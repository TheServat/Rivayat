/**
 * Scene space to composition fractions, with the camera applied.
 *
 * ## Why this is its own module
 *
 * Destined for `@rv/anim-engine`, which is where the shared bezier solver already lives
 * for exactly this reason: it is pure geometry over `@rv/contracts` types, browser-safe,
 * and needed by the renderer, the exporter and the studio preview alike. Until that move
 * happens this file imports **nothing from this package**, so the extraction is a move
 * rather than a rewrite.
 *
 * ## What it is for
 *
 * The reframer solves a crop and FFmpeg applies it to the **rendered master**, which has
 * the camera baked into every layer by `frames/matrix.ts#cameraMatrix`. So a subject can
 * only be located for cropping in the space the master is actually in. Reading the scene
 * position and normalising it - `x / width + 0.5` - answers a different question: where
 * the subject sits on the authoring canvas, which is where it appears only when the
 * camera is an identity.
 *
 * That gap was real and shipping. On a 400x300 canvas with the camera panning -100 to
 * +100 and zooming 1 to 1.4, the crop was solved against a point up to 100 px from where
 * the subject actually was - a quarter of the frame, and more than the width of a 9:16
 * crop taken from a 16:9 master, so the subject left the crop entirely.
 *
 * ## The space, and why no output size is needed
 *
 * `cameraMatrix` maps scene space to output pixels as
 *
 * ```
 *   screen = outputCentre + fit * zoom * R(-rotation) * (position - cameraPosition)
 * ```
 *
 * and a crop is expressed in fractions of the composition, not in pixels. When the master
 * presents the composition undistorted - which `buildReframePlan` already assumes, since
 * it is handed `composition: ir.sceneSpace` - `fit` cancels against the output size and
 * the normalised result depends on nothing but the three arguments here. That is what
 * makes this a pure function of `(position, camera, sceneSpace)` rather than something
 * that has to be told how large the master is.
 */

import type { Size, Vec2 } from '@rv/contracts';
import { rotateVec } from '@rv/anim-engine';

/**
 * The camera as the evaluator resolves it for one instant.
 *
 * Structural rather than importing `SceneSnapshot['camera']`, so a caller holding the
 * three numbers does not have to build a snapshot to ask where something lands.
 */
export interface ProjectedCamera {
  readonly position: Vec2;
  readonly zoom: number;
  readonly rotation: number;
}

/** A camera that frames the composition exactly: the whole canvas, unmoved. */
export const IDENTITY_CAMERA: ProjectedCamera = {
  position: { x: 0, y: 0 },
  zoom: 1,
  rotation: 0,
};

/**
 * Where a scene-space point lands in the composition, as fractions from the top-left.
 *
 * Mirrors `cameraMatrix` term for term, normalised. The subtraction is against the camera
 * position and the zoom multiplies the result of it, because the camera pans, zooms and
 * rolls about itself: a pan of 100 units under a 2x zoom moves content 200 pixels.
 *
 * The result is deliberately **not clamped**. A subject that has left the frame is a fact
 * the crop solver needs; clamping it to the edge would make an off-screen subject look
 * like one sitting against the border, and the solver would then report a crop it could
 * satisfy rather than a shot that needs attention.
 */
export function projectToNorm(position: Vec2, camera: ProjectedCamera, sceneSpace: Size): Vec2 {
  const relative = {
    x: position.x - camera.position.x,
    y: position.y - camera.position.y,
  };
  const rotated = rotateVec(relative, -camera.rotation);
  return {
    x: 0.5 + (rotated.x * camera.zoom) / sceneSpace.width,
    y: 0.5 + (rotated.y * camera.zoom) / sceneSpace.height,
  };
}
