/**
 * The ledger. One row per provider call, success or failure.
 *
 * Failures are recorded because a call that burned input tokens and then returned a
 * 500 still cost money, and a ledger that only records successes under-reports every
 * bad run - exactly the runs worth understanding.
 *
 * Every amount is an integer nano-dollar. The reason is in `@rv/shared-kernel/money`:
 * at $0.00000025 per token, micro-dollars round a real charge to zero, and doubles
 * drift once you accumulate thousands of them. Ten thousand $0.0000003 calls must sum
 * to exactly $0.003, and with integers they do.
 */

import type {
  CostBucket,
  CostLedger,
  CostSummary,
  JobId,
  PipelineStageKey,
  ProjectId,
  ProviderKind,
  QualityTier,
  RunId,
  TaskKind,
  UsageRecord,
} from '@rv/contracts';
import { Ids, type ModelDescriptor } from '@rv/contracts';
import {
  type Clock,
  type Instant,
  type NanoUsd,
  ZERO_USD,
  addUsd,
  type Logger,
  NoopLogger,
  toIso,
} from '@rv/shared-kernel';

import type { ProviderUsage } from '../ports/common';
import { priceCall, pricingFor } from './pricing';

/** Everything the meter needs that it cannot derive. */
export interface RecordCallInput {
  readonly runId: RunId;
  /** `null` for an interactive call made outside a queued job. */
  readonly jobId?: JobId | null;
  readonly stage: PipelineStageKey;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly task: TaskKind;
  readonly tier: QualityTier;
  readonly usage: ProviderUsage;
  readonly outcome: 'success' | 'failure';
  /** `AppError.code` when the call failed. */
  readonly errorCode?: string | null;
  /** A cache hit costs nothing and is recorded as such, never omitted. */
  readonly cacheHit?: boolean;
  /**
   * Overrides the catalogue price.
   *
   * Present so a run can be re-priced against the rates that were live at the time
   * rather than today's, which is what makes an old ledger auditable.
   */
  readonly costNanoUsd?: NanoUsd;
}

export interface CostMeterDeps {
  readonly clock: Clock;
  readonly projectId: ProjectId;
  readonly ids?: Ids;
  /** Defaults to `KNOWN_MODELS`. */
  readonly catalogue?: readonly ModelDescriptor[];
  readonly logger?: Logger;
}

/** Read side, so the budget guard can consult spend without owning the ledger. */
export interface SpendReader {
  totalNanoUsd(): NanoUsd;
  totalForRun(runId: RunId): NanoUsd;
  /** Spend at or after `sinceEpochMs`. Used for the per-day ceiling. */
  totalSince(sinceEpochMs: number): NanoUsd;
}

const EMPTY_BUCKET: CostBucket = {
  calls: 0,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  images: 0,
  costNanoUsd: 0,
};

export class CostMeter implements SpendReader {
  readonly #clock: Clock;
  readonly #projectId: ProjectId;
  readonly #ids: Ids;
  readonly #catalogue: readonly ModelDescriptor[] | undefined;
  readonly #logger: Logger;
  readonly #records: UsageRecord[] = [];
  /** Kept alongside the ISO timestamps so the per-day window is a numeric compare. */
  readonly #timestamps: Instant[] = [];

  constructor(deps: CostMeterDeps) {
    this.#clock = deps.clock;
    this.#projectId = deps.projectId;
    this.#ids = deps.ids ?? new Ids();
    this.#catalogue = deps.catalogue;
    this.#logger = deps.logger ?? new NoopLogger();
  }

