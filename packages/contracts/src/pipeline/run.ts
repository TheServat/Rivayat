/**
 * `PipelineRun` - one execution of the pipeline over one episode, and what it needs to
 * be picked up again after it stops.
 *
 * `RunId` was in the id registry and `UsageRecord`/`RenderJob` both pointed at it, and
 * nothing said what a run *is*. Storage had to invent a thin lifecycle table with a
 * `payload` document, which works right up to the point where something has to answer
 * "can this run be resumed, and from where?" - because the answer lives in the payload,
 * unvalidated, in whatever shape the last writer chose.
 *
 * Architecture Â§4 demands four properties of every stage: idempotent, cached,
 * resumable, cancellable. Three of them need durable state that the queue does not
 * have, and this file is that state:
 *
 * | property    | what carries it                                                  |
 * |-------------|-------------------------------------------------------------------|
 * | cached      | `StageCheckpoint.inputHash` - "already ran" is not enough; "already ran *on this*" is |
 * | resumable   | `checkpoints` + {@link remainingStages} - the skip list, computed, not guessed |
 * | cancellable | `status` and `PIPELINE_STATUS_TRANSITIONS` - a cancelled run is a state, not the absence of a worker |
 *
 * Idempotence is the stage implementation's job; the other three are data, and they are
 * here.
 */

import { z } from 'zod';

import {
  IsoInstant,
  NanoUsdAmount,
  NonEmptyString,
  NonNegativeInt,
  Prose,
  Sha256Hex,
} from '../primitives/common';
import { EpisodeId, JobId, ProjectId, RunId, SeriesId } from '../primitives/ids';
import {
  ArtifactRef,
  PIPELINE_STAGES,
  PipelineStage,
  PipelineStatus,
  isStoppedStatus,
  pipelineStageIndex,
} from './stage';

// â”€â”€ the resume point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * One finished stage, recorded so the next run does not repeat it.
 *
 * The three fields that matter are `stage`, `inputHash` and `outputs`, and they answer
 * the three questions a resumed run asks in order: what has already run, was it run on
 * the same thing, and where is what it produced. Drop `inputHash` and a resumed run
 * happily skips a stage whose inputs the author edited in between - which is exactly
 * the "editing re-runs only the downstream stages that depend on it" promise in
 * architecture Â§4, broken silently and in the direction nobody checks.
 *
 * `costNanoUsd` is here rather than only in the ledger because a resumed run has to
 * report what the *whole* run cost, including the part it did not re-run, and summing
 * the ledger would count a re-run stage twice.
 */
export const StageCheckpoint = z.strictObject({
  stage: PipelineStage,
  inputHash: Sha256Hex.describe(
    'Hash of everything this stage consumed. A resumed run re-runs the stage when this no longer matches, and skips it when it does. This is the whole of "cached".',
  ),
  outputs: z
    .array(ArtifactRef)
    .max(4096)
    .default([])
    .describe('What the stage produced, so the next stage can start without re-running it.'),
  jobIds: z
    .array(JobId)
    .max(4096)
    .default([])
    .describe('The jobs that did the work. Kept so a completed stage can still be audited.'),
  costNanoUsd: NanoUsdAmount.default(0).describe(
    'What this stage cost. Carried on the checkpoint so a resumed run can report the true total of a run it only partly executed.',
  ),
  completedAt: IsoInstant,
});
export type StageCheckpoint = z.infer<typeof StageCheckpoint>;

// â”€â”€ failure â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Why a run stopped, in the form the person who has to fix it needs.
 *
 * A bare error code would be enough to retry and useless to diagnose: the first
 * question about a failed twelve-stage run is always *which stage*, and the second is
 * which job inside it. Both are here so neither needs a scan of the job table.
 */
export const PipelineError = z.strictObject({
  code: NonEmptyString.max(80).describe('`AppError.code`. What a retry policy switches on.'),
  message: Prose.describe('What went wrong, for a human. Never the only field - see `code`.'),
  stage: PipelineStage.describe('The stage that failed. The first question anyone asks.'),
  jobId: JobId.nullable()
    .default(null)
    .describe('The job that failed, when one did. `null` for a failure between jobs.'),
  at: IsoInstant,
});
export type PipelineError = z.infer<typeof PipelineError>;

// â”€â”€ the run â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * One execution of some or all of the pipeline.
 *
 * `requestedStages` is a list rather than a from/to pair because the set genuinely is
 * arbitrary: "re-render and re-deliver" is S10 + S11, "restyle" is S1 + S6 onward, and
 * a preview run stops at S9. It is required to be in pipeline order and free of
 * repeats, because a run that asks for `render` before `story` is not a pipeline and
 * the scheduler would be entitled to either interpretation.
 *
 * `seed` is not optional and has no default. Non-negotiable #1 makes runs replayable,
 * and a run that cannot name the seed it fed `createRng` cannot be replayed - so the
 * schema refuses to describe one.
 */
