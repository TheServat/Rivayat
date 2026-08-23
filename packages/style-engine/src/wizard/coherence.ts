/**
 * Contradictions the schema cannot see.
 *
 * Zod validates each field against its own range. It cannot know that a line weight of
 * 0.8 on a style that has switched outlines off is not a style - it is two decisions
 * that were never reconciled, and it will produce an asset library where half the
 * assets have outlines because the prompt said one thing and the negative said another.
 *
 * Each check names **both** sides of the conflict in `context.fields`, because "your
 * style is inconsistent" is not actionable and "these two fields disagree" is. Tests
 * assert on that structured field rather than on the message text.
 */

import type { MotionStyle, VisualStyle } from '@rv/contracts';
import { type Result, UNIT, type Unit, ValidationError, err, ok } from '@rv/shared-kernel';

interface Conflict {
  readonly fields: readonly [string, string];
  readonly message: string;
}

/**
 * Every contradiction, checked in one pass.
 *
 * Reported one at a time rather than as a list: a caller fixing the first is very
 * likely to have introduced or resolved the rest, so a batch report is mostly stale by
 * the time it is read.
 */
export function checkStyleCoherence(
  visual: VisualStyle,
  motion: MotionStyle,
): Result<Unit, ValidationError> {
  const conflicts: Conflict[] = [];

  if (!visual.line.present && visual.line.weight > 0) {
    conflicts.push({
      fields: ['visual.line.present', 'visual.line.weight'],
      message: `Outlines are switched off but a weight of ${String(visual.line.weight)} is set; one of the two is stale.`,
    });
  }
  if (!visual.line.present && visual.line.colorMode !== 'none') {
    conflicts.push({
      fields: ['visual.line.present', 'visual.line.colorMode'],
      message: `Outlines are switched off but a colour mode of "${visual.line.colorMode}" is set for them.`,
    });
  }
  if (visual.shading.model === 'flat' && visual.shading.steps > 1) {
    conflicts.push({
      fields: ['visual.shading.model', 'visual.shading.steps'],
      message: `Flat shading has exactly one tone, but ${String(visual.shading.steps)} bands are requested.`,
    });
  }
  if (!motion.boil.enabled && motion.boil.amplitude > 0) {
    conflicts.push({
      fields: ['motion.boil.enabled', 'motion.boil.amplitude'],
      message: `Boil is disabled but an amplitude of ${String(motion.boil.amplitude)} is set; it will silently do nothing.`,
    });
  }
  if (motion.stepMode === 'on-4s' && motion.fps < 12) {
    conflicts.push({
      fields: ['motion.stepMode', 'motion.fps'],
      message: `Holding every drawing for four frames at ${String(motion.fps)} fps is under three drawings a second; that is a slideshow.`,
    });
  }

  const first = conflicts[0];
  if (first === undefined) return ok(UNIT);
  return err(
    new ValidationError({
      message: first.message,
      context: { fields: first.fields, conflicts: conflicts.map((conflict) => conflict.fields) },
    }),
  );
}
