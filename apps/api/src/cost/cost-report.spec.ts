/**
 * The ledger's arithmetic, and the one assertion that makes it trustworthy.
 *
 * The report is built from `usage_records` and the budget guard is built from
 * `CostMeter`'s in-memory ledger. Two aggregations of the same facts can disagree, and a
 * bill that disagrees with the meter is worse than no bill because it is believed. So
 * the centrepiece here is not a hand-written expected total - it is
 * {@link summarise} folded over the same rows the real `CostMeter` folded, asserted
 * deep-equal. A test with its own expected numbers proves the test can add up; this
 * proves the two things that must agree do.
 *
 * The rows deliberately include the three cases an aggregation quietly gets wrong: a
 * failure (billed, and counted separately), a cache hit (recorded, and free), and a
 * free-lane local call (recorded, and free - which is not the same fact).
 */

import { Ids, type ProjectId, type RunId, type UsageRecord } from '@rv/contracts';
import { CostMeter, type RecordCallInput } from '@rv/providers';
import { FixedClock, MemoryLogger, instant, toIso } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  buildCostReport,
  buildRunLedger,
  perDeliveredMinute,
  reconcile,
  summarise,
  type RunCostInput,
} from './cost-report';

const PROJECT = 'prj_01J0000000000000000000000A' as ProjectId;
const RUN_A = 'run_01J0000000000000000000000A' as RunId;
const RUN_B = 'run_01J0000000000000000000000B' as RunId;
const NOW = toIso(instant(1_700_000_000_000));

/** The calls a small run really makes: a story call, an image, a failure, a cache hit. */
function calls(runId: RunId): readonly RecordCallInput[] {
  return [
    {
      runId,
      stage: 'story',
      provider: 'openrouter',
      model: 'openai/gpt-5-image-mini',
      task: 'image-final',
      tier: 'final',
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 1, resolution: { width: 1024, height: 1024 } },
        latencyMs: 900,
      },
      outcome: 'success',
    },
    {
      runId,
      stage: 'produce',
      provider: 'openrouter',
      model: 'openai/gpt-5-image-mini',
      task: 'image-final',
      tier: 'final',
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 1, resolution: { width: 1024, height: 1024 } },
        latencyMs: 1200,
      },
      // A call that burned its input and then failed. Still billed, and counted apart.
      outcome: 'failure',
      errorCode: 'PROVIDER_ERROR',
    },
    {
      runId,
      stage: 'produce',
      provider: 'comfyui',
      model: 'sdxl-turbo',
      task: 'image-draft',
      tier: 'draft',
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 1, resolution: { width: 512, height: 512 } },
        latencyMs: 4000,
      },
      outcome: 'success',
    },
    {
      runId,
      stage: 'produce',
      provider: 'openrouter',
      model: 'openai/gpt-5-image-mini',
      task: 'image-final',
      tier: 'final',
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 1, resolution: { width: 1024, height: 1024 } },
        latencyMs: 3,
      },
      outcome: 'success',
      // The bytes never left our disk, so it is free - and recorded, never omitted.
      cacheHit: true,
    },
  ];
}

function meterWith(runIds: readonly RunId[]): CostMeter {
  const meter = new CostMeter({
    clock: new FixedClock(instant(1_700_000_000_000)),
    projectId: PROJECT,
    ids: new Ids(),
    logger: new MemoryLogger(),
  });
  for (const runId of runIds) for (const call of calls(runId)) meter.record(call);
  return meter;
}

describe('summarise', () => {
  it('produces exactly what the CostMeter produces over the same rows', () => {
    const meter = meterWith([RUN_A]);
    const rows = meter.records(RUN_A);

    // The reconciliation. `CostMeter.summary` is what the budget guard's world looks
    // like; `summarise` is what the invoice looks like. They are the same fold or the
    // ledger is a second opinion.
    expect(summarise(rows)).toEqual(meter.summary(RUN_A));
  });

  it('still agrees once a project has more than one run in it', () => {
    const meter = meterWith([RUN_A, RUN_B]);
    expect(summarise(meter.records())).toEqual(meter.summary());
    expect(summarise(meter.records(RUN_B))).toEqual(meter.summary(RUN_B));
  });

  it('counts a failure as a call and as a failure, and a cache hit as free', () => {
    const rows = meterWith([RUN_A]).records(RUN_A);
    const summary = summarise(rows);

    expect(summary.total.calls).toBe(4);
    expect(summary.total.failures).toBe(1);
    expect(summary.byProvider.comfyui?.costNanoUsd).toBe(0);

    const cached = rows.find((row) => row.cacheHit);
    expect(cached?.costNanoUsd).toBe(0);
    // Four calls, three of them priced, and the paid ones really cost something -
    // otherwise every assertion above passes vacuously.
    expect(summary.total.costNanoUsd).toBeGreaterThan(0);
  });

  it('is empty, not absent, for a run that spent nothing', () => {
    const summary = summarise([]);
    expect(summary.total).toEqual({
      calls: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      images: 0,
      costNanoUsd: 0,
    });
    expect(summary.byStage).toEqual({});
  });
});

describe('buildRunLedger', () => {
  it('orders the rows and dates the window from the earliest of them', () => {
    const rows = meterWith([RUN_A]).records(RUN_A);
    const shuffled = [rows[3], rows[1], rows[0], rows[2]].filter(
      (row): row is UsageRecord => row !== undefined,
    );

    const ledger = buildRunLedger({
      projectId: PROJECT,
      runId: RUN_A,
      records: shuffled,
      updatedAt: NOW,
    });

    expect(ledger.runId).toBe(RUN_A);
    expect(ledger.records).toHaveLength(4);
    expect(ledger.from).toBe(ledger.records[0]?.at);
    expect(ledger.summary.total.costNanoUsd).toBe(summarise(rows).total.costNanoUsd);
  });

  it('reports no window for a run with no rows, rather than inventing one', () => {
    const ledger = buildRunLedger({
      projectId: PROJECT,
      runId: RUN_A,
      records: [],
      updatedAt: NOW,
    });
    expect(ledger.from).toBeNull();
    expect(ledger.records).toEqual([]);
  });
});

