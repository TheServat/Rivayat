/**
 * DOME: re-plan the episodes that have not aired, and refuse the ones that have.
 *
 * Prior-art §B takes "dynamic hierarchical outlining with memory enhancement" from DOME
 * and pairs it with CLAUDE.md non-negotiable #7. The two together are the whole feature:
 * the plan for the future is *supposed* to change as the series discovers what it is
 * about, and the past is not. An outline that cannot be revised produces a season that
 * ignores everything it learned in episode two; an outline that can revise anything
 * produces a series whose third episode quietly stops being what the audience watched.
 *
 * `isCanonFrozen` from `@rv/core-domain` is the single arbiter. It is not re-derived here
 * from a status comparison, because a second copy of "aired means frozen" is a second
 * place for it to become false.
 *
 * The refusal is deliberately *total*: asking to re-plan a batch that includes an aired
 * episode fails the whole batch rather than silently revising the rest. A partial success
 * here reads to a caller as "it worked", and the episode they most wanted changed is the
 * one that did not.
 */

import type { EpisodeId, EpisodeStatus, EpisodeSummary, OpenLoop } from '@rv/contracts';
import { PromptTemplate, type StructuredTrace } from '@rv/prompt-kit';
import { isCanonFrozen } from '@rv/core-domain';
import {
  type AppError,
  ConflictError,
  NotFoundError,
  type Result,
  ValidationError,
  err,
  isErr,
  must,
  ok,
} from '@rv/shared-kernel';
import { z } from 'zod';
import { Label, PositiveInt, Prose } from '@rv/contracts';

import { SCREENWRITER } from '../roles/index';
import { bulletList, orElse } from '../support/format';
import { type StoryEngineDeps, runRoleCall } from '../support/stage-call';
import { type OutlineContext, renderOutlineContext } from './context';

/** One episode as the planner sees it: enough to revise, not enough to rewrite. */
export interface PlannedEpisode {
  readonly episodeId: EpisodeId;
  /** Position in the season, starting at 1. The handle the model quotes back. */
  readonly ordinal: number;
  readonly title: string;
  readonly status: EpisodeStatus;
  readonly logline: string;
  readonly plannedSummary: string | null;
}

export interface ReplanEpisodesInput {
  readonly context: OutlineContext;
  /** Every episode of the season, in airing order, aired ones included. */
  readonly episodes: readonly PlannedEpisode[];
  /** Which to revise. Every one must be present in `episodes` and none may have aired. */
  readonly targetEpisodeIds: readonly EpisodeId[];
  /** What the series has learned since the plan was written. The "memory" in DOME. */
  readonly memory?: readonly EpisodeSummary[];
  /** Promises the series owes. An unpaid loop is the most useful thing to re-plan around. */
  readonly openLoops?: readonly OpenLoop[];
  /** Why this re-plan is happening. Goes into the prompt and into the change record. */
  readonly reason: string;
  readonly signal?: AbortSignal;
}

/**
 * One revised episode, addressed by ordinal.
 *
 * By ordinal and not by id, for the reason `AssetInstanceKey` is a slug: asking a model to
 * re-quote a ULID across a structured response reliably produces one that nearly matches,
 * and "nearly" here means revising the wrong episode.
 */
export const EpisodeRevision = z.strictObject({
  episodeOrdinal: PositiveInt.describe(
    'Which episode this revises, by its position in the season.',
  ),
  title: Label,
  plannedSummary: Prose.describe(
    'The revised instruction for this episode: what it must accomplish, written for whoever ' +
      'expands it into acts.',
  ),
  logline: Prose.describe('One sentence: who wants what, and what is in the way, this episode.'),
  changeNote: Prose.describe(
    'What changed from the previous plan and which piece of new memory caused it. "General ' +
      'improvement" is not a reason to rewrite a plan.',
  ),
  paysOffLoops: z
    .array(
      z.strictObject({
        loopSetup: Prose.describe('The promise being paid, quoted from the open-loop list.'),
        note: Prose.describe('How this episode discharges it.'),
      }),
    )
    .max(12)
    .default([])
    .describe('Open loops this revised episode now schedules a pay-off for.'),
});
export type EpisodeRevision = z.infer<typeof EpisodeRevision>;

export const ReplanDraft = z.strictObject({
  rationale: Prose.describe(
    'One paragraph: what the series now knows that it did not when this plan was written.',
  ),
  revisions: z
    .array(EpisodeRevision)
    .min(1)
    .max(64)
    .describe('One entry per episode you are revising. Do not include episodes you left alone.'),
});
export type ReplanDraft = z.infer<typeof ReplanDraft>;

/** A revision with its ordinal resolved back to the episode it belongs to. */
export interface AppliedRevision extends EpisodeRevision {
  readonly episodeId: EpisodeId;
  /** What the plan said before. Kept so the change is a diff, not an overwrite. */
  readonly previousPlannedSummary: string | null;
}

export interface ReplanResult {
  readonly rationale: string;
  readonly revisions: readonly AppliedRevision[];
  /** Episodes shown to the planner as immutable canon. Never in `revisions`. */
  readonly frozenEpisodeIds: readonly EpisodeId[];
  readonly trace: StructuredTrace;
}

