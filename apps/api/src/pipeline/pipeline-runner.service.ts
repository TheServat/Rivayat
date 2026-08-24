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
  at,
  contentHash,
  err,
  isErr,
  ok,
  toIso,
} from '@rv/shared-kernel';

import type { RunRepository } from '../application/ports/repository.ports';
import type { RunPayloadStore } from '../application/ports/run-payload.port';
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
  /** Durable copy of the starting payload, so a killed run can be resumed at all. */
  readonly payloads: RunPayloadStore;
  readonly queue: JobQueue;
  readonly events: RunEventBus;
  readonly stages: StageRegistry;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly logger: Logger;
}

/**
 * What a stage consumed, hashed, so "already ran" can become "already ran on this".
 *
 * The stage id is folded in for the reason `compositeHash` exists: two stages handed
 * the same payload are two different pieces of work, and a hash that could not tell
 * them apart would let a resumed run skip S10 because S8 had already run on the same
 * IR.
 */
export function stageInputHash(stage: PipelineStageKey, payload: Record<string, unknown>): string {
  return contentHash({ stage, payload });
}

/** In-flight state that does not belong in the run record. */
interface InFlight {
  readonly controller: AbortController;
  readonly payload: Record<string, unknown>;
  startedAt: number;
}

export class PipelineRunner {
  readonly #runs: RunRepository;
  readonly #payloads: RunPayloadStore;
  readonly #queue: JobQueue;
  readonly #events: RunEventBus;
  readonly #stages: StageRegistry;
  readonly #clock: Clock;
  readonly #ids: Ids;
  readonly #logger: Logger;
  readonly #inFlight = new Map<RunId, InFlight>();

  constructor(deps: PipelineRunnerDeps) {
    this.#runs = deps.runs;
    this.#payloads = deps.payloads;
    this.#queue = deps.queue;
    this.#events = deps.events;
    this.#stages = deps.stages;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#logger = deps.logger.child({ component: 'pipeline' });

    this.#queue.setHandler((job) => this.#handle(job));
  }

