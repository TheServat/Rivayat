/**
 * The ledger, aggregated from the rows that actually survived.
 *
 * `CostMeter` in `@rv/providers` holds the authoritative ledger *for the process that
 * made the calls*. That is the right place for it - the budget guard has to answer
 * "what has this run spent" without a database round trip on every call - and it is the
 * wrong place to read a bill from. The meter is in memory: restart the API and it is
 * empty, run the pipeline in a worker and the web process has never heard of it, resume
 * a killed run and the spend that killed it is gone. `usage_records` is the durable
 * copy, written on every call by `MeteredCallRunner`, and that is what a report is
 * built from.
 *
 * Which raises the only interesting risk here: **two aggregations of the same rows can
 * disagree**, and a ledger that disagrees with the meter is worse than no ledger,
 * because it is believed. So {@link summarise} is deliberately the same fold as
 * `CostMeter.summary`, and `cost-reconciliation.spec.ts` asserts the two produce a
 * deep-equal `CostSummary` over the same records - including the failure rows, the
 * cache hits and the zero-cost local calls, which are the three places an aggregation
 * quietly diverges.
 *
 * `nanoUsdPerDeliveredMinute` is the one derived number that is not a sum. It exists
 * because the question a series owner asks is not "what did this run cost" - runs are
 * different lengths - but "what does a minute of this show cost me", and that number
 * has to come from what was *delivered* rather than from what was planned. A run that
 * delivered nothing reports `null` rather than dividing by zero and reporting infinity
 * as a price.
 */

import {
  CostBucket,
  CostLedger,
  CostSummary,
  IsoInstant,
  Millis,
  NanoUsdAmount,
  PipelineStageKey,
  ProjectId,
  ProviderKind,
  RenderJobState,
  RunId,
  SeriesId,
  type UsageRecord,
} from '@rv/contracts';
import { z } from 'zod';

const EMPTY_BUCKET: CostBucket = {
  calls: 0,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  images: 0,
  costNanoUsd: 0,
};

/** Integer nano-dollars throughout: the only reason the four slices reconcile exactly. */
function merge(bucket: CostBucket | undefined, row: UsageRecord): CostBucket {
  const base = bucket ?? EMPTY_BUCKET;
  return {
    calls: base.calls + 1,
    failures: base.failures + (row.outcome === 'failure' ? 1 : 0),
    inputTokens: base.inputTokens + row.tokens.input,
    outputTokens: base.outputTokens + row.tokens.output,
    images: base.images + row.images.count,
    costNanoUsd: base.costNanoUsd + row.costNanoUsd,
  };
}

/**
 * The four slices of `CostSummary`, folded from durable rows.
 *
 * Byte-for-byte the same fold as `CostMeter.summary`. If that ever stops being true the
 * reconciliation spec goes red, which is the point.
 */
export function summarise(records: readonly UsageRecord[]): CostSummary {
  const summary: CostSummary = {
    total: { ...EMPTY_BUCKET },
    byProvider: {},
    byModel: {},
    byTask: {},
    byStage: {},
  };

  for (const row of records) {
    summary.total = merge(summary.total, row);
    summary.byProvider[row.provider] = merge(summary.byProvider[row.provider], row);
    summary.byModel[row.model] = merge(summary.byModel[row.model], row);
    summary.byTask[row.task] = merge(summary.byTask[row.task], row);
    summary.byStage[row.stage] = merge(summary.byStage[row.stage], row);
  }

  return summary;
}

/** One run's ledger, in the shape `@rv/contracts` publishes. */
export function buildRunLedger(input: {
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly records: readonly UsageRecord[];
  readonly updatedAt: IsoInstant;
}): CostLedger {
  const ordered = [...input.records].sort((left, right) => (left.at < right.at ? -1 : 1));
  const earliest = ordered[0];
  return {
    projectId: input.projectId,
    runId: input.runId,
    records: ordered,
    summary: summarise(ordered),
    from: earliest === undefined ? null : earliest.at,
    updatedAt: input.updatedAt,
  };
}

// ── the project / series report ─────────────────────────────────────────────

/**
 * Nano-dollars per delivered minute, as an integer.
 *
 * `null` rather than zero or infinity when nothing was delivered: "this episode cost
 * nothing per minute" and "this episode delivered no minutes" are different facts, and
 * only one of them is good news.
 */
export function perDeliveredMinute(costNanoUsd: number, deliveredMs: number): number | null {
  if (deliveredMs <= 0) return null;
  return Math.round((costNanoUsd * 60_000) / deliveredMs);
}

