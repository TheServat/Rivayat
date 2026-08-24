/**
 * Non-negotiable #3, asserted the only way that means anything.
 *
 * "The budget guard runs before the call" is not checkable from a status code: an
 * implementation that pays for the generation and *then* returns 402 produces exactly
 * the same response. The only observable difference is on the provider side, so the
 * fake here counts its own invocations and the test asserts the count is zero.
 *
 * Everything except the provider is real - the real `CostMeter`, the real `BudgetGuard`,
 * the real `RunEventBus`, the real pricing table from `@rv/contracts`. A test that
 * stubbed the guard would be testing the stub.
 */

import { Ids, type ProjectId, type RunId, type UsageRecord } from '@rv/contracts';
import type { ProviderUsage } from '@rv/providers';
import {
  CancelledError,
  FixedClock,
  InternalError,
  MemoryLogger,
  ProviderError,
  UNIT,
  err,
  fromUsd,
  instant,
  isErr,
  ok,
  type Result,
  type Unit,
} from '@rv/shared-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import type { RunRepository } from '../application/ports/repository.ports';
import { RunEventBus } from '../events/run-event-bus';
import { CostService } from './cost.service';
import { MeteredCallRunner, type MeteredOutcome } from './metered-call';

const PROJECT = 'prj_01J0000000000000000000000A' as ProjectId;
const RUN = 'run_01J0000000000000000000000A' as RunId;

/**
 * A provider that records every time it is asked to do anything.
 *
 * The whole point of the file. `calls` is the assertion target for "refused before the
 * spend"; anything else would only prove the response code.
 */
class CountingProvider {
  calls = 0;

  respond(): Promise<Result<MeteredOutcome<string>>> {
    this.calls += 1;
    const usage: ProviderUsage = {
      tokens: { input: 1_000, output: 500, cached: 0, reasoning: 0 },
      images: { count: 0, resolution: null },
      latencyMs: 12,
    };
    return Promise.resolve(ok({ value: 'generated', usage }));
  }

  fail(): Promise<Result<MeteredOutcome<string>>> {
    this.calls += 1;
    return Promise.resolve({
      ok: false,
      error: new ProviderError({ message: 'upstream 500', provider: 'gemini', status: 500 }),
    });
  }
}

/** Records what was persisted, and never fails - persistence is not what is under test. */
class RecordingRunRepository implements Partial<RunRepository> {
  readonly appended: UsageRecord[] = [];

  appendUsage(record: UsageRecord): Promise<Result<Unit>> {
    this.appended.push(record);
    return Promise.resolve(ok(UNIT));
  }
}

interface Fixture {
  readonly runner: MeteredCallRunner;
  readonly provider: CountingProvider;
  readonly events: RunEventBus;
  readonly repository: RecordingRunRepository;
  readonly cost: CostService;
}

function build(perRunUsd: number | null): Fixture {
  const clock = new FixedClock(instant(1_700_000_000_000));
  const cost = new CostService({
    clock,
    logger: new MemoryLogger(),
    ids: new Ids(),
    policy: {
      perRunNanoUsd: perRunUsd === null ? null : fromUsd(perRunUsd),
      perDayNanoUsd: null,
      perProjectNanoUsd: null,
      confirmAboveNanoUsd: null,
      onExceed: 'abort',
    },
  });
  const events = new RunEventBus({ clock });
  const repository = new RecordingRunRepository();
  const runner = new MeteredCallRunner({
    cost,
    events,
    runs: repository as unknown as RunRepository,
    logger: new MemoryLogger(),
  });
  return { runner, provider: new CountingProvider(), events, repository, cost };
}

/**
 * A 1024² image on the paid lane.
 *
 * An image model, not a text one, because the verified catalogue in `@rv/contracts`
 * prices every text model at zero - the free tiers are real - so a text call can never
 * exceed a ceiling and a budget test written against one would pass vacuously.
 * `openai/gpt-5-image-mini` bills image-output tokens at $8/1M, so this is cents.
 */
const PAID_IMAGE: ProviderUsage = {
  tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
  images: { count: 1, resolution: { width: 1024, height: 1024 } },
  latencyMs: 0,
};

