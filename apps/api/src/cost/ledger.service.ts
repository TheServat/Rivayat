/**
 * Reading the bill, as opposed to enforcing it.
 *
 * `CostService` owns the *guard* side - price a call, refuse it, record it - and it
 * does that over an in-memory `CostMeter` because a budget check that needed a database
 * round trip would be a database round trip per provider call. This owns the *report*
 * side, and it reads `usage_records`, because a bill has to survive the process that
 * ran up the charges.
 *
 * The split is the whole point, and it has exactly one hazard: the two can disagree.
 * Every read here therefore reconciles the durable rows against whatever the meter is
 * holding for the same run, and logs an error when they diverge. A silent divergence
 * means `MeteredCallRunner`'s `appendUsage` is failing, which is the one failure that
 * makes the budget guard and the invoice work from different numbers - and the runner
 * deliberately does not fail a call over it, so this is where it becomes visible.
 */

import type {
  CostLedger,
  IsoInstant,
  ProjectId,
  RunId,
  SeriesId,
  UsageRecord,
} from '@rv/contracts';
import { isErr, ok, toIso, type Clock, type Logger, type Result } from '@rv/shared-kernel';

import type { RunRepository } from '../application/ports/repository.ports';
import { deliveredMsOf } from '../application/resources';
import {
  buildCostReport,
  buildRunLedger,
  reconcile,
  type CostReport,
  type RunCostInput,
} from './cost-report';
import type { CostService } from './cost.service';

export interface LedgerServiceDeps {
  readonly runs: RunRepository;
  readonly cost: CostService;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class LedgerService {
  readonly #runs: RunRepository;
  readonly #cost: CostService;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(deps: LedgerServiceDeps) {
    this.#runs = deps.runs;
    this.#cost = deps.cost;
    this.#clock = deps.clock;
    this.#logger = deps.logger.child({ component: 'ledger' });
  }

  /** One run's ledger: every call it made, and the four summaries over them. */
  async forRun(projectId: ProjectId, runId: RunId): Promise<Result<CostLedger>> {
    const records = await this.#runs.usage(runId);
    if (isErr(records)) return records;

    this.#check(projectId, runId, records.value);

    return ok(buildRunLedger({ projectId, runId, records: records.value, updatedAt: this.#now() }));
  }

  /**
   * Every run of a project, or of one series inside it, with cost per delivered minute.
   *
   * One `usage` read per run rather than one grouped query, because `RunRepository` has
   * no per-project ledger read and widening it for a report would put a reporting
   * concern on the port the budget guard writes through. The day this is slow it grows
   * its own read port; a project has tens of runs, not millions.
   */
  async forProject(
    projectId: ProjectId,
    seriesId: SeriesId | null = null,
  ): Promise<Result<CostReport>> {
    const runs = await this.#runs.listByProject(projectId);
    if (isErr(runs)) return runs;

    const selected =
      seriesId === null ? runs.value : runs.value.filter((run) => run.seriesId === seriesId);

    const rows: RunCostInput[] = [];
    for (const run of selected) {
      const records = await this.#runs.usage(run.id);
      if (isErr(records)) return records;
      rows.push({
        runId: run.id,
        seriesId: run.seriesId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        deliveredMs: deliveredMsOf(run),
        records: records.value,
      });
    }

    return ok(buildCostReport({ projectId, seriesId, runs: rows, updatedAt: this.#now() }));
  }

  #now(): IsoInstant {
    return toIso(this.#clock.now());
  }

  /** Logged, never thrown: a report that refused to render over a mismatch tells nobody. */
  #check(projectId: ProjectId, runId: RunId, durable: readonly UsageRecord[]): void {
    const metered = this.#cost.ledger(projectId, runId).records;
    const outcome = reconcile(durable, metered);
    if (outcome.agrees) return;

    this.#logger.error('the durable ledger disagrees with the in-process meter', {
      runId,
      durableNanoUsd: outcome.durableNanoUsd,
      meteredNanoUsd: outcome.meteredNanoUsd,
      durableRows: outcome.durableRows,
      meteredRows: outcome.meteredRows,
    });
  }
}