export const PipelineRun = z
  .strictObject({
    id: RunId,
    projectId: ProjectId,
    seriesId: SeriesId,
    episodeId: EpisodeId.nullable()
      .default(null)
      .describe(
        'The episode this run is for. `null` for work that belongs to no single episode - a style probe, a series-wide re-index.',
      ),

    requestedStages: z
      .array(PipelineStage)
      .min(1)
      .max(PIPELINE_STAGES.length)
      .describe(
        'The stages this run was asked to execute, in pipeline order, no repeats. Not necessarily contiguous: "re-render and deliver" is a legitimate two-stage run.',
      ),
    currentStage: PipelineStage.nullable()
      .default(null)
      .describe(
        'The stage executing right now. `null` before the first one starts and once the last one has finished.',
      ),
    status: PipelineStatus,
    checkpoints: z
      .array(StageCheckpoint)
      .max(PIPELINE_STAGES.length)
      .default([])
      .describe(
        'One entry per stage already finished. This is the skip list a resumed run reads; see `remainingStages`.',
      ),

    seed: NonNegativeInt.describe(
      'Seed for every deterministic decision in the run. Required: a run that cannot name its seed cannot be replayed, and non-negotiable #1 says every run must be.',
    ),
    budgetNanoUsd: NanoUsdAmount.nullable()
      .default(null)
      .describe('Ceiling for this run. `null` means the project or workspace policy applies.'),
    spentNanoUsd: NanoUsdAmount.default(0).describe(
      'Spent so far, summed from the ledger and denormalised here so the budget guard is one read rather than an aggregate.',
    ),

    startedAt: IsoInstant,
    finishedAt: IsoInstant.nullable()
      .default(null)
      .describe('When it reached a terminal state. `null` while it still might do something.'),
    error: PipelineError.nullable()
      .default(null)
      .describe('Why it failed. `null` for every other status.'),
  })
  .superRefine((run, ctx) => {
    // "In pipeline order, no repeats" is stated in the field description, and a
    // description is all the caller filling this in ever reads. An out-of-order list is
    // not a scheduling preference - it is two mutually exclusive claims about what the
    // pipeline is - and a repeated stage silently doubles that stage's cost estimate.
    //
    // Written as a fold over the previous position rather than as an indexed lookup:
    // `positions[i - 1]` is `number | undefined` under `noUncheckedIndexedAccess`, and
    // the `?? fallback` that satisfies it is a branch no input can ever take.
    let previous = -1;
    let ordered = true;
    for (const stage of run.requestedStages) {
      const position = pipelineStageIndex(stage);
      if (position <= previous) ordered = false;
      previous = position;
    }
    if (!ordered) {
      ctx.addIssue({
        code: 'custom',
        path: ['requestedStages'],
        message: `requestedStages must be in pipeline order with no repeats, got [${run.requestedStages.join(', ')}]`,
      });
    }

    const requested = new Set<string>(run.requestedStages);
    if (run.currentStage !== null && !requested.has(run.currentStage)) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentStage'],
        message: `currentStage ${run.currentStage} is not one of the stages this run requested`,
      });
    }

    // A checkpoint for a stage nobody asked for cannot be produced by this run, and a
    // stage checkpointed twice makes `remainingStages` ambiguous - which of the two
    // input hashes decides whether the stage is skipped?
    const seen = new Set<string>();
    run.checkpoints.forEach((checkpoint, index) => {
      if (!requested.has(checkpoint.stage)) {
        ctx.addIssue({
          code: 'custom',
          path: ['checkpoints', index, 'stage'],
          message: `checkpointed stage ${checkpoint.stage} was never requested by this run`,
        });
      }
      if (seen.has(checkpoint.stage)) {
        ctx.addIssue({
          code: 'custom',
          path: ['checkpoints', index, 'stage'],
          message: `stage ${checkpoint.stage} is checkpointed twice`,
        });
      }
      seen.add(checkpoint.stage);
    });

    // The same invariant `RenderJob` and `StructuredCallOutcome` already enforce, for
    // the same reason: a failure nobody can name is a failure nobody can route, retry
    // or report on.
    if (run.status === 'failed' && run.error === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'a failed run must say what failed and where',
      });
    }
    if (isStoppedStatus(run.status) && run.finishedAt === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: `a ${run.status} run has stopped and must record when`,
      });
    }
  });
export type PipelineRun = z.infer<typeof PipelineRun>;

/**
 * The stages a resumed run still has to execute.
 *
 * This is the whole of "resumable", and it is a function rather than a stored field
 * precisely so it cannot go stale: it is `requestedStages` minus everything
 * checkpointed, in pipeline order. A stored `remaining` list would be a second source
 * of truth that a crash between "write checkpoint" and "update remaining" leaves wrong,
 * and the symptom is a stage that runs twice and bills twice.
 *
 * Note what it does *not* do: it does not compare `inputHash`. Deciding that a
 * checkpointed stage is stale needs the current inputs, which only the caller has -
 * this answers "what was never done", and the caller adds "and what was done against
 * something that has since changed".
 */
export function remainingStages(run: PipelineRun): readonly PipelineStage[] {
  const done = new Set<string>(run.checkpoints.map((checkpoint) => checkpoint.stage));
  return run.requestedStages.filter((stage) => !done.has(stage));
}
