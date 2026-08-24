/**
 * The runner's decisions, isolated from HTTP.
 *
 * `pipeline.e2e-spec.ts` drives the happy path over a real application. What it cannot
 * reach are the branches that need a stage to cooperate: a stage that hangs long enough
 * to be cancelled, a stage that fails retryably, a job that arrives for a run that has
 * already stopped. Those are where a run leaks money or a queue loops, so they get a
 * test with a stage handler the test controls.
 */

import { Ids, type PipelineStageKey, type ProjectId, type RunId } from '@rv/contracts';
import {
  CancelledError,
  FixedClock,
  InternalError,
  MemoryLogger,
  ProviderError,
  UNIT,
  createRng,
  instant,
  isErr,
  ok,
  type AppError,
  type Result,
  type Unit,
} from '@rv/shared-kernel';
import { createDatabase, type DatabaseHandle } from '@rv/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunPayloadStore } from '../application/ports/run-payload.port';
import { RunEventBus } from '../events/run-event-bus';
import { DrizzleRunRepository } from '../infrastructure/persistence/drizzle-run.repository';
import { InProcessJobQueue } from '../queue/in-process.queue';
import { PipelineRunner } from './pipeline-runner.service';
import {
  buildStageRegistry,
  type StageContext,
  type StageHandler,
  type StageOutput,
} from './stage';

const PROJECT = 'prj_01J0000000000000000000000A' as ProjectId;

/** A stage the test drives: it reports progress, then resolves when told to. */
class ControlledStage implements StageHandler {
  readonly stage: PipelineStageKey;
  readonly implemented = true;
  calls = 0;
  lastSignal: AbortSignal | null = null;
  #resolve: ((outcome: Result<StageOutput, AppError>) => void) | null = null;

  constructor(stage: PipelineStageKey) {
    this.stage = stage;
  }

  execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    this.calls += 1;
    this.lastSignal = context.signal;
    context.reportProgress({ progress: 0.5, detail: 'halfway' });
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  finish(outcome: Result<StageOutput, AppError>): void {
    this.#resolve?.(outcome);
    this.#resolve = null;
  }
}

/**
 * The payload store, in memory.
 *
 * A `Map` rather than the real JSON-file store because these tests are about the
 * runner's decisions; `resume.e2e-spec.ts` exercises the durable one by killing the
 * process that wrote it, which is the only test that can.
 */
class MemoryPayloadStore implements RunPayloadStore {
  readonly payloads = new Map<RunId, Record<string, unknown>>();

  save(runId: RunId, payload: Record<string, unknown>): Promise<Result<Unit>> {
    this.payloads.set(runId, payload);
    return Promise.resolve(ok(UNIT));
  }

  load(runId: RunId): Promise<Result<Record<string, unknown> | null>> {
    return Promise.resolve(ok(this.payloads.get(runId) ?? null));
  }
}

interface Fixture {
  readonly runner: PipelineRunner;
  readonly payloads: MemoryPayloadStore;
  readonly events: RunEventBus;
  readonly queue: InProcessJobQueue;
  readonly repository: DrizzleRunRepository;
  readonly stage: ControlledStage;
  readonly handle: DatabaseHandle;
}

function build(stageId: PipelineStageKey = 'intake'): Fixture {
  const opened = createDatabase(':memory:');
  if (isErr(opened)) throw opened.error;

  const clock = new FixedClock(instant(1_700_000_000_000));
  const logger = new MemoryLogger();
  const stage = new ControlledStage(stageId);
  const queue = new InProcessJobQueue({
    concurrency: 1,
    rng: createRng(1),
    logger,
    // Retry backoff is injected away: the retry *count* is what is under test, and a
    // test that waited out the real schedule would take seconds to prove it.
    sleep: () => Promise.resolve(),
  });
  const events = new RunEventBus({ clock });
  const repository = new DrizzleRunRepository(opened.value);
  const payloads = new MemoryPayloadStore();

  const runner = new PipelineRunner({
    runs: repository,
    payloads,
    queue,
    events,
    stages: buildStageRegistry([stage]),
    clock,
    ids: new Ids(),
    logger,
  });

  return { runner, payloads, events, queue, repository, stage, handle: opened.value };
}

