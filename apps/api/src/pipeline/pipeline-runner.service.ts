/**
 * Turns a run request into queued work, and queued work into a finished run.
 *
 * One stage per job, next stage enqueued on completion. The alternative - one job that
 * loops through every stage - would make a crash lose the whole run and would make
 * cancellation a `if (cancelled) break` inside an eleven-step function. One job per
 * stage means the queue's own redelivery, retry and concurrency apply per stage, which
 * is what "every stage is idempotent, cached, resumable, cancellable" (architecture §4)
 * actually requires.
 *
 * Three responsibilities and nothing else: sequence the stages, keep the run record
 * truthful, and put every transition on the event stream. The work itself is in the
 * handlers, the money is in `MeteredCallRunner`, and the transport is in `JobQueue`.
 */

import {
  Ids,
  type NanoUsdAmount,
  type PipelineStageKey,
  type ProjectId,
  type RunId,
  type SeriesId,
} from '@rv/contracts';
import {
  ConflictError,
  NotFoundError,
  UNIT,
  type AppError,
  type Clock,
  type Logger,
  type Result,
  type Unit,
  err,
  isErr,
  ok,
  toIso,
} from '@rv/shared-kernel';

import type { RunRepository } from '../application/ports/repository.ports';
import { RunSummary, isTerminalRunStatus, type RunStatus } from '../application/resources';
import type { RunEventBus } from '../events/run-event-bus';
import type { JobQueue, QueuedJob } from '../queue/job-queue.port';
import type { StageRegistry } from './stage';

export interface StartRunRequest {
  readonly projectId: ProjectId;
  readonly seriesId: SeriesId | null;
  readonly stages: readonly PipelineStageKey[];
  readonly seed: number;
  readonly budgetNanoUsd: NanoUsdAmount | null;
  /** Whatever the first stage needs. Carried onto every job of the run. */
  readonly payload: Record<string, unknown>;
}

export interface PipelineRunnerDeps {
  readonly runs: RunRepository;
  readonly queue: JobQueue;
  readonly events: RunEventBus;
  readonly stages: StageRegistry;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly logger: Logger;
}

/** In-flight state that does not belong in the run record. */
interface InFlight {
  readonly controller: AbortController;
  readonly payload: Record<string, unknown>;
  startedAt: number;
}

export class PipelineRunner {
  readonly #runs: RunRepository;
  readonly #queue: JobQueue;
  readonly #events: RunEventBus;
  readonly #stages: StageRegistry;
  readonly #clock: Clock;
  readonly #ids: Ids;
  readonly #logger: Logger;
  readonly #inFlight = new Map<RunId, InFlight>();

  constructor(deps: PipelineRunnerDeps) {
    this.#runs = deps.runs;
    this.#queue = deps.queue;
    this.#events = deps.events;
    this.#stages = deps.stages;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#logger = deps.logger.child({ component: 'pipeline' });

    this.#queue.setHandler((job) => this.#handle(job));
  }

  /** Stages this build can actually execute. Reported by `/api/health`. */
  implementedStages(): readonly PipelineStageKey[] {
    return [...this.#stages.keys()];
  }

  /**
   * Creates the run and enqueues its first stage.
   *
   * The run record is written *before* the job is enqueued, so a crash between the two
   * leaves a queued run with no worker - visible, resumable - rather than a job
   * referring to a run that does not exist.
   */
  async start(request: StartRunRequest): Promise<Result<RunSummary, AppError>> {
    const first = request.stages[0];
    if (first === undefined) {
      return err(
        new ConflictError({
          message: 'A run must request at least one stage',
          context: { projectId: request.projectId },
        }),
      );
    }

    const now = toIso(this.#clock.now());
    const parsed = RunSummary.safeParse({
      id: this.#ids.run(),
      projectId: request.projectId,
      seriesId: request.seriesId,
      status: 'queued' satisfies RunStatus,
      requestedStages: request.stages,
      currentStage: null,
      stages: [],
      seed: request.seed,
      budgetNanoUsd: request.budgetNanoUsd,
      spentNanoUsd: 0,
      errorCode: null,
      startedAt: now,
      finishedAt: null,
    });
    if (!parsed.success) {
      return err(
        new ConflictError({
          message: 'The run request does not describe a valid run',
          context: { issues: parsed.error.issues.map((issue) => issue.message) },
        }),
      );
    }

    const created = await this.#runs.create(parsed.data);
    if (isErr(created)) return created;

    this.#inFlight.set(created.value.id, {
      controller: new AbortController(),
      payload: request.payload,
      startedAt: this.#clock.now(),
    });

    const enqueued = await this.#enqueue(created.value.id, first, request.payload);
    if (isErr(enqueued)) return enqueued;

    return ok(created.value);
  }