export const RunCostRow = z.strictObject({
  runId: RunId,
  seriesId: SeriesId.nullable().default(null),
  status: RenderJobState,
  startedAt: IsoInstant,
  finishedAt: IsoInstant.nullable().default(null),
  /** What this run put on disk. `null` for a run that delivered nothing. */
  deliveredMs: Millis.nullable().default(null),
  costNanoUsd: NanoUsdAmount.default(0),
  /** `null` when the run delivered nothing - see {@link perDeliveredMinute}. */
  nanoUsdPerDeliveredMinute: NanoUsdAmount.nullable().default(null),
  /** Where this run's money went, stage by stage. Empty for a run that spent nothing. */
  byStage: z.partialRecord(PipelineStageKey, CostBucket).default({}),
  byProvider: z.partialRecord(ProviderKind, CostBucket).default({}),
});
export type RunCostRow = z.infer<typeof RunCostRow>;

/**
 * What `rv series cost` prints and what the cost screen renders.
 *
 * Per run *and* aggregated, because the two questions are different: "what did this
 * episode cost me, broken down" is a row with its stages, and "is this show getting
 * cheaper" is the trend across rows.
 */
export const CostReport = z.strictObject({
  projectId: ProjectId,
  /** Set when the report was narrowed to one series. `null` for the whole project. */
  seriesId: SeriesId.nullable().default(null),
  runs: z.array(RunCostRow).default([]),
  summary: CostSummary,
  /** Sum of every run's delivered duration. The denominator of the headline figure. */
  deliveredMs: Millis.default(0),
  nanoUsdPerDeliveredMinute: NanoUsdAmount.nullable().default(null),
  updatedAt: IsoInstant,
});
export type CostReport = z.infer<typeof CostReport>;

/** One run and the rows it produced, as the report builder consumes them. */
export interface RunCostInput {
  readonly runId: RunId;
  readonly seriesId: SeriesId | null;
  readonly status: z.infer<typeof RenderJobState>;
  readonly startedAt: IsoInstant;
  readonly finishedAt: IsoInstant | null;
  readonly deliveredMs: number | null;
  readonly records: readonly UsageRecord[];
}

export function buildCostReport(input: {
  readonly projectId: ProjectId;
  readonly seriesId: SeriesId | null;
  readonly runs: readonly RunCostInput[];
  readonly updatedAt: IsoInstant;
}): CostReport {
  const rows: RunCostRow[] = input.runs.map((run) => {
    const summary = summarise(run.records);
    return {
      runId: run.runId,
      seriesId: run.seriesId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      deliveredMs: run.deliveredMs,
      costNanoUsd: summary.total.costNanoUsd,
      nanoUsdPerDeliveredMinute:
        run.deliveredMs === null
          ? null
          : perDeliveredMinute(summary.total.costNanoUsd, run.deliveredMs),
      byStage: summary.byStage,
      byProvider: summary.byProvider,
    };
  });

  const everyRecord = input.runs.flatMap((run) => [...run.records]);
  const summary = summarise(everyRecord);
  const deliveredMs = input.runs.reduce((total, run) => total + (run.deliveredMs ?? 0), 0);

  return {
    projectId: input.projectId,
    seriesId: input.seriesId,
    runs: rows,
    summary,
    deliveredMs,
    nanoUsdPerDeliveredMinute: perDeliveredMinute(summary.total.costNanoUsd, deliveredMs),
    updatedAt: input.updatedAt,
  };
}

/**
 * Whether the durable rows and the in-process meter tell the same story.
 *
 * Reported rather than reconciled *for* the caller, because the two can legitimately
 * differ - a run started before this process booted has durable rows and no metered
 * ones - and only the caller knows whether that is expected. What is never acceptable
 * is the meter holding rows this process wrote and the two totals disagreeing: that is
 * a persistence failure, and it means the budget guard and the bill are working from
 * different numbers.
 */
export interface LedgerReconciliation {
  readonly durableNanoUsd: number;
  readonly meteredNanoUsd: number;
  readonly durableRows: number;
  readonly meteredRows: number;
  readonly agrees: boolean;
}

export function reconcile(
  durable: readonly UsageRecord[],
  metered: readonly UsageRecord[],
): LedgerReconciliation {
  const durableNanoUsd = durable.reduce((total, row) => total + row.costNanoUsd, 0);
  const meteredNanoUsd = metered.reduce((total, row) => total + row.costNanoUsd, 0);
  return {
    durableNanoUsd,
    meteredNanoUsd,
    durableRows: durable.length,
    meteredRows: metered.length,
    // An empty meter is not a disagreement: it is a process that made no calls.
    agrees:
      metered.length === 0 ||
      (durableNanoUsd === meteredNanoUsd && durable.length === metered.length),
  };
}