  /**
   * Prices a call without recording it.
   *
   * The budget guard needs this *before* the call (CLAUDE.md #3), so it cannot be a
   * side effect of recording one.
   */
  price(provider: ProviderKind, model: string, consumed: ProviderUsage): NanoUsd {
    return priceCall(pricingFor(provider, model, this.#catalogue), consumed);
  }

  /** Writes one row and returns it. */
  record(input: RecordCallInput): UsageRecord {
    const cacheHit = input.cacheHit ?? false;
    // A cache hit is free by definition: the bytes never left our disk.
    const cost = cacheHit
      ? ZERO_USD
      : (input.costNanoUsd ?? this.price(input.provider, input.model, input.usage));

    const at = this.#clock.now();
    const record: UsageRecord = {
      id: this.#ids.usage(),
      runId: input.runId,
      jobId: input.jobId ?? null,
      stage: input.stage,
      provider: input.provider,
      model: input.model,
      task: input.task,
      tier: input.tier,
      tokens: input.usage.tokens,
      images: input.usage.images,
      latencyMs: input.usage.latencyMs,
      costNanoUsd: cost,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      cacheHit,
      at: toIso(at),
    };

    this.#records.push(record);
    this.#timestamps.push(at);
    this.#logger.debug('cost: recorded', {
      model: `${input.provider}:${input.model}`,
      nanoUsd: cost,
      outcome: input.outcome,
      cacheHit,
    });
    return record;
  }

  records(runId?: RunId): readonly UsageRecord[] {
    return runId === undefined
      ? [...this.#records]
      : this.#records.filter((record) => record.runId === runId);
  }

  // ── SpendReader ───────────────────────────────────────────────────────────

  totalNanoUsd(): NanoUsd {
    return sum(this.#records.map((record) => record.costNanoUsd as NanoUsd));
  }

  totalForRun(runId: RunId): NanoUsd {
    return sum(
      this.#records
        .filter((record) => record.runId === runId)
        .map((record) => record.costNanoUsd as NanoUsd),
    );
  }

  totalSince(sinceEpochMs: number): NanoUsd {
    let total = ZERO_USD;
    for (const [index, timestamp] of this.#timestamps.entries()) {
      if (timestamp < sinceEpochMs) continue;
      const record = this.#records[index];
      if (record === undefined) continue;
      total = addUsd(total, record.costNanoUsd as NanoUsd);
    }
    return total;
  }

  // ── reporting ─────────────────────────────────────────────────────────────

  /**
   * The four slices from `@rv/contracts`.
   *
   * Four rather than one because they answer four different questions that actually
   * come up: which provider is billing us, which model is expensive, which kind of
   * work is expensive, and which pipeline stage to attack first.
   */
  summary(runId?: RunId): CostSummary {
    const rows = this.records(runId);
    const summary: CostSummary = {
      total: { ...EMPTY_BUCKET },
      byProvider: {},
      byModel: {},
      byTask: {},
      byStage: {},
    };

    for (const row of rows) {
      summary.total = merge(summary.total, row);
      summary.byProvider[row.provider] = merge(summary.byProvider[row.provider], row);
      summary.byModel[row.model] = merge(summary.byModel[row.model], row);
      summary.byTask[row.task] = merge(summary.byTask[row.task], row);
      summary.byStage[row.stage] = merge(summary.byStage[row.stage], row);
    }

    return summary;
  }

  ledger(runId?: RunId): CostLedger {
    const rows = this.records(runId);
    const earliest = this.#timestamps[0];
    return {
      projectId: this.#projectId,
      runId: runId ?? null,
      records: [...rows],
      summary: this.summary(runId),
      from: earliest === undefined ? null : toIso(earliest),
      updatedAt: toIso(this.#clock.now()),
    };
  }
}

function merge(bucket: CostBucket | undefined, row: UsageRecord): CostBucket {
  const base = bucket ?? EMPTY_BUCKET;
  return {
    calls: base.calls + 1,
    failures: base.failures + (row.outcome === 'failure' ? 1 : 0),
    inputTokens: base.inputTokens + row.tokens.input,
    outputTokens: base.outputTokens + row.tokens.output,
    images: base.images + row.images.count,
    // Integer addition: the only reason the totals reconcile exactly.
    costNanoUsd: base.costNanoUsd + row.costNanoUsd,
  };
}

function sum(values: readonly NanoUsd[]): NanoUsd {
  let total = ZERO_USD;
  for (const value of values) total = addUsd(total, value);
  return total;
}