  /**
   * Stops a run inside the current stage, not after it.
   *
   * The abort signal reaches the provider call, so an in-flight generation is torn down
   * rather than paid for and discarded - RV-187's "no further ledger rows are written"
   * is only true if the signal goes all the way down.
   */
  async cancel(runId: RunId): Promise<Result<RunSummary, AppError>> {
    const run = await this.#runs.findById(runId);
    if (isErr(run)) return run;
    if (run.value === null) return err(new NotFoundError('run', runId));

    if (isTerminalRunStatus(run.value.status)) {
      return err(
        new ConflictError({
          message: `Run ${runId} is already ${run.value.status} and cannot be cancelled`,
          context: { runId, status: run.value.status },
        }),
      );
    }

    this.#inFlight.get(runId)?.controller.abort();
    this.#inFlight.delete(runId);

    const cancelled = await this.#runs.setStatus(
      runId,
      'cancelled',
      toIso(this.#clock.now()),
      'CANCELLED',
    );
    if (isErr(cancelled)) return cancelled;

    this.#events.publish({
      type: 'run-completed',
      runId,
      status: 'cancelled',
      totalNanoUsd: cancelled.value.spentNanoUsd,
      errorKind: 'cancelled',
      errorCode: 'CANCELLED',
    });

    return ok(cancelled.value);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #enqueue(
    runId: RunId,
    stage: PipelineStageKey,
    payload: Record<string, unknown>,
  ): Promise<Result<Unit, AppError>> {
    return this.#queue.enqueue({
      id: this.#ids.job(),
      runId,
      stage,
      payload,
      attempt: 0,
    });
  }

  /**
   * Runs one stage and decides what happens next.
   *
   * Returns `Err` only when the queue should consider the job failed - a retryable
   * error, so the driver's backoff applies. A stage that failed permanently has
   * already been recorded on the run and terminated the stream, and returning `Ok`
   * there stops the queue re-running work whose outcome is settled.
   */
  async #handle(job: QueuedJob): Promise<Result<Unit, AppError>> {
    const run = await this.#runs.findById(job.runId);
    if (isErr(run)) return run;
    if (run.value === null) return err(new NotFoundError('run', job.runId));

    // A cancelled run may still have jobs in the queue; they are dropped rather than
    // executed, which is the difference between "cancel" and "cancel after this one".
    if (isTerminalRunStatus(run.value.status)) return ok(UNIT);

    const handler = this.#stages.get(job.stage);
    if (handler === undefined) {
      return this.#fail(run.value, job.stage, 'STAGE_NOT_REGISTERED', 'internal');
    }

    const state = this.#inFlight.get(job.runId) ?? {
      controller: new AbortController(),
      payload: job.payload,
      startedAt: this.#clock.now(),
    };
    this.#inFlight.set(job.runId, state);

    await this.#runs.setStatus(job.runId, 'running', toIso(this.#clock.now()));
    await this.#runs.setCurrentStage(job.runId, job.stage);
    this.#events.publish({ type: 'stage-started', runId: job.runId, stage: job.stage });

    const startedAt = this.#clock.now();
    const outcome = await handler.execute({
      run: run.value,
      job,
      reportProgress: (progress, detail) => {
        this.#events.publish({
          type: 'stage-progress',
          runId: job.runId,
          stage: job.stage,
          progress: Math.min(1, Math.max(0, progress)),
          detail: detail ?? null,
        });
      },
      signal: state.controller.signal,
    });

    const durationMs = Math.max(0, this.#clock.now() - startedAt);

    // Re-checked *after* the stage returns, not only before it started. A cancel that
    // lands mid-stage aborts the signal, but a stage that ignores the signal - or that
    // was already past its last check - still resolves, and recording its result would
    // walk the run from `cancelled` back to `running` and then to `succeeded`. The run
    // the user stopped would finish, minutes later, and bill for it.
    if (state.controller.signal.aborted) return ok(UNIT);

    if (isErr(outcome)) {
      await this.#runs.recordStage(job.runId, {
        stage: job.stage,
        status: 'failed',
        costNanoUsd: 0,
        durationMs,
        artifacts: [],
        errorCode: outcome.error.code,
      });

      // Retryable failures go back to the driver, which owns backoff. Permanent ones
      // end the run here: re-running a stage that cannot succeed burns the retry
      // budget and delays the diagnosis by exactly the backoff schedule.
      if (outcome.error.retryable) return outcome;
      return this.#fail(run.value, job.stage, outcome.error.code, outcome.error.kind);
    }

    await this.#runs.recordStage(job.runId, {
      stage: job.stage,
      status: 'succeeded',
      costNanoUsd: 0,
      durationMs,
      artifacts: [...outcome.value.artifacts],
      errorCode: null,
    });
    this.#events.publish({
      type: 'stage-completed',
      runId: job.runId,
      stage: job.stage,
      durationMs,
      costNanoUsd: 0,
    });

    const next = this.#nextStage(run.value, job.stage);
    if (next !== undefined) return this.#enqueue(job.runId, next, state.payload);

    return this.#succeed(job.runId);
  }

  #nextStage(run: RunSummary, current: PipelineStageKey): PipelineStageKey | undefined {
    const index = run.requestedStages.indexOf(current);
    return index < 0 ? undefined : run.requestedStages[index + 1];
  }

  async #succeed(runId: RunId): Promise<Result<Unit, AppError>> {
    this.#inFlight.delete(runId);
    const finished = await this.#runs.setStatus(runId, 'succeeded', toIso(this.#clock.now()));
    if (isErr(finished)) return finished;

    await this.#runs.setCurrentStage(runId, null);
    this.#events.publish({
      type: 'run-completed',
      runId,
      status: 'succeeded',
      totalNanoUsd: finished.value.spentNanoUsd,
      errorKind: null,
      errorCode: null,
    });
    return ok(UNIT);
  }

  async #fail(
    run: RunSummary,
    stage: PipelineStageKey,
    code: string,
    kind: string,
  ): Promise<Result<Unit, AppError>> {
    this.#inFlight.delete(run.id);
    this.#logger.warn('run failed', { runId: run.id, stage, code, kind });

    const failed = await this.#runs.setStatus(run.id, 'failed', toIso(this.#clock.now()), code);
    if (isErr(failed)) return failed;

    this.#events.publish({
      type: 'run-completed',
      runId: run.id,
      status: 'failed',
      totalNanoUsd: failed.value.spentNanoUsd,
      errorKind: kind,
      errorCode: code,
    });

    // `Ok` on purpose: the run is settled, and telling the queue this job failed would
    // have it retried into a run that is already terminal.
    return ok(UNIT);
  }
}