/** Yields to the microtask/timer queue so the in-process worker can pick the job up. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function start(fixture: Fixture, stages: readonly PipelineStageKey[] = ['intake']) {
  return fixture.runner.start({
    projectId: PROJECT,
    seriesId: null,
    stages,
    seed: 1,
    budgetNanoUsd: null,
    payload: {},
  });
}

describe('PipelineRunner', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = build();
  });

  afterEach(async () => {
    await fixture.queue.close();
    fixture.handle.close();
  });

  it('lists the stages this build can execute', () => {
    expect(fixture.runner.implementedStages()).toEqual(['intake']);
  });

  it('refuses a run that requests no stages', async () => {
    const outcome = await fixture.runner.start({
      projectId: PROJECT,
      seriesId: null,
      stages: [],
      seed: 1,
      budgetNanoUsd: null,
      payload: {},
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('conflict');
  });

  it('refuses a run whose seed is not a whole number, because it could not be replayed', async () => {
    const outcome = await fixture.runner.start({
      projectId: PROJECT,
      seriesId: null,
      stages: ['intake'],
      seed: 1.5,
      budgetNanoUsd: null,
      payload: {},
    });

    expect(isErr(outcome)).toBe(true);
  });

  it('reports progress from inside a stage on the run stream', async () => {
    const started = await start(fixture);
    if (isErr(started)) throw started.error;
    await tick();

    const kinds = fixture.events.history(started.value.id).map((event) => event.type);
    expect(kinds).toEqual(['stage-started', 'stage-progress']);

    fixture.stage.finish(ok({ artifacts: [] }));
    await tick();
  });

  it('cancels a running stage and aborts the signal the stage was given', async () => {
    const started = await start(fixture);
    if (isErr(started)) throw started.error;
    await tick();

    expect(fixture.stage.lastSignal?.aborted).toBe(false);
    const cancelled = await fixture.runner.cancel(started.value.id);
    if (isErr(cancelled)) throw cancelled.error;

    expect(cancelled.value.status).toBe('cancelled');
    // The signal reaches the provider call. A cancel that only stopped the *next*
    // stage would still pay for the one in flight (RV-187).
    expect(fixture.stage.lastSignal?.aborted).toBe(true);

    const last = fixture.events.history(started.value.id).at(-1);
    expect(last).toMatchObject({ type: 'run-completed', status: 'cancelled' });

    fixture.stage.finish(ok({ artifacts: [] }));
    await tick();
  });

  it('refuses to cancel a run twice', async () => {
    const started = await start(fixture);
    if (isErr(started)) throw started.error;
    await tick();
    await fixture.runner.cancel(started.value.id);

    const again = await fixture.runner.cancel(started.value.id);
    expect(isErr(again)).toBe(true);
    if (!isErr(again)) return;
    expect(again.error.kind).toBe('conflict');

    fixture.stage.finish(ok({ artifacts: [] }));
    await tick();
  });

  it('reports a cancel for a run that does not exist', async () => {
    const missing = await fixture.runner.cancel('run_01J0000000000000000000000Z');
    expect(isErr(missing)).toBe(true);
    if (!isErr(missing)) return;
    expect(missing.error.kind).toBe('not-found');
  });

  it('drops a queued job for a run that has already stopped', async () => {
    const started = await start(fixture);
    if (isErr(started)) throw started.error;
    await tick();

    await fixture.runner.cancel(started.value.id);
    fixture.stage.finish(ok({ artifacts: [] }));
    await tick();

    // A cancelled run's remaining jobs are dropped, not executed. Otherwise "cancel"
    // means "cancel after the next stage", which is not what the button says.
    const stopped = await fixture.repository.findById(started.value.id);
    if (isErr(stopped) || stopped.value === null) throw new Error('not found');
    expect(stopped.value.status).toBe('cancelled');
  });

  it('hands a retryable stage failure back to the queue, which owns backoff', async () => {
    const started = await start(fixture);
    if (isErr(started)) throw started.error;
    await tick();

    fixture.stage.finish({
      ok: false,
      error: new ProviderError({ message: 'upstream 503', provider: 'x', status: 503 }),
    });
    await tick();

    // The queue re-delivers, so the stage is attempted again rather than the run being
    // failed on the first transient error.
    expect(fixture.stage.calls).toBeGreaterThan(1);
    const run = await fixture.repository.findById(started.value.id);
    if (isErr(run) || run.value === null) throw new Error('not found');
    expect(run.value.status).not.toBe('succeeded');

    fixture.stage.finish(ok({ artifacts: [] }));
    await tick();
  });

  it('fails a run whose stage is not registered rather than dropping the job', async () => {
    const started = await start(fixture, ['intake']);
    if (isErr(started)) throw started.error;
    await tick();
    fixture.stage.finish(ok({ artifacts: [] }));
    await tick();

    const empty = new PipelineRunner({
      runs: fixture.repository,
      payloads: fixture.payloads,
      queue: fixture.queue,
      events: fixture.events,
      stages: buildStageRegistry([]),
      clock: new FixedClock(instant(0)),
      ids: new Ids(),
      logger: new MemoryLogger(),
    });

    const orphan = await empty.start({
      projectId: PROJECT,
      seriesId: null,
      stages: ['render'],
      seed: 1,
      budgetNanoUsd: null,
      payload: {},
    });
    if (isErr(orphan)) throw orphan.error;
    await fixture.queue.drain(2000);

    const run = await fixture.repository.findById(orphan.value.id);
    if (isErr(run) || run.value === null) throw new Error('not found');
    expect(run.value.status).toBe('failed');
    expect(run.value.errorCode).toBe('STAGE_NOT_REGISTERED');
  });

  it('completes a run and clears its current stage', async () => {
    const started = await start(fixture);
    if (isErr(started)) throw started.error;
    await tick();
    fixture.stage.finish(ok({ artifacts: ['brief:idea'] }));
    await fixture.queue.drain(2000);

    const run = await fixture.repository.findById(started.value.id);
    if (isErr(run) || run.value === null) throw new Error('not found');
    expect(run.value.status).toBe('succeeded');
    expect(run.value.currentStage).toBeNull();
    expect(run.value.stages[0]?.artifacts).toEqual(['brief:idea']);
  });
});

/**
 * A stage whose work is a *batch*, checking the signal between units.
 *
 * The distinction claim 2 rests on: a stage that only looks at the signal on entry
 * finishes its whole batch before noticing, which is a delay, not a cancellation. This
 * one records how far it got and when it settled, so the assertion is about units and
 * milliseconds rather than about a status that was written by the canceller anyway.
 */
