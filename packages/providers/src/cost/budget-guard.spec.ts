import { describe, expect, it, vi } from 'vitest';
import type { BudgetPolicy, RunId } from '@rv/contracts';
import { BudgetExceededError, type NanoUsd, fromUsd, isErr, isOk, millis } from '@rv/shared-kernel';

import { deterministicIds, fixedClock, testProjectId, testRunId } from '../__fixtures__/support';
import { BudgetGuard } from './budget-guard';
import { CostMeter } from './cost-meter';

function policy(overrides: Partial<BudgetPolicy> = {}): BudgetPolicy {
  return {
    perRunNanoUsd: null,
    perDayNanoUsd: null,
    perProjectNanoUsd: null,
    confirmAboveNanoUsd: null,
    onExceed: 'abort',
    ...overrides,
  };
}

function meterWith(spentUsd: number, runId: RunId): CostMeter {
  const clock = fixedClock();
  const ids = deterministicIds(clock);
  const meter = new CostMeter({ clock, projectId: testProjectId(ids), ids });
  if (spentUsd > 0) {
    meter.record({
      runId,
      stage: 'produce',
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash-image',
      task: 'image-final',
      tier: 'final',
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 1, resolution: null },
        latencyMs: 10,
      },
      outcome: 'success',
      costNanoUsd: fromUsd(spentUsd),
    });
  }
  return meter;
}

describe('BudgetGuard.check', () => {
  it('refuses before the call once the per-run ceiling would be crossed', () => {
    // RV-029: $5.00 cap, $4.98 already spent, a $0.04 call attempted.
    const runId = testRunId();
    const meter = meterWith(4.98, runId);
    const guard = new BudgetGuard({
      policy: policy({ perRunNanoUsd: fromUsd(5) }),
      ledger: meter,
      clock: fixedClock(),
    });

    const outcome = guard.check({ runId, projectedNanoUsd: fromUsd(0.04) });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error).toBeInstanceOf(BudgetExceededError);
      expect(outcome.error.context.scope).toBe('run');
      // Not retryable: retrying spends exactly the money the guard just prevented.
      expect(outcome.error.retryable).toBe(false);
    }
  });

  it('never touches the provider - the guard runs before the call, by construction', async () => {
    const runId = testRunId();
    const guard = new BudgetGuard({
      policy: policy({ perRunNanoUsd: fromUsd(0.01) }),
      ledger: meterWith(0.02, runId),
      clock: fixedClock(),
    });
    const provider = vi.fn(() => Promise.resolve('never'));

    const outcome = guard.check({ runId, projectedNanoUsd: fromUsd(0.001) });
    if (isOk(outcome)) await provider();

    expect(provider).not.toHaveBeenCalled();
  });

  it('allows a call that lands exactly on the ceiling', () => {
    const runId = testRunId();
    const guard = new BudgetGuard({
      policy: policy({ perRunNanoUsd: fromUsd(5) }),
      ledger: meterWith(4.5, runId),
      clock: fixedClock(),
    });
    expect(isOk(guard.check({ runId, projectedNanoUsd: fromUsd(0.5) }))).toBe(true);
  });

  it('refuses on the per-day ceiling independently of the run', () => {
    const clock = fixedClock();
    const ids = deterministicIds(clock);
    const meter = new CostMeter({ clock, projectId: testProjectId(ids), ids });
    const spentRun = ids.run();
    const freshRun = ids.run();
    meter.record({
      runId: spentRun,
      stage: 'produce',
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash-image',
      task: 'image-final',
      tier: 'final',
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 1, resolution: null },
        latencyMs: 1,
      },
      outcome: 'success',
      costNanoUsd: fromUsd(9.99),
    });

    const guard = new BudgetGuard({
      policy: policy({ perDayNanoUsd: fromUsd(10) }),
      ledger: meter,
      clock,
    });

    // A brand new run, but the day's money is gone.
    const outcome = guard.check({ runId: freshRun, projectedNanoUsd: fromUsd(0.05) });
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.context.scope).toBe('day');
  });

  it('lets spend outside the day window fall off', () => {
    const clock = fixedClock();
    const ids = deterministicIds(clock);
    const meter = new CostMeter({ clock, projectId: testProjectId(ids), ids });
    const runId = ids.run();
    meter.record({
      runId,
      stage: 'produce',
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash-image',
      task: 'image-final',
      tier: 'final',
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 1, resolution: null },
        latencyMs: 1,
      },
      outcome: 'success',
      costNanoUsd: fromUsd(9.99),
    });
    clock.advance(millis(2_000));

    const guard = new BudgetGuard({
      policy: policy({ perDayNanoUsd: fromUsd(10) }),
      ledger: meter,
      clock,
      dayWindowMs: 1_000,
    });

    expect(isOk(guard.check({ runId, projectedNanoUsd: fromUsd(5) }))).toBe(true);
  });

  it('refuses on the per-project ceiling', () => {
    const runId = testRunId();
    const guard = new BudgetGuard({
      policy: policy({ perProjectNanoUsd: fromUsd(1) }),
      ledger: meterWith(0.9, runId),
      clock: fixedClock(),
    });
    const outcome = guard.check({ runId, projectedNanoUsd: fromUsd(0.2) });
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.context.scope).toBe('project');
  });

  it('treats a null ceiling as "no ceiling", not as zero', () => {
    // A guard that refused every call under the default configuration would be
    // switched off in anger, which is worse than having none.
    const runId = testRunId();
    const guard = new BudgetGuard({
      policy: policy(),
      ledger: meterWith(1_000, runId),
      clock: fixedClock(),
    });
    expect(isOk(guard.check({ runId, projectedNanoUsd: fromUsd(500) }))).toBe(true);
  });
});

