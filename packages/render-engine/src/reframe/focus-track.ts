/**
 * Where the subject actually is, sampled from the animation rather than assumed.
 *
 * `FocusTarget` offers two answers and says which is better: "Naming an `instance` is
 * the better answer whenever there is one: the reframer can then follow that instance's
 * animated transform through the shot, so a character who crosses the scene stays
 * framed instead of walking out of a crop that was solved once at frame zero."
 *
 * This module is what makes that sentence true. It calls `evaluate` - the same pure
 * function the frame loop calls, at the same instants - so the crop is solved against
 * the positions that will actually be rendered, not against a separate approximation
 * that drifts.
 *
 * The sampling is deliberately coarse. A crop is a continuous function of shot progress
 * (see `solve-crop.ts`), so the samples are constraints on that function, not the
 * function itself; evaluating every frame of a 300-frame shot to derive two endpoints
 * would cost 300 evaluations to answer a two-variable question.
 */

import { evaluate } from '@rv/anim-engine';
import type { AnimationIR, MotionStyle, NodeId, NormRect } from '@rv/contracts';

import { clamp } from './geometry';
import { IDENTITY_CAMERA, projectToNorm } from '../scene-projection';
import type { FocusSample } from './solve-crop';

export interface SampleFocusOptions {
  /**
   * How many instants to sample across the shot. Three - start, middle, end - is the
   * minimum that can catch a subject that crosses and comes back.
   */
  readonly samples?: number;
  /** Motion settings, forwarded to `evaluate` so the samples match the render. */
  readonly motion?: Pick<MotionStyle, 'stepMode' | 'easings' | 'tempo'>;
}

const DEFAULT_SAMPLES = 5;

/**
 * A focus track for a node that moves, in composition-space fractions.
 *
 * The region keeps the authored size and travels with the node: the author said how big
 * the subject is, and the animation says where it is. Recomputing the size per frame
 * from a bounding box would make the crop breathe with the character's own scale
 * animation, which is a visible artefact and not what anyone asked for.
 */
export function sampleFocusTrack(
  ir: AnimationIR,
  nodeId: NodeId,
  baseRegion: NormRect,
  window: { readonly startMs: number; readonly durationMs: number },
  options: SampleFocusOptions = {},
): readonly FocusSample[] {
  const count = Math.max(2, options.samples ?? DEFAULT_SAMPLES);
  const samples: FocusSample[] = [];

  for (let index = 0; index < count; index += 1) {
    const progress = index / (count - 1);
    const offsetMs = window.durationMs * progress;
    const snapshot = evaluate(
      ir,
      window.startMs + offsetMs,
      options.motion === undefined ? {} : { motion: options.motion },
    );
    const resolved = snapshot.nodes.find((node) => node.nodeId === nodeId);
    // A node the snapshot does not contain cannot be followed. `FocusTarget.region` is
    // documented as "the tie-breaker for the frames the instance does not exist in", so
    // that is exactly what is used.
    //
    // Projected, not merely normalised. The crop is applied to the rendered master, which
    // carries the camera; locating the subject on the authoring canvas instead answers a
    // different question and gets the crop wrong for every shot whose camera moves.
    const region =
      resolved === undefined
        ? baseRegion
        : centreRegionOn(
            baseRegion,
            projectToNorm(resolved.worldTransform.position, snapshot.camera, ir.sceneSpace),
          );
    samples.push({ timeMs: offsetMs, region });
  }

  return samples;
}

/** A static subject: one sample, the authored region, unchanged. */
export function staticFocusTrack(region: NormRect): readonly FocusSample[] {
  return [{ timeMs: 0, region }];
}

/**
 * Scene coordinates to composition fractions, **with no camera applied**.
 *
 * Mirrors `frames/draw-list.ts`'s convention - the scene-space origin is the *centre*
 * of the canvas - because the reframer and the rasteriser must agree about where the
 * middle is or every crop is off by half a frame.
 *
 * This is the origin conversion and nothing more, which is exactly why it is the wrong
 * function to locate a subject for cropping: the master has the camera baked in, so a
 * node is only *here* when the camera happens to be an identity. Using it for that is the
 * bug `scene-projection.ts` documents. It is kept because the conversion itself is a
 * legitimate primitive - and it is defined as the identity-camera case of
 * {@link projectToNorm} rather than restated, so the two cannot drift.
 */
export function worldToNorm(
  position: { readonly x: number; readonly y: number },
  scene: { readonly width: number; readonly height: number },
): { x: number; y: number } {
  return projectToNorm(position, IDENTITY_CAMERA, scene);
}

/**
 * Move a region so its centre lands on `centre`, keeping it inside the canvas.
 *
 * Clamped rather than allowed to hang off the edge: a focus rectangle that extends past
 * the composition describes a subject that is partly not there, and the solver would
 * dutifully try to keep the empty half in shot.
 */
export function centreRegionOn(
  region: NormRect,
  centre: { readonly x: number; readonly y: number },
): NormRect {
  const width = Math.min(region.width, 1);
  const height = Math.min(region.height, 1);
  return {
    x: clamp(centre.x - width / 2, 0, 1 - width),
    y: clamp(centre.y - height / 2, 0, 1 - height),
    width,
    height,
  };
}
