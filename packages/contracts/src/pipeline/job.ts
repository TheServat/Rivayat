/**
 * `PipelineJob` - one unit of work inside a run.
 *
 * A run is the thing a person started; a job is the thing a worker picked up. The
 * distinction is not bureaucracy: S6 Produce is one stage and forty image generations,
 * each of which can fail, retry and cost money on its own, and a run-level record
 * cannot say which of the forty burned the budget.
 *
 * ## Why `payload` is opaque
 *
 * Every stage's request has a different shape, and this schema deliberately does not
 * enumerate them. A discriminated union over twelve stage payloads would make this file
 * depend on every artefact schema in the package, and would mean a new stage cannot be
 * added without editing the job contract - the exact coupling the pluggable-stage
 * design exists to avoid. Storage came to the same conclusion independently and put a
 * `payload` document on its `jobs` table.
 *
 * The consequence is stated rather than hidden: `payload` is validated by the stage
 * that owns it, not here. `RenderJob` is the worked example - it fits inside a
 * `PipelineJob` byte-for-byte, unchanged, and `seams.spec.ts` asserts it.
 *
 * What is *not* opaque is everything the scheduler, the budget guard and the operator
 * need: which run, which stage, what state, how many attempts, what it read, what it
 * produced, how long it took and what it cost. Those are columns, because those are the
 * questions asked without opening the payload.
 */

import { z } from 'zod';

import {
  IsoInstant,
  Millis,
  NanoUsdAmount,
  NonEmptyString,
  PositiveInt,
} from '../primitives/common';
import { JobId, RunId } from '../primitives/ids';
import { ArtifactRef, PipelineStage, PipelineStatus, isStoppedStatus } from './stage';

/**
 * One unit of work inside a run.
 *
 * `attempt` and `maxAttempts` sit on the job rather than in the queue's own retry
 * config for the same reason the state machine does: a replayed run has to reproduce
 * what happened, and "it succeeded on the third try" is part of what happened. It is
 * also the only place the cost of the two failed tries can be attributed - a retry that
 * burned input tokens spent real money, and a ledger that only counts the successful
 * attempt under-reports every bad run.
 */
export const PipelineJob = z
  .strictObject({
    id: JobId,
    runId: RunId,
    stage: PipelineStage.describe('Which stage of the run this job belongs to.'),
    status: PipelineStatus,

    attempt: PositiveInt.max(100)
      .default(1)
      .describe('1 on the first try. Raised, not reset, when a failed job is re-queued.'),
    maxAttempts: PositiveInt.max(100)
      .default(3)
      .describe('Attempts before the job stops being re-queued and the run fails with it.'),

    inputs: z
      .array(ArtifactRef)
      .max(4096)
      .default([])
      .describe(
        'What this job reads. Hashed together, these are what a `StageCheckpoint.inputHash` covers, which is how "already ran on this" is decided.',
      ),
    outputs: z
      .array(ArtifactRef)
      .max(4096)
      .default([])
      .describe('What it produced. Empty until it succeeds; a failed job may still have written.'),
    payload: z
      .record(z.string(), z.unknown())
      .default({})
      .describe(
        "The stage's own request document, validated by the stage that owns it and opaque here. A `RenderJob` lives in this field unchanged.",
      ),

    queuedAt: IsoInstant.describe('When it was enqueued. Present from the moment it exists.'),
    startedAt: IsoInstant.nullable()
      .default(null)
      .describe('When a worker picked it up. `null` while it is still queued.'),
    finishedAt: IsoInstant.nullable()
      .default(null)
      .describe('When it reached a terminal state. `null` while it still might do something.'),
    durationMs: Millis.nullable()
      .default(null)
      .describe(
        'Measured wall time of the work itself. Recorded rather than derived from the two instants above, which include time spent paused.',
      ),
    costNanoUsd: NanoUsdAmount.default(0).describe(
      'What this attempt and every earlier one cost together. A retry adds to it; it never resets.',
    ),
    errorCode: NonEmptyString.max(80)
      .nullable()
      .default(null)
      .describe('`AppError.code` when `status` is `failed`.'),
  })
  .superRefine((job, ctx) => {
    // The same invariant `RenderJob`, `StructuredCallOutcome` and `PipelineRun` enforce.
    // It should not depend on which file the failure landed in.
    if (job.status === 'failed' && job.errorCode === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'a failed job must carry an error code',
      });
    }

    // A job that finished without ever starting is a timeline nobody can read, and it
    // breaks the one arithmetic anyone does with these fields - queue latency is
    // `startedAt - queuedAt` and work time is `finishedAt - startedAt`. A *cancelled*
    // job is the case that makes this worth checking rather than assuming: cancelling a
    // queued job is legal, and it must clear the queue rather than pretend it ran.
    if (job.finishedAt !== null && job.startedAt === null && job.status !== 'cancelled') {
      ctx.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: `a ${job.status} job finished without ever starting`,
      });
    }
    if (
      job.finishedAt !== null &&
      job.startedAt !== null &&
      Date.parse(job.finishedAt) < Date.parse(job.startedAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'finishedAt must not precede startedAt',
      });
    }
    if (isStoppedStatus(job.status) && job.finishedAt === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: `a ${job.status} job has stopped and must record when`,
      });
    }

    // The retry budget is what stops a poisoned job from re-queueing forever. A job
    // already past it is one nothing will ever schedule and nothing will ever fail -
    // it just sits in the queue table looking runnable.
    if (job.attempt > job.maxAttempts) {
      ctx.addIssue({
        code: 'custom',
        path: ['attempt'],
        message: `attempt ${String(job.attempt)} is past the retry budget of ${String(job.maxAttempts)}`,
      });
    }
  });
export type PipelineJob = z.infer<typeof PipelineJob>;
