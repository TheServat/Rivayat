/**
 * The ledger and the guard, per project, in one place.
 *
 * `CostMeter` is constructed with a `ProjectId` because a ledger belongs to a project -
 * "what has this project spent" is the question anyone actually asks - so the API
 * cannot hold one global meter. It holds one per project, created on first use, and
 * the budget guard is built over that project's meter so the two can never disagree
 * about what has been spent.
 *
 * The guard is rebuilt per check rather than cached, because a run may carry its own
 * ceiling: §7b's layered resolution puts the run override above the project, and a
 * cached guard would be holding the wrong policy for every run but the first.
 */

import {
  Ids,
  type BudgetPolicy,
  type CostLedger,
  type NanoUsdAmount,
  type ProjectId,
  type ProviderKind,
  type RunId,
} from '@rv/contracts';
import { BudgetGuard, CostMeter, type ProviderUsage, type RecordCallInput } from '@rv/providers';
import type { BudgetExceededError, Clock, Logger, NanoUsd, Result, Unit } from '@rv/shared-kernel';

/** A run's own ceiling, when it declared one. `null` inherits the project policy. */
export interface RunBudget {
  readonly runId: RunId;
  readonly perRunNanoUsd: NanoUsdAmount | null;
}

export interface CostServiceOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ids: Ids;
  /** The machine-layer policy from `.env`. Project and run layers narrow it. */
  readonly policy: BudgetPolicy;
}

export class CostService {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #ids: Ids;
  readonly #policy: BudgetPolicy;
  readonly #meters = new Map<ProjectId, CostMeter>();

  constructor(options: CostServiceOptions) {
    this.#clock = options.clock;
    this.#logger = options.logger.child({ component: 'cost' });
    this.#ids = options.ids;
    this.#policy = options.policy;
  }

  /** The project's ledger, created on first use. */
  meterFor(projectId: ProjectId): CostMeter {
    const existing = this.#meters.get(projectId);
    if (existing !== undefined) return existing;
    const created = new CostMeter({
      clock: this.#clock,
      projectId,
      ids: this.#ids,
      logger: this.#logger,
    });
    this.#meters.set(projectId, created);
    return created;
  }

  /** What a call is expected to cost, before it is made. Pure. */
  price(
    projectId: ProjectId,
    provider: ProviderKind,
    model: string,
    usage: ProviderUsage,
  ): NanoUsd {
    return this.meterFor(projectId).price(provider, model, usage);
  }

  /**
   * Non-negotiable #3, as one call.
   *
   * The run's own ceiling overrides the machine layer's `perRunNanoUsd` rather than
   * being checked in addition to it: a run that was created with a $1 budget inside a
   * $5 machine default should stop at $1, and a run created with a larger one was an
   * explicit decision by whoever created it.
   */
  check(
    projectId: ProjectId,
    budget: RunBudget,
    projectedNanoUsd: NanoUsd,
  ): Result<Unit, BudgetExceededError> {
    return this.#guardFor(projectId, budget).check({
      runId: budget.runId,
      projectedNanoUsd,
    });
  }

  /** Headroom at the tightest ceiling, or `null` when nothing caps this run. */
  remaining(projectId: ProjectId, budget: RunBudget): NanoUsd | null {
    return this.#guardFor(projectId, budget).remaining(budget.runId);
  }

  /** Whether this spend crosses the "stop and ask" threshold (§7b, RV-181). */
  requiresConfirmation(projectId: ProjectId, budget: RunBudget, projected: NanoUsd): boolean {
    return this.#guardFor(projectId, budget).requiresConfirmation(projected);
  }

  /** One row. Called after every provider call, successful or not. */
  record(projectId: ProjectId, input: RecordCallInput): ReturnType<CostMeter['record']> {
    return this.meterFor(projectId).record(input);
  }

  totalForRun(projectId: ProjectId, runId: RunId): NanoUsd {
    return this.meterFor(projectId).totalForRun(runId);
  }

  ledger(projectId: ProjectId, runId?: RunId): CostLedger {
    return this.meterFor(projectId).ledger(runId);
  }

  #guardFor(projectId: ProjectId, budget: RunBudget): BudgetGuard {
    const policy: BudgetPolicy =
      budget.perRunNanoUsd === null
        ? this.#policy
        : { ...this.#policy, perRunNanoUsd: budget.perRunNanoUsd };

    return new BudgetGuard({
      policy,
      ledger: this.meterFor(projectId),
      clock: this.#clock,
    });
  }
}
