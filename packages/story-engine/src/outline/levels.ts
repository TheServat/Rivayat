/**
 * The seven levels of the story tree, and the rule that you descend them one at a time.
 *
 * DOC (prior-art §B) is a single idea applied without exception: expand exactly one level
 * and bind the expansion to what its parent asked for. The failure it prevents is
 * specific and easy to reproduce - ask a model for "the scenes of this series" and it
 * writes twelve good scenes for episode one and forgets the antagonist by episode seven,
 * because nothing in between ever said what episode seven was *for*.
 *
 * The ordering here is the same as `Series → Season → Episode → Act → Sequence → Scene →
 * Beat` in docs/02 §1 and in `@rv/contracts/story/story-bible`. It is declared as an
 * array rather than a graph because the hierarchy is a chain: every level has exactly one
 * parent level and at most one child level, and encoding that as a lookup table is what
 * makes "skipping a level" a thing the code can detect rather than a thing a reviewer has
 * to notice.
 */

import { ValidationError } from '@rv/shared-kernel';

export const OUTLINE_LEVELS = [
  'series',
  'season',
  'episode',
  'act',
  'sequence',
  'scene',
  'beat',
] as const;

export type OutlineLevel = (typeof OUTLINE_LEVELS)[number];

/** The level immediately below, or `undefined` at the leaf. */
export function childLevelOf(level: OutlineLevel): OutlineLevel | undefined {
  return OUTLINE_LEVELS[OUTLINE_LEVELS.indexOf(level) + 1];
}

/** The level immediately above, or `undefined` at the root. */
export function parentLevelOf(level: OutlineLevel): OutlineLevel | undefined {
  const index = OUTLINE_LEVELS.indexOf(level);
  return index <= 0 ? undefined : OUTLINE_LEVELS[index - 1];
}

/**
 * How many levels apart two levels are. Negative when `to` is above `from`.
 *
 * The number the error message needs: "you asked to jump 3 levels" is actionable and
 * "invalid target level" is not.
 */
export function levelDistance(from: OutlineLevel, to: OutlineLevel): number {
  return OUTLINE_LEVELS.indexOf(to) - OUTLINE_LEVELS.indexOf(from);
}

/**
 * The guard every expansion passes through.
 *
 * Returns the error rather than throwing, because asking for the wrong level is a caller
 * mistake the UI has to explain - it is what happens when someone clicks "generate
 * scenes" on a season - not a programmer error.
 */
export function checkSingleLevelDescent(
  parent: OutlineLevel,
  target: OutlineLevel,
): ValidationError | undefined {
  const expected = childLevelOf(parent);
  if (expected === undefined) {
    return new ValidationError({
      message: `Nothing exists below "${parent}"; it is the leaf of the story tree`,
      context: { parentLevel: parent, targetLevel: target, reason: 'no-child-level' },
    });
  }
  if (target === expected) return undefined;

  const distance = levelDistance(parent, target);
  return new ValidationError({
    message:
      distance > 1
        ? `Expansion may descend one level at a time: "${parent}" expands to "${expected}", not "${target}" (${String(distance)} levels down)`
        : `"${target}" is not below "${parent}"; the only legal expansion is "${expected}"`,
    context: {
      parentLevel: parent,
      targetLevel: target,
      expectedLevel: expected,
      distance,
      reason: 'outline-level-skip',
    },
  });
}