  /**
   * Stages this build can actually execute - the ones whose handler says so.
   *
   * A filter over a *declaration*, not over the registry's key set. Every stage is
   * registered, including the nine bound to `StubStageHandler`, precisely so that a run
   * asking for one fails with a diagnosis rather than a missing key; returning those
   * keys from a method called `implementedStages` reported all twelve as working, and
   * that answer was copied into `docs/05-remaining-work.md` as fact.
   *
   * Filtering on a hard-coded list of known stubs would fix today's answer and not
   * tomorrow's: a stub added later would silently inflate the count again.
   */
  implementedStages(): readonly PipelineStageKey[] {
    return [...this.#stages.values()]
      .filter((handler) => handler.implemented)
      .map((handler) => handler.stage);
  }

  /**
   * Every stage the registry can route, implemented or stubbed.
   *
   * Reported alongside the above because an operator debugging a 501 is asking a
   * different question from an operator asking what this build can do: "wired and
   * stubbed" and "not wired at all" are different diagnoses with different fixes, and
   * one list cannot express both.
   */
  registeredStages(): readonly PipelineStageKey[] {
    return [...this.#stages.keys()];
  }

  /** Registered but refusing, with the package that owes each one. */
  stubbedStages(): readonly PipelineStageKey[] {
    return [...this.#stages.values()]
      .filter((handler) => !handler.implemented)
      .map((handler) => handler.stage);
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

    // Before the job, for the same reason the run record is: a payload written after
    // the worker has already picked the job up is a payload the worker raced. A run
    // whose payload did not survive cannot be resumed, so the failure is reported here
    // rather than discovered when someone tries.
    const saved = await this.#payloads.save(created.value.id, request.payload);
    if (isErr(saved)) return saved;

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

    // Aborted *before* the status is written, so the stage stops as close to the
    // request as the event loop allows rather than one database round trip later.
    this.#inFlight.get(runId)?.controller.abort();
    this.#inFlight.delete(runId);

    const stage = run.value.currentStage;
    if (stage !== null) {
      await this.#runs.recordStage(runId, {
        stage,
        status: 'cancelled',
        costNanoUsd: await this.#stageCost(runId, stage),
        durationMs: 0,
        artifacts: [],
        errorCode: 'CANCELLED',
        inputHash: null,
        deliveredMs: null,
      });
    }

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

  /**
   * Picks a stopped run back up from its last checkpoint.
   *
   * Two ways a run stops without finishing, and they need different first moves.
   *
   *  - **Failed.** `PIPELINE_STATUS_TRANSITIONS` has `failed -> queued` for exactly
   *    this, so it is re-queued as it stands.
   *  - **Killed.** The process that owned the run died, so nothing ever wrote a
   *    terminal state and the row still says `running` or `queued` with no worker
   *    behind it. That is a failure - the worker is gone - so it is recorded as one
   *    (`WORKER_LOST`) and then re-queued. Recording it first is not bookkeeping: it is
   *    the only legal path to `queued`, and it means the run's history says what
   *    actually happened rather than quietly resuming as though nothing had.
   *
   * A **cancelled** run is refused, and that is deliberate. `cancelled` has no outgoing
   * edges in the transition table, whose comment says why: re-running finished work is
   * a new run, and a replay that overwrites the record cannot be compared against it.
   * Nothing is lost by starting a new run instead - the render checkpoint is keyed by
   * the content being rendered, not by the run id, so a new run over the same payload
   * continues from the frame the cancelled one stopped at.
   *
   * The resumed run re-enqueues from the **first stage without a matching checkpoint**;
   * `#handle` skips the rest on arrival, which keeps one definition of "already done".
   */
  async resume(runId: RunId): Promise<Result<RunSummary, AppError>> {
    const found = await this.#runs.findById(runId);
    if (isErr(found)) return found;
    if (found.value === null) return err(new NotFoundError('run', runId));
    const run = found.value;

    if (run.status === 'succeeded' || run.status === 'cancelled') {
      return err(
        new ConflictError({
          message:
            `Run ${runId} is ${run.status} and cannot be resumed; ` +
            'start a new run, which will reuse the checkpoints of this one',
          context: { runId, status: run.status },
        }),
      );
    }

    if (this.#inFlight.has(runId)) {
      return err(
        new ConflictError({
          message: `Run ${runId} is still executing; cancel it before resuming`,
          context: { runId, status: run.status },
        }),
      );
    }

    if (run.status !== 'failed') {
      const orphaned = await this.#runs.setStatus(
        runId,
        'failed',
        toIso(this.#clock.now()),
        'WORKER_LOST',
      );
      if (isErr(orphaned)) return orphaned;
      this.#logger.warn('resuming a run whose worker is gone', {
        runId,
        status: run.status,
        stage: run.currentStage,
      });
    }

    const stored = await this.#payloads.load(runId);
    if (isErr(stored)) return stored;
    if (stored.value === null) {
      return err(
        new ConflictError({
          message:
            `Run ${runId} has no stored payload, so there is nothing to resume it with; ` +
            'start a new run with the original request',
          context: { runId },
        }),
      );
    }
    const payload = stored.value;

    // When every stage is already checkpointed - the crash landed between the last
    // checkpoint and the terminal write - the last stage is re-queued anyway. `#handle`
    // recognises the checkpoint, skips the work and completes the run, so "already
    // done" has one definition and this method does not grow a second copy of it.
    const next =
      this.#firstStageToRun(run, payload) ??
      at(run.requestedStages, run.requestedStages.length - 1);

    const requeued = await this.#runs.setStatus(runId, 'queued', toIso(this.#clock.now()));
    if (isErr(requeued)) return requeued;

    this.#inFlight.set(runId, {
      controller: new AbortController(),
      payload,
      startedAt: this.#clock.now(),
    });

    const enqueued = await this.#enqueue(runId, next, payload);
    if (isErr(enqueued)) {
      this.#inFlight.delete(runId);
      return enqueued;
    }

    return ok(requeued.value);
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

    const state = this.#inFlight.get(job.runId) ?? {
      controller: new AbortController(),
      payload: job.payload,
      startedAt: this.#clock.now(),
    };
    this.#inFlight.set(job.runId, state);

    // Read through a function, not through the property. Control-flow analysis narrows
    // `signal.aborted` to `false` after the first check and has no way to know that an
    // `await` in between can flip it - so the later checks, which are the ones that
    // catch a mid-stage cancel, get reported as dead code.
    const cancelled = (): boolean => state.controller.signal.aborted;

    // `running` before the handler lookup, not after. A worker has picked the job up,
    // so the run *is* running - and `PIPELINE_STATUS_TRANSITIONS` has no
    // `queued -> failed` edge, so a run whose stage is not registered could not
    // otherwise be failed at all.
    const started = await this.#runs.setStatus(job.runId, 'running', toIso(this.#clock.now()));
    if (isErr(started)) return started;

    const handler = this.#stages.get(job.stage);
    if (handler === undefined) {
      return this.#fail(run.value, job.stage, 'STAGE_NOT_REGISTERED', 'internal');
    }

    const inputHash = stageInputHash(job.stage, job.payload);

    // The whole of "resumable". A stage that already succeeded **on these inputs** is
    // skipped; one whose inputs have moved since is re-run, because a checkpoint that
    // ignored its input hash would silently skip the stage the author just edited -
    // architecture section 4's "editing re-runs only the downstream stages that depend
    // on it", broken in the direction nobody checks.
    const done = run.value.stages.find(
      (entry) =>
        entry.stage === job.stage && entry.status === 'succeeded' && entry.inputHash === inputHash,
    );
    if (done !== undefined) {
      this.#logger.debug('stage skipped, already checkpointed', {
        runId: job.runId,
        stage: job.stage,
      });
      this.#events.publish({
        type: 'stage-completed',
        runId: job.runId,
        stage: job.stage,
        durationMs: done.durationMs,
        costNanoUsd: done.costNanoUsd,
      });
      const following = this.#nextStage(run.value, job.stage);
      return following === undefined
        ? this.#succeed(job.runId)
        : this.#enqueue(job.runId, following, state.payload);
    }

    // Checked once more here rather than only in the terminal test above: a cancel that
    // landed between the two would otherwise start a whole stage's work.
    if (cancelled()) return ok(UNIT);

    await this.#runs.setCurrentStage(job.runId, job.stage);
    this.#events.publish({ type: 'stage-started', runId: job.runId, stage: job.stage });

    const startedAt = this.#clock.now();
    const outcome = await handler.execute({
      run: run.value,
      job,
      reportProgress: (update) => {
        this.#events.publish({
          type: 'stage-progress',
          runId: job.runId,
          stage: job.stage,
          progress: Math.min(1, Math.max(0, update.progress)),
          detail: update.detail ?? null,
          item: update.item ?? null,
        });
      },
      signal: state.controller.signal,
    });

    const durationMs = Math.max(0, this.#clock.now() - startedAt);
    const costNanoUsd = await this.#stageCost(job.runId, job.stage);

    // Re-checked *after* the stage returns, not only before it started. A cancel that
    // lands mid-stage aborts the signal, but a stage that ignores the signal - or that
    // was already past its last check - still resolves, and recording its result would
    // walk the run from `cancelled` back to `running` and then to `succeeded`. The run
    // the user stopped would finish, minutes later, and bill for it.
    if (cancelled()) return ok(UNIT);

    if (isErr(outcome)) {
      await this.#runs.recordStage(job.runId, {
        stage: job.stage,
        status: 'failed',
        costNanoUsd,
        durationMs,
        artifacts: [],
        errorCode: outcome.error.code,
        inputHash,
        deliveredMs: null,
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
      costNanoUsd,
      durationMs,
      artifacts: [...outcome.value.artifacts],
      errorCode: null,
      inputHash,
      deliveredMs: outcome.value.deliveredMs ?? null,
    });
    this.#events.publish({
      type: 'stage-completed',
      runId: job.runId,
      stage: job.stage,
      durationMs,
      costNanoUsd,
    });

    const next = this.#nextStage(run.value, job.stage);
    if (next !== undefined) return this.#enqueue(job.runId, next, state.payload);

    return this.#succeed(job.runId);
  }

  /**
   * What this stage of this run has cost so far, summed from the durable ledger.
   *
   * From `usage_records` rather than from an in-memory meter, because the number has to
   * survive the process that spent it: a resumed run reports the whole run's cost,
   * including the part a previous process paid for. Rows from a failed attempt are
   * included on purpose - the attempt that failed still cost money.
   */
  async #stageCost(runId: RunId, stage: PipelineStageKey): Promise<number> {
    const rows = await this.#runs.usage(runId);
    if (isErr(rows)) return 0;
    return rows.value
      .filter((row) => row.stage === stage)
      .reduce((total, row) => total + row.costNanoUsd, 0);
  }

  /**
   * The earliest requested stage that has not succeeded **on the payload being resumed**.
   *
   * The input hash is compared here and not only in `#handle`, because `#handle` only
   * ever sees the stage it was handed: a resume that picked the first *unfinished*
   * stage would jump straight past an earlier stage whose inputs the author edited in
   * between, and the edit would never take effect. That is architecture section 4's
   * "editing re-runs only the downstream stages that depend on it" failing in the
   * direction nobody checks - silently, and towards stale output.
   *
   * `undefined` means every stage is checkpointed against this payload, which for a run
   * that is not `succeeded` means the crash landed between the last checkpoint and the
   * terminal write.
   *
   * The granularity is honest rather than clever: the hash covers the *whole run
   * payload*, so editing any part of it re-runs from the first stage. Per-stage input
   * extraction would let an edit to the shot list skip S0-S7, and that needs each stage
   * to declare what it consumes - which is the shape `StageCheckpoint.inputHash` in
   * `@rv/contracts` is built for and which no stage declares yet.
   */
  #firstStageToRun(
    run: RunSummary,
    payload: Record<string, unknown>,
  ): PipelineStageKey | undefined {
    return run.requestedStages.find((stage) => {
      const done = run.stages.find((entry) => entry.stage === stage);
      if (done?.status !== 'succeeded') return true;
      return done.inputHash !== stageInputHash(stage, payload);
    });
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
