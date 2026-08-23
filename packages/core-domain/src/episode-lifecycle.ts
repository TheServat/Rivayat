/**
 * The episode lifecycle, and the canon freeze at the end of it.
 *
 * `draft → outlined → scripted → boarded → asset-resolved → choreographed → rendered
 * → aired`, with one step back at each stage as the edit/invalidation signal.
 *
 * `aired` is terminal and that is the point: facts an aired episode asserted become
 * immutable canon. Later episodes may *extend* them or *reveal* something previously
 * hidden, but may not contradict them (CLAUDE.md non-negotiable #7). Making the state
 * terminal in the transition table is what stops that being a convention someone
 * forgets.
 */

import { ConflictError, at, type Result, err, ok } from '@rv/shared-kernel';
import { EPISODE_STATUSES, EPISODE_STATUS_TRANSITIONS, type EpisodeStatus } from '@rv/contracts';

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: readonly EpisodeStatus[] = EPISODE_STATUSES.filter(
  (status) => EPISODE_STATUS_TRANSITIONS[status].length === 0,
);

export function isTerminal(status: EpisodeStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: EpisodeStatus, to: EpisodeStatus): boolean {
  return EPISODE_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Attempts a transition.
 *
 * Returns a `Result` rather than throwing: an illegal transition is a user action the
 * UI has to explain, not a programmer error.
 */
export function transition(
  from: EpisodeStatus,
  to: EpisodeStatus,
): Result<EpisodeStatus, ConflictError> {
  if (from === to) {
    return err(
      new ConflictError({
        message: `Episode is already "${from}"`,
        context: { from, to },
      }),
    );
  }
  if (!canTransition(from, to)) {
    const legal = EPISODE_STATUS_TRANSITIONS[from];
    return err(
      new ConflictError({
        message:
          legal.length === 0
            ? `"${from}" is terminal; no transition is possible`
            : `Cannot go from "${from}" to "${to}". Legal next states: ${legal.join(', ')}`,
        context: { from, to, legal },
      }),
    );
  }
  return ok(to);
}

/**
 * The shortest legal route between two states, if one exists.
 *
 * The UI uses it to answer "what has to happen before this episode can air", and the
 * orchestrator uses it to decide which stages a re-run must cover.
 */
export function pathBetween(
  from: EpisodeStatus,
  to: EpisodeStatus,
): readonly EpisodeStatus[] | undefined {
  if (from === to) return [from];

  const queue: EpisodeStatus[][] = [[from]];
  const visited = new Set<EpisodeStatus>([from]);

  // Index-based rather than `shift()`: both `shift()` and `arr[len - 1]` are
  // `T | undefined` under `noUncheckedIndexedAccess`, and guarding for a case that
  // cannot happen leaves an untestable branch behind.
  for (let head = 0; head < queue.length; head += 1) {
    const path = at(queue, head);
    const tail = at(path, path.length - 1);

    for (const next of EPISODE_STATUS_TRANSITIONS[tail]) {
      if (visited.has(next)) continue;
      const extended = [...path, next];
      if (next === to) return extended;
      visited.add(next);
      queue.push(extended);
    }
  }

  return undefined;
}

/**
 * Whether the episode's asserted facts are frozen.
 *
 * The continuity checker consults this before allowing a later episode to assert
 * anything that would contradict it.
 */
export function isCanonFrozen(status: EpisodeStatus): boolean {
  return status === 'aired';
}

/**
 * Stages that a change at `status` invalidates.
 *
 * Editing the script does not require re-deriving the style, but it does invalidate
 * the board and everything after it. This is what lets an edit re-run only the
 * downstream stages instead of the whole pipeline.
 */
export function invalidatedBy(status: EpisodeStatus): readonly EpisodeStatus[] {
  const index = EPISODE_STATUSES.indexOf(status);
  if (index < 0) return [];
  return EPISODE_STATUSES.slice(index + 1);
}