describe('perDeliveredMinute', () => {
  it('converts to a whole nano-dollar figure per minute', () => {
    // 60 000 ms delivered for 1 000 nano-dollars is 1 000 per minute.
    expect(perDeliveredMinute(1_000, 60_000)).toBe(1_000);
    expect(perDeliveredMinute(1_000, 30_000)).toBe(2_000);
    // Integer nano-dollars all the way down: a fractional price is rounded, never
    // carried as a float that drifts once you sum a season of them.
    expect(perDeliveredMinute(1_000, 45_000)).toBe(1_333);
    expect(Number.isInteger(perDeliveredMinute(7, 13_000) ?? 0)).toBe(true);
  });

  it('answers null when nothing was delivered', () => {
    // Not zero. "This episode cost nothing per minute" and "this episode delivered no
    // minutes" are different facts and only one of them is good news.
    expect(perDeliveredMinute(5_000, 0)).toBeNull();
    expect(perDeliveredMinute(0, 0)).toBeNull();
  });
});

describe('buildCostReport', () => {
  function runInput(runId: RunId, deliveredMs: number | null): RunCostInput {
    return {
      runId,
      seriesId: null,
      status: 'succeeded',
      startedAt: NOW,
      finishedAt: NOW,
      deliveredMs,
      records: meterWith([runId]).records(runId),
    };
  }

  it('breaks a run down by stage and by provider, and prices its delivered minute', () => {
    const report = buildCostReport({
      projectId: PROJECT,
      seriesId: null,
      runs: [runInput(RUN_A, 120_000)],
      updatedAt: NOW,
    });

    const row = report.runs[0];
    expect(row?.runId).toBe(RUN_A);
    // "What did this episode cost me, broken down" - the two breakdowns anyone acts on.
    expect(Object.keys(row?.byStage ?? {}).sort()).toEqual(['produce', 'story']);
    expect(row?.byProvider.openrouter?.calls).toBe(3);
    expect(row?.costNanoUsd).toBe(report.summary.total.costNanoUsd);
    expect(row?.nanoUsdPerDeliveredMinute).toBe(perDeliveredMinute(row?.costNanoUsd ?? 0, 120_000));
  });

  it('totals across runs and prices the project by its delivered minutes', () => {
    const report = buildCostReport({
      projectId: PROJECT,
      seriesId: null,
      runs: [runInput(RUN_A, 60_000), runInput(RUN_B, 60_000)],
      updatedAt: NOW,
    });

    const perRun = report.runs.reduce((total, row) => total + row.costNanoUsd, 0);
    // The headline must be the sum of the rows under it, or the screen argues with
    // itself.
    expect(report.summary.total.costNanoUsd).toBe(perRun);
    expect(report.deliveredMs).toBe(120_000);
    expect(report.nanoUsdPerDeliveredMinute).toBe(perDeliveredMinute(perRun, 120_000));
    expect(report.summary.total.calls).toBe(8);
  });

  it('reports no price per minute for a project that has delivered nothing', () => {
    const report = buildCostReport({
      projectId: PROJECT,
      seriesId: null,
      runs: [runInput(RUN_A, null)],
      updatedAt: NOW,
    });

    expect(report.deliveredMs).toBe(0);
    expect(report.nanoUsdPerDeliveredMinute).toBeNull();
    expect(report.runs[0]?.nanoUsdPerDeliveredMinute).toBeNull();
    // The spend is still real, which is precisely why `null` rather than `0` matters:
    // money was spent and no minutes came out.
    expect(report.summary.total.costNanoUsd).toBeGreaterThan(0);
  });

  it('is an empty report, not a failure, for a project with no runs', () => {
    const report = buildCostReport({
      projectId: PROJECT,
      seriesId: null,
      runs: [],
      updatedAt: NOW,
    });
    expect(report.runs).toEqual([]);
    expect(report.summary.total.calls).toBe(0);
    expect(report.nanoUsdPerDeliveredMinute).toBeNull();
  });
});

describe('reconcile', () => {
  it('agrees when the durable rows are the metered rows', () => {
    const rows = meterWith([RUN_A]).records(RUN_A);
    const outcome = reconcile(rows, rows);
    expect(outcome.agrees).toBe(true);
    expect(outcome.durableNanoUsd).toBe(outcome.meteredNanoUsd);
  });

  it('agrees when this process made no calls, because an empty meter is not a mismatch', () => {
    // The normal case for a resumed run, or for any read from a process that did not do
    // the spending.
    const rows = meterWith([RUN_A]).records(RUN_A);
    expect(reconcile(rows, []).agrees).toBe(true);
  });

  it('disagrees when a row this process wrote never reached the database', () => {
    // The failure that matters: `appendUsage` returned an error, `MeteredCallRunner`
    // deliberately did not fail the call over it, and now the guard and the invoice are
    // working from different numbers.
    const rows = meterWith([RUN_A]).records(RUN_A);
    const outcome = reconcile(rows.slice(0, 3), rows);

    expect(outcome.agrees).toBe(false);
    expect(outcome.durableRows).toBe(3);
    expect(outcome.meteredRows).toBe(4);
  });
});
