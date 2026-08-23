/**
 * The gate in front of `AIRED`.
 *
 * `aired` is the one terminal state in the episode lifecycle, and it is terminal because
 * the facts an aired episode asserted become immutable canon (CLAUDE.md #7). There is no
 * transition out of it and no supported way to edit what it said, so everything that has
 * to be true has to be true *here*.
 *
 * The rule is one line and deliberately not a judgement call: an `error` blocks, a
 * `warning` does not. Warnings are attached to the episode record rather than discarded -
 * a note about tone drift is still worth having next to the aired episode, and throwing
 * it away is how the same drift happens again next season.
 */

import { type Clock, ConflictError, type Result, err, isErr, ok, toIso } from '@rv/shared-kernel';
import { transition } from '@rv/core-domain';
import {
  blocksAiring,
  type ContinuityIssue,
  type EpisodeId,
  type EpisodeStatus,
} from '@rv/contracts';

export interface AirEpisodeInput {
  readonly episodeId: EpisodeId;
  readonly status: EpisodeStatus;
  readonly issues: readonly ContinuityIssue[];
}

export interface AiredEpisode {
  readonly episodeId: EpisodeId;
  readonly status: EpisodeStatus;
  readonly airedAt: string;
  /** Kept, not dropped: an unblocking finding is still a finding. */
  readonly warnings: readonly ContinuityIssue[];
}

export interface AirEpisodeDeps {
  readonly clock: Clock;
}

export class AirEpisodeUseCase {
  readonly #clock: Clock;

  constructor(deps: AirEpisodeDeps) {
    this.#clock = deps.clock;
  }

  execute(input: AirEpisodeInput): Result<AiredEpisode, ConflictError> {
    const blocking = input.issues.filter(blocksAiring);
    if (blocking.length > 0) {
      // Returned before the lifecycle transition is even attempted, so the episode is
      // observably still in the state it was in. `context` names the findings rather
      // than describing them: the caller has the issues and needs to know which ones.
      return err(
        new ConflictError({
          message: `Episode cannot air: ${String(blocking.length)} continuity error(s) block it.`,
          context: {
            reason: 'continuity-blocked',
            episodeId: input.episodeId,
            issueIds: blocking.map((issue) => issue.id),
            rules: [...new Set(blocking.map((issue) => issue.rule))],
          },
        }),
      );
    }

    const moved = transition(input.status, 'aired');
    if (isErr(moved)) return moved;

    return ok({
      episodeId: input.episodeId,
      status: moved.value,
      airedAt: toIso(this.#clock.now()),
      warnings: input.issues.filter((issue) => !blocksAiring(issue)),
    });
  }
}