const REPLAN_PROMPT = new PromptTemplate<{
  readonly seriesContext: string;
  readonly airedSoFar: string;
  readonly memory: string;
  readonly openLoops: string;
  readonly revisable: string;
  readonly reason: string;
}>(
  'outline.replan',
  [
    '{{seriesContext}}',
    '',
    '## What has aired - fixed, and not yours to change',
    'These episodes are canon. You may build on them and you may reveal that something in',
    'them meant more than it appeared to. You may not contradict them, and you may not',
    'return a revision for any of them.',
    '',
    '{{airedSoFar}}',
    '',
    '## What the series has learned since the plan was written',
    '{{memory}}',
    '',
    '## Promises the series owes the audience',
    '{{openLoops}}',
    '',
    '## The episodes you may revise',
    '{{revisable}}',
    '',
    '## Why you are re-planning',
    '{{reason}}',
    '',
    'Revise only the episodes listed as revisable, and only where the new material gives you',
    'a reason. Returning an episode unchanged is worse than omitting it: it records a',
    'decision that was never made. Where an unpaid promise can now land, schedule it and say',
    'which episode pays it.',
  ].join('\n'),
);

export class ReplanEpisodesUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(input: ReplanEpisodesInput): Promise<Result<ReplanResult, AppError>> {
    if (input.targetEpisodeIds.length === 0) {
      return err(
        new ValidationError({
          message: 'Re-planning needs at least one target episode',
          context: { reason: 'no-targets' },
        }),
      );
    }

    const byId = new Map(input.episodes.map((episode) => [episode.episodeId, episode]));

    const missing = input.targetEpisodeIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return err(new NotFoundError('episode', missing.join(', ')));
    }

    // `must` rather than a cast: the `missing` check above already proved every id
    // resolves, and a cast would keep proving it if that check were ever removed.
    const targets = input.targetEpisodeIds.map((id) => must(byId, id, 'episode'));

    // The refusal that non-negotiable #7 exists for. Reported with every offender named,
    // because a user who asked to re-plan a season wants the whole list, not the first one.
    const frozenTargets = targets.filter((episode) => isCanonFrozen(episode.status));
    if (frozenTargets.length > 0) {
      return err(
        new ConflictError({
          message:
            `Cannot re-plan ${String(frozenTargets.length)} episode(s) whose canon is frozen: ` +
            frozenTargets
              .map((episode) => `${String(episode.ordinal)} "${episode.title}"`)
              .join(', ') +
            '. An aired episode may be extended or revealed, never re-planned.',
          context: {
            reason: 'canon-frozen',
            episodeIds: frozenTargets.map((episode) => episode.episodeId),
            ordinals: frozenTargets.map((episode) => episode.ordinal),
          },
        }),
      );
    }

    const aired = input.episodes.filter((episode) => isCanonFrozen(episode.status));
    const targetOrdinals = new Set(targets.map((episode) => episode.ordinal));

    const outcome = await runRoleCall<ReplanDraft>(this.#deps, {
      role: SCREENWRITER,
      schemaName: 'ReplanDraft',
      schema: ReplanDraft,
      user: REPLAN_PROMPT.render({
        seriesContext: renderOutlineContext(input.context),
        airedSoFar: bulletList(aired.map(describeEpisode), 'nothing has aired yet'),
        memory: bulletList(
          (input.memory ?? []).map(describeMemory),
          'no episode summaries have accumulated yet',
        ),
        openLoops: bulletList(
          (input.openLoops ?? []).filter((loop) => loop.status === 'open').map(describeLoop),
          'no unpaid promises',
        ),
        revisable: bulletList(targets.map(describeEpisode)),
        reason: input.reason,
      }).text,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (isErr(outcome)) return outcome;

    const applied: AppliedRevision[] = [];
    const byOrdinal = new Map(input.episodes.map((episode) => [episode.ordinal, episode]));

    for (const revision of outcome.value.value.revisions) {
      const episode = byOrdinal.get(revision.episodeOrdinal);
      if (episode === undefined) {
        return err(
          new ValidationError({
            message: `Re-plan returned a revision for episode ${String(revision.episodeOrdinal)}, which is not in this season`,
            context: { reason: 'unknown-episode-ordinal', ordinal: revision.episodeOrdinal },
          }),
        );
      }
      // A revision aimed at an aired episode is the failure this use-case exists to stop,
      // and it can arrive from the model as easily as from the caller. Same refusal.
      if (isCanonFrozen(episode.status)) {
        return err(
          new ConflictError({
            message: `Re-plan tried to revise aired episode ${String(episode.ordinal)} "${episode.title}"`,
            context: {
              reason: 'canon-frozen',
              episodeIds: [episode.episodeId],
              ordinals: [episode.ordinal],
            },
          }),
        );
      }
      if (!targetOrdinals.has(episode.ordinal)) {
        return err(
          new ValidationError({
            message: `Re-plan revised episode ${String(episode.ordinal)}, which was not asked for`,
            context: { reason: 'episode-not-targeted', ordinal: episode.ordinal },
          }),
        );
      }

      applied.push({
        ...revision,
        episodeId: episode.episodeId,
        previousPlannedSummary: episode.plannedSummary,
      });
    }

    return ok({
      rationale: outcome.value.value.rationale,
      revisions: applied,
      frozenEpisodeIds: aired.map((episode) => episode.episodeId),
      trace: outcome.value.trace,
    });
  }
}

function describeEpisode(episode: PlannedEpisode): string {
  return `Episode ${String(episode.ordinal)} "${episode.title}" [${episode.status}] - ${episode.logline}\n  Planned: ${orElse(episode.plannedSummary, 'no instruction recorded')}`;
}

function describeMemory(summary: EpisodeSummary): string {
  return `Episode ${String(summary.index + 1)} "${summary.title}"${summary.canonFrozen ? ' (aired)' : ''}: ${summary.synopsis}`;
}

function describeLoop(loop: OpenLoop): string {
  return `${loop.promise} (planted: ${loop.setup}; urgency ${loop.urgency.toFixed(2)})`;
}
