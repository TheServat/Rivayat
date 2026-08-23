/**
 * The runner's decisions, isolated from HTTP.
 *
 * `pipeline.e2e-spec.ts` drives the happy path over a real application. What it cannot
 * reach are the branches that need a stage to cooperate: a stage that hangs long enough
 * to be cancelled, a stage that fails retryably, a job that arrives for a run that has
 * already stopped. Those are where a run leaks money or a queue loops, so they get a
 * test with a stage handler the test controls.
 */

import { Ids, type PipelineStageKey, type ProjectId } from '@rv/contracts';
import {
  FixedClock,
  MemoryLogger,
  ProviderError,
  createRng,
  instant,
  isErr,
  ok,
  type AppError,
  type Result,
} from '@rv/shared-kernel';
import { createDatabase, type DatabaseHandle } from '@rv/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  calls = 0;
  lastSignal: AbortSignal | null = null;
  #resolve: ((outcome: Result<StageOutput, AppError>) => void) | null = null;

  constructor(stage: PipelineStageKey) {
    this.stage = stage;
  }

  execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    this.calls += 1;
    this.lastSignal = context.signal;
    context.reportProgress(0.5, 'halfway');
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  finish(outcome: Result<StageOutput, AppError>): void {
    this.#resolve?.(outcome);
    this.#resolve = null;
  }
}

interface Fixture {
  readonly runner: PipelineRunner;
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

  const runner = new PipelineRunner({
    runs: repository,
    queue,
    events,
    stages: buildStageRegistry([stage]),
    clock,
    ids: new Ids(),
    logger,
  });

  return { runner, events, queue, repository, stage, handle: opened.value };
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