/** The same work on the free local lane. Recorded, and priced at nothing. */
const FREE_IMAGE: ProviderUsage = {
  tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
  images: { count: 1, resolution: { width: 512, height: 512 } },
  latencyMs: 0,
};

function paid(perRunNanoUsd: number | null) {
  return {
    projectId: PROJECT,
    budget: { runId: RUN, perRunNanoUsd },
    stage: 'produce' as const,
    task: 'image-final' as const,
    tier: 'final' as const,
    provider: 'openrouter' as const,
    model: 'openai/gpt-5-image-mini',
    estimate: PAID_IMAGE,
  };
}

function free(perRunNanoUsd: number | null) {
  return {
    projectId: PROJECT,
    budget: { runId: RUN, perRunNanoUsd },
    stage: 'produce' as const,
    task: 'image-draft' as const,
    tier: 'draft' as const,
    provider: 'comfyui' as const,
    model: 'sdxl-turbo',
    estimate: FREE_IMAGE,
  };
}

describe('MeteredCallRunner', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = build(0.000001);
  });

  it('prices the paid lane above the ceiling, so the refusal below is not vacuous', () => {
    const projected = fixture.cost.price(
      PROJECT,
      'openrouter',
      'openai/gpt-5-image-mini',
      PAID_IMAGE,
    );
    expect(projected).toBeGreaterThan(1_000);
  });

  it('refuses a call that would exceed the budget before the provider is touched', async () => {
    const outcome = await fixture.runner.run(paid(null), () => fixture.provider.respond());

    expect(isErr(outcome)).toBe(true);
    // The assertion that matters. A guard that runs after the response would leave this
    // at 1 and every other assertion in this test would still pass.
    expect(fixture.provider.calls).toBe(0);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('budget');
    expect(outcome.error.retryable).toBe(false);
  });

  it('writes no ledger row for a call it refused', async () => {
    await fixture.runner.run(paid(null), () => fixture.provider.respond());
    expect(fixture.repository.appended).toEqual([]);
    expect(fixture.cost.totalForRun(PROJECT, RUN)).toBe(0);
  });

  it('puts the refusal on the run stream so a watching UI learns why it stopped', async () => {
    await fixture.runner.run(paid(null), () => fixture.provider.respond());

    const raised = fixture.events.history(RUN).filter((event) => event.type === 'issue-raised');
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      severity: 'error',
      code: 'BUDGET_EXCEEDED',
      stage: 'produce',
    });
  });

  it('lets an affordable call through and meters what it actually used', async () => {
    const outcome = await fixture.runner.run(free(null), () => fixture.provider.respond());

    expect(isErr(outcome)).toBe(false);
    expect(fixture.provider.calls).toBe(1);
    expect(fixture.repository.appended).toHaveLength(1);
    expect(fixture.repository.appended[0]).toMatchObject({
      runId: RUN,
      stage: 'produce',
      provider: 'comfyui',
      outcome: 'success',
    });
  });

  it('records the free lane too, so the ledger shows it is being used', async () => {
    await fixture.runner.run(free(null), () => fixture.provider.respond());
    expect(fixture.repository.appended[0]?.costNanoUsd).toBe(0);
    // A ledger that only recorded paid calls could not answer "is the free lane
    // working", which is the whole economic premise of the architecture.
    expect(fixture.repository.appended).toHaveLength(1);
  });

  it('emits the running total and the remaining headroom as spend accrues', async () => {
    await fixture.runner.run(free(null), () => fixture.provider.respond());

    const updates = fixture.events.history(RUN).filter((event) => event.type === 'cost-updated');
    expect(updates).toHaveLength(1);
    const update = updates[0];
    if (update?.type !== 'cost-updated') throw new Error('expected a cost-updated event');
    expect(update.totalNanoUsd).toBe(update.deltaNanoUsd);
    expect(update.remainingNanoUsd).not.toBeNull();
  });

  it("honours the run's own ceiling over the machine layer's", async () => {
    // The machine layer would allow this call; the run was created with a tighter one.
    const generous = build(1000);
    const outcome = await generous.runner.run(paid(1), () => generous.provider.respond());

    expect(isErr(outcome)).toBe(true);
    expect(generous.provider.calls).toBe(0);
  });

  it('records a failed call, because a failure that burned tokens still cost money', async () => {
    const outcome = await fixture.runner.run(free(null), () => fixture.provider.fail());

    expect(isErr(outcome)).toBe(true);
    expect(fixture.repository.appended).toHaveLength(1);
    expect(fixture.repository.appended[0]).toMatchObject({
      outcome: 'failure',
      errorCode: 'PROVIDER_ERROR',
    });
  });

  it('still returns the value when the ledger row cannot be persisted', async () => {
    // The in-memory meter is authoritative for the guard, so a storage failure must
    // not fail a call that already succeeded and already cost money. It does mean the
    // run resource will under-report, which is why it is logged as an error.
    const unwritable = build(null);
    const runner = new MeteredCallRunner({
      cost: unwritable.cost,
      events: unwritable.events,
      runs: {
        appendUsage: () => Promise.resolve(err(new InternalError({ message: 'disk full' }))),
      } as unknown as RunRepository,
      logger: new MemoryLogger(),
    });

    const outcome = await runner.run(free(null), () => unwritable.provider.respond());

    expect(isErr(outcome)).toBe(false);
    // The cost still reached the stream, because that is what the budget guard and the
    // UI read.
    expect(unwritable.events.history(RUN).some((event) => event.type === 'cost-updated')).toBe(
      true,
    );
  });

  describe('when the run has been cancelled', () => {
    it('refuses before the guard, with the provider untouched and no ledger row', async () => {
      const uncapped = build(null);
      const controller = new AbortController();
      controller.abort();

      const outcome = await uncapped.runner.run({ ...free(null), signal: controller.signal }, () =>
        uncapped.provider.respond(),
      );

      expect(isErr(outcome)).toBe(true);
      if (!isErr(outcome)) return;
      expect(outcome.error.kind).toBe('cancelled');

      // The two assertions RV-187 actually makes. A cancel that only stopped the *next*
      // stage would leave `calls` at 1, and a cancel that recorded the call anyway would
      // keep writing ledger rows for a run the user stopped.
      expect(uncapped.provider.calls).toBe(0);
      expect(uncapped.repository.appended).toEqual([]);
    });

    it('writes no ledger row for a call torn down in flight', async () => {
      const uncapped = build(null);
      const controller = new AbortController();

      // The provider observes the abort and reports it, which is what an adapter does
      // when `fetch` rejects with `AbortError`. It has already been invoked, so this is
      // the mid-flight case rather than the pre-flight one above.
      const outcome = await uncapped.runner.run(
        { ...free(null), signal: controller.signal },
        () => {
          controller.abort();
          return Promise.resolve({
            ok: false as const,
            error: new CancelledError('image generation'),
          });
        },
      );

      expect(isErr(outcome)).toBe(true);
      expect(uncapped.repository.appended).toEqual([]);
      expect(uncapped.events.history(RUN).some((event) => event.type === 'cost-updated')).toBe(
        false,
      );
    });

    it('hands the signal to the closure, so an adapter can pass it to the socket', async () => {
      const uncapped = build(null);
      const controller = new AbortController();
      let received: AbortSignal | undefined;

      await uncapped.runner.run({ ...free(null), signal: controller.signal }, (signal) => {
        received = signal;
        return uncapped.provider.respond();
      });

      // The runner is the single source of the signal. A closure that had to close over
      // its own copy is a closure that can be written without one.
      expect(received).toBe(controller.signal);
    });
  });

  it('never refuses when nothing is capped', async () => {
    const uncapped = build(null);
    const outcome = await uncapped.runner.run(paid(null), () => uncapped.provider.respond());

    expect(isErr(outcome)).toBe(false);
    expect(uncapped.provider.calls).toBe(1);
    expect(uncapped.cost.remaining(PROJECT, { runId: RUN, perRunNanoUsd: null })).toBeNull();
  });
});