describe('BudgetGuard.requiresConfirmation', () => {
  it('is not a refusal, only a stop-and-ask', () => {
    const guard = new BudgetGuard({
      policy: policy({ confirmAboveNanoUsd: fromUsd(1) }),
      ledger: BudgetGuard.zeroSpend,
      clock: fixedClock(),
    });

    expect(guard.requiresConfirmation(fromUsd(1.4))).toBe(true);
    expect(guard.requiresConfirmation(fromUsd(0.9))).toBe(false);
    // ... and it still lets the call through, because it is a different question.
    expect(isOk(guard.check({ runId: testRunId(), projectedNanoUsd: fromUsd(1.4) }))).toBe(true);
  });

  it('is never triggered when no threshold is configured', () => {
    const guard = new BudgetGuard({
      policy: policy(),
      ledger: BudgetGuard.zeroSpend,
      clock: fixedClock(),
    });
    expect(guard.requiresConfirmation(fromUsd(9_999))).toBe(false);
  });
});

describe('BudgetGuard.remaining', () => {
  it('reports the tightest headroom', () => {
    const runId = testRunId();
    const guard = new BudgetGuard({
      policy: policy({ perRunNanoUsd: fromUsd(5), perProjectNanoUsd: fromUsd(2) }),
      ledger: meterWith(1, runId),
      clock: fixedClock(),
    });
    expect(guard.remaining(runId)).toBe(fromUsd(1));
  });

  it('floors at zero rather than reporting a negative allowance', () => {
    const runId = testRunId();
    const guard = new BudgetGuard({
      policy: policy({ perRunNanoUsd: fromUsd(1) }),
      ledger: meterWith(3, runId),
      clock: fixedClock(),
    });
    expect(guard.remaining(runId)).toBe(0 as NanoUsd);
  });

  it('is null when nothing is capped', () => {
    const guard = new BudgetGuard({
      policy: policy(),
      ledger: BudgetGuard.zeroSpend,
      clock: fixedClock(),
    });
    expect(guard.remaining(testRunId())).toBeNull();
  });

  it('accounts for the day window too', () => {
    const runId = testRunId();
    const guard = new BudgetGuard({
      policy: policy({ perDayNanoUsd: fromUsd(4) }),
      ledger: meterWith(1, runId),
      clock: fixedClock(),
    });
    expect(guard.remaining(runId)).toBe(fromUsd(3));
  });
});