class BatchStage implements StageHandler {
  readonly stage: PipelineStageKey;
  readonly implemented = true;
  unitsDone = 0;
  settledAt = 0;

  readonly #units: number;
  readonly #unitMs: number;

  constructor(stage: PipelineStageKey, units: number, unitMs: number) {
    this.stage = stage;
    this.#units = units;
    this.#unitMs = unitMs;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    for (let unit = 0; unit < this.#units; unit += 1) {
      if (context.signal.aborted) {
        this.settledAt = performance.now();
        return { ok: false, error: new CancelledError(`${this.stage} at unit ${String(unit)}`) };
      }
      await new Promise((resolve) => setTimeout(resolve, this.#unitMs));
      this.unitsDone += 1;
      context.reportProgress({
        progress: (unit + 1) / this.#units,
        item: { kind: 'unit', key: String(unit), index: unit, total: this.#units },
      });
    }
    this.settledAt = performance.now();
    return ok({ artifacts: [] });
  }
}

const BATCH_UNITS = 40;
const BATCH_UNIT_MS = 25;

describe('cancellation is prompt, not eventual', () => {
  it('stops between units of work rather than after the stage finishes', async () => {
    const opened = createDatabase(':memory:');
    if (isErr(opened)) throw opened.error;

    const clock = new FixedClock(instant(1_700_000_000_000));
    const queue = new InProcessJobQueue({
      concurrency: 1,
      rng: createRng(1),
      logger: new MemoryLogger(),
    });
    const payloads = new MemoryPayloadStore();
    const repository = new DrizzleRunRepository(opened.value);
    // 40 units of 25 ms: a stage that takes a full second, so "noticed within one unit"
    // and "noticed after the stage" are two numbers nobody can confuse.
    const stage = new BatchStage('intake', BATCH_UNITS, BATCH_UNIT_MS);

    const runner = new PipelineRunner({
      runs: repository,
      payloads,
      queue,
      events: new RunEventBus({ clock }),
      stages: buildStageRegistry([stage]),
      clock,
      ids: new Ids(),
      logger: new MemoryLogger(),
    });

    const started = await runner.start({
      projectId: PROJECT,
      seriesId: null,
      stages: ['intake'],
      seed: 1,
      budgetNanoUsd: null,
      payload: {},
    });
    if (isErr(started)) throw started.error;

    // Let a few units go by, so the cancel genuinely lands mid-batch.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const unitsAtCancel = stage.unitsDone;
    expect(unitsAtCancel).toBeGreaterThan(0);
    expect(unitsAtCancel).toBeLessThan(BATCH_UNITS);

    const requestedAt = performance.now();
    const cancelled = await runner.cancel(started.value.id);
    if (isErr(cancelled)) throw cancelled.error;
    await queue.drain(5_000);

    const noticedMs = stage.settledAt - requestedAt;
    const unitsAfter = stage.unitsDone - unitsAtCancel;
    const leftMs = (BATCH_UNITS - unitsAtCancel) * BATCH_UNIT_MS;
    console.info(
      `cancel noticed after ${noticedMs.toFixed(1)} ms and ${String(unitsAfter)} further unit(s); ` +
        `the stage had ${String(BATCH_UNITS - unitsAtCancel)} units (~${String(leftMs)} ms) left to run`,
    );

    // One unit of slack, because the signal can only be seen between units. Two would
    // mean the check had moved outside the loop.
    expect(unitsAfter).toBeLessThanOrEqual(1);
    expect(noticedMs).toBeLessThan(BATCH_UNIT_MS * 4);
    expect(noticedMs).toBeLessThan(leftMs / 2);

    // And the run says a person stopped it, rather than that it broke.
    const run = await repository.findById(started.value.id);
    if (isErr(run) || run.value === null) throw new Error('not found');
    expect(run.value.status).toBe('cancelled');
    expect(run.value.stages.find((entry) => entry.stage === 'intake')?.status).toBe('cancelled');

    await queue.close();
    opened.value.close();
  });
});

/**
 * A two-stage fixture, because a resumable run needs a stage that finished and a stage
 * that did not - and a one-stage run that finished is `succeeded`, which is terminal.
 *
 * Note what is *not* here: no test walks a run to `failed` by hand. `succeeded ->
 * failed` is not a transition the state machine has, and a test that forced it would be
 * asserting against a state the system cannot reach.
 */
interface PairFixture {
  readonly runner: PipelineRunner;
  readonly payloads: MemoryPayloadStore;
  readonly queue: InProcessJobQueue;
  readonly repository: DrizzleRunRepository;
  readonly first: ControlledStage;
  readonly second: ControlledStage;
  readonly handle: DatabaseHandle;
}

function buildPair(): PairFixture {
  const opened = createDatabase(':memory:');
  if (isErr(opened)) throw opened.error;

  const clock = new FixedClock(instant(1_700_000_000_000));
  const logger = new MemoryLogger();
  const first = new ControlledStage('intake');
  const second = new ControlledStage('resolve');
  const queue = new InProcessJobQueue({
    concurrency: 1,
    rng: createRng(1),
    logger,
    sleep: () => Promise.resolve(),
  });
  const payloads = new MemoryPayloadStore();
  const repository = new DrizzleRunRepository(opened.value);

  const runner = new PipelineRunner({
    runs: repository,
    payloads,
    queue,
    events: new RunEventBus({ clock }),
    stages: buildStageRegistry([first, second]),
    clock,
    ids: new Ids(),
    logger,
  });

  return { runner, payloads, queue, repository, first, second, handle: opened.value };
}

/** Runs `intake` to success and lets `resolve` fail permanently. Leaves the run failed. */
async function failedAtSecondStage(fixture: PairFixture) {
  const started = await fixture.runner.start({
    projectId: PROJECT,
    seriesId: null,
    stages: ['intake', 'resolve'],
    seed: 1,
    budgetNanoUsd: null,
    payload: { brief: 'original' },
  });
  if (isErr(started)) throw started.error;

  await tick();
  fixture.first.finish(ok({ artifacts: ['brief:idea'] }));
  await tick();
  fixture.second.finish({ ok: false, error: new InternalError({ message: 'engine missing' }) });
  await fixture.queue.drain(2000);

  const run = await fixture.repository.findById(started.value.id);
  if (isErr(run) || run.value === null) throw new Error('not found');
  expect(run.value.status).toBe('failed');
  return started.value.id;
}

describe('resume', () => {
  it('re-queues a failed run and skips the stages already checkpointed', async () => {
    const fixture = buildPair();
    const runId = await failedAtSecondStage(fixture);
    expect(fixture.first.calls).toBe(1);
    expect(fixture.second.calls).toBe(1);

    const resumed = fixture.runner.resume(runId);
    await tick();
    fixture.second.finish(ok({ artifacts: ['plan:0/0'] }));
    await resumed;
    await fixture.queue.drain(2000);

    // The spy assertion RV-181 asks for: the checkpointed stage was not re-run, and the
    // run finished anyway.
    expect(fixture.first.calls).toBe(1);
    expect(fixture.second.calls).toBe(2);

    const run = await fixture.repository.findById(runId);
    if (isErr(run) || run.value === null) throw new Error('not found');
    expect(run.value.status).toBe('succeeded');

    await fixture.queue.close();
    fixture.handle.close();
  });

  it('re-runs a checkpointed stage whose inputs have moved', async () => {
    const fixture = buildPair();
    const runId = await failedAtSecondStage(fixture);

    // The author edited the brief between the failure and the resume. "Already ran" is
    // no longer enough; "already ran on this" is what the checkpoint claims, and this is
    // the edit that makes the two different answers.
    await fixture.payloads.save(runId, { brief: 'edited' });

    const resumed = fixture.runner.resume(runId);
    await tick();
    fixture.first.finish(ok({ artifacts: ['brief:idea'] }));
    await tick();
    fixture.second.finish(ok({ artifacts: [] }));
    await resumed;
    await fixture.queue.drain(2000);

    expect(fixture.first.calls).toBe(2);

    await fixture.queue.close();
    fixture.handle.close();
  });

  it('finishes a run whose every stage is checkpointed but which never recorded it', async () => {
    // The crash landed between the last checkpoint and the terminal write. Re-running
    // the pipeline to rediscover that would be slow and pointless; the resumed run
    // re-queues the last stage, `#handle` recognises the checkpoint, and the run ends.
    const fixture = buildPair();
    const started = await fixture.runner.start({
      projectId: PROJECT,
      seriesId: null,
      stages: ['intake'],
      seed: 1,
      budgetNanoUsd: null,
      payload: { brief: 'original' },
    });
    if (isErr(started)) throw started.error;
    await tick();
    fixture.first.finish(ok({ artifacts: ['brief:idea'] }));
    await fixture.queue.drain(2000);

    // Rewound to `running` in storage, which is where a kill leaves it - not through
    // `setStatus`, because a crash does not transition anything.
    fixture.handle.sqlite
      .prepare(
        "update runs set state = 'running', finished_at = null, " +
          "metadata = json_set(metadata, '$.status', 'running') where id = ?",
      )
      .run(started.value.id);

    const resumed = await fixture.runner.resume(started.value.id);
    if (isErr(resumed)) throw resumed.error;
    await fixture.queue.drain(2000);

    expect(fixture.first.calls).toBe(1);
    const run = await fixture.repository.findById(started.value.id);
    if (isErr(run) || run.value === null) throw new Error('not found');
    expect(run.value.status).toBe('succeeded');
    // A killed worker is recorded as the failure it is, on the way past.
    expect(run.value.errorCode).toBe('WORKER_LOST');

    await fixture.queue.close();
    fixture.handle.close();
  });

  it('refuses a cancelled run, pointing at the new run that reuses its checkpoints', async () => {
    const fixture = build();
    const started = await start(fixture, ['intake']);
    if (isErr(started)) throw started.error;
    await tick();
    await fixture.runner.cancel(started.value.id);
    fixture.stage.finish(ok({ artifacts: [] }));
    await tick();

    // `cancelled` has no outgoing edges in `PIPELINE_STATUS_TRANSITIONS`, whose comment
    // says why: re-running finished work is a new run, and a replay that overwrites the
    // record cannot be compared against it. Nothing is lost, because the render
    // checkpoint is keyed by content rather than by run.
    const resumed = await fixture.runner.resume(started.value.id);
    expect(isErr(resumed)).toBe(true);
    if (!isErr(resumed)) return;
    expect(resumed.error.kind).toBe('conflict');
    expect(resumed.error.message).toContain('start a new run');

    await fixture.queue.close();
    fixture.handle.close();
  });

  it('refuses a run that is still executing', async () => {
    const fixture = build();
    const started = await start(fixture, ['intake']);
    if (isErr(started)) throw started.error;
    await tick();

    const resumed = await fixture.runner.resume(started.value.id);
    expect(isErr(resumed)).toBe(true);
    if (!isErr(resumed)) return;
    expect(resumed.error.kind).toBe('conflict');

    fixture.stage.finish(ok({ artifacts: [] }));
    await tick();
    await fixture.queue.close();
    fixture.handle.close();
  });

  it('refuses a run whose payload did not survive its worker', async () => {
    const fixture = buildPair();
    const runId = await failedAtSecondStage(fixture);

    // A run started by a build that did not save payloads. There is genuinely nothing to
    // resume it *with*, and guessing an empty payload would re-run every stage against
    // inputs nobody chose.
    fixture.payloads.payloads.delete(runId);

    const resumed = await fixture.runner.resume(runId);
    expect(isErr(resumed)).toBe(true);
    if (!isErr(resumed)) return;
    expect(resumed.error.kind).toBe('conflict');
    expect(resumed.error.message).toContain('no stored payload');

    await fixture.queue.close();
    fixture.handle.close();
  });

  it('reports a resume for a run that does not exist', async () => {
    const fixture = build();
    const missing = await fixture.runner.resume('run_01J0000000000000000000000Z');
    expect(isErr(missing)).toBe(true);
    if (!isErr(missing)) return;
    expect(missing.error.kind).toBe('not-found');

    await fixture.queue.close();
    fixture.handle.close();
  });
});
