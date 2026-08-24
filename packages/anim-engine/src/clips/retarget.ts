/**
 * Playing a clip on a skeleton it was not authored on.
 *
 * ## The rule
 *
 * **Angles carry over unchanged; lengths are rescaled; structure is untouched.** A knee
 * bends through the same angle on a child and on an adult, and that is why skeletal
 * motion is reusable at all. What does not carry over is distance: a stride authored for
 * a 512 px figure makes a 256 px one skate, because its feet swing half as far as its
 * body travels. Foot slide is the retargeting bug, and it is a division.
 *
 * ## What is deliberately *not* changed
 *
 * The node graph, the ids, the seeds, the timings, the markers and the camera all
 * survive verbatim. Two consequences, both wanted:
 *
 *  - **Retargeting onto identical proportions is the identity.** Every scale is exactly
 *    `1`, `x * 1 === x` in IEEE-754 for every finite `x`, and nothing else was touched -
 *    so the document is byte-identical and `evaluate` agrees at every sampled instant,
 *    exactly rather than approximately. That is ADR-0008's acceptance criterion, and it
 *    holds by arithmetic rather than by a short-circuit.
 *  - **The hierarchy is the clip's, not the target's.** A fragment's nodes are groups at
 *    the identity named after bone roles; the skeleton's geometry lives on the rig and is
 *    combined at pose time. So a target rig with an extra bone between two driven roles
 *    needs no rewrite here: that bone is at rest, composing through it is the identity,
 *    and the compatibility check's *ancestry* rule (rather than a parenthood rule) is
 *    what makes that sound.
 *
 * The camera is left alone on purpose. A clip fragment carries none today, and if one
 * ever appears it frames the *scene*, not the rig - a character growing taller is not a
 * reason to move the camera, and scaling it would be a second, invisible edit.
 */

import {
  ValidationError,
  assertNever,
  type AppError,
  type Result,
  err,
  must,
  ok,
} from '@rv/shared-kernel';
import type { AnimationIR, Behaviour, RigSignature, Track, Vec2 } from '@rv/contracts';
import { scalesWithRig } from '@rv/contracts';

import { clipAnimatedRoles, clipDrivenRoles, frameLengthOf } from './signature';

/**
 * The clip, rescaled for `target`.
 *
 * Fails rather than guessing when a role cannot be measured on either side: a clip whose
 * driven role is absent from a signature has no yardstick, and a source with no
 * measurable proportions at all would be a division by zero that turns every value into
 * `Infinity` a hundred frames into a render.
 */
export function retargetClip(
  ir: AnimationIR,
  source: RigSignature,
  target: RigSignature,
): Result<AnimationIR, AppError> {
  const scales = scaleByRole(ir, source, target);
  if (!scales.ok) return scales;

  const roleOf = roleByNode(ir);
  const factorFor = (nodeId: string): number => {
    const role = must(roleOf, nodeId, 'node role');
    // A role with no factor is one neither skeleton could measure *and* the clip does
    // not drive - an inert record on a limb the target does not have. Left at 1, which
    // carries it through verbatim rather than rejecting a clip over data nothing reads.
    return scales.value.get(role) ?? 1;
  };

  const tracks: Track[] = ir.tracks.map((track) =>
    scalesWithRig(track.channel)
      ? {
          ...track,
          keyframes: track.keyframes.map((keyframe) => ({
            ...keyframe,
            value: keyframe.value * factorFor(track.nodeId),
          })),
        }
      : track,
  );

  const behaviours: Behaviour[] = ir.behaviours.map((behaviour) =>
    scaleBehaviour(behaviour, factorFor(behaviour.nodeId)),
  );

  return ok({ ...ir, tracks, behaviours });
}

function roleByNode(ir: AnimationIR): ReadonlyMap<string, string> {
  return new Map(ir.nodes.map((node) => [node.id, node.name]));
}

/**
 * One scale factor per animated role: the target's yardstick over the source's.
 *
 * Computed up front, so a clip that cannot be measured fails once - before anything has
 * been rewritten - rather than producing a half-scaled document that looks plausible
 * and reads wrong.
 *
 * An unmeasurable role is only fatal when the clip actually **drives** it. A record on a
 * role the target does not have, which nothing evaluates, is inert data; rejecting the
 * whole clip over it would fail exactly the case the library exists to serve - a rig
 * that has most of a template's bones.
 */
function scaleByRole(
  ir: AnimationIR,
  source: RigSignature,
  target: RigSignature,
): Result<ReadonlyMap<string, number>, AppError> {
  const driven = new Set(clipDrivenRoles(ir));
  const scales = new Map<string, number>();

  for (const role of clipAnimatedRoles(ir)) {
    const from = frameLengthOf(source, role);
    const to = frameLengthOf(target, role);

    if (from !== undefined && to !== undefined && from > 0) {
      scales.set(role, to / from);
      continue;
    }

    if (!driven.has(role)) continue;

    const sourceMeasurable = from !== undefined && from > 0;
    const side = sourceMeasurable ? 'target' : 'source';
    const reason =
      from !== undefined && from <= 0
        ? 'has no measurable proportion for it, so there is nothing to rescale from'
        : 'does not have it';
    return err(
      new ValidationError({
        message: `Clip drives role "${role}", and the ${side} skeleton ${reason}`,
        context: { role, side },
      }),
    );
  }

  return ok(scales);
}

// ── behaviours ──────────────────────────────────────────────────────────────

/**
 * Rescales the length-valued parameters of one behaviour.
 *
 * A `switch` with `assertNever`, matching `dispatch` in `behaviours.ts`: the union is
 * closed and every member must state whether it carries a distance. Ten of the thirteen
 * do not, and that is not laziness - `amplitudeDeg`, `hz`, `stiffness`, `gustiness` and
 * the rest are angles, rates and normalised weights, none of which change with the size
 * of the figure.
 *
 * `follow-path` is the interesting abstention. Its path is SVG data in **scene** space,
 * describing where in the shot the node travels; a taller character walks the same path
 * across the same courtyard. Scaling it would move the destination.
 */
export function scaleBehaviour(behaviour: Behaviour, scale: number): Behaviour {
  switch (behaviour.kind) {
    case 'walk-cycle':
      // The one parameter in the whole behaviour set that is a distance, and the one
      // that produces foot slide when it is wrong.
      return { ...behaviour, strideLength: behaviour.strideLength * scale };
    case 'orbit':
      return {
        ...behaviour,
        centre: scaleVec(behaviour.centre, scale),
        radius: scaleVec(behaviour.radius, scale),
      };
    case 'wind':
    case 'breathe':
    case 'blink':
    case 'sway':
    case 'flap':
    case 'parallax':
    case 'boil':
    case 'spring':
    case 'look-at':
    case 'follow-path':
    case 'lip-sync':
      return behaviour;
    default:
      return assertNever(behaviour, 'behaviour kind');
  }
}

function scaleVec(vector: Vec2, scale: number): Vec2 {
  return { x: vector.x * scale, y: vector.y * scale };
}
