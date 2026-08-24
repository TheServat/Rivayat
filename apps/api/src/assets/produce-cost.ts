/**
 * `CostService` on one side, the three money ports `ProduceAssetsUseCase` declares on
 * the other.
 *
 * S6 is not the shape `MeteredCallRunner` was written for. That runner is "one call to
 * one named model: guard, call, meter", and produce is forty assets times up to eight
 * steps, with the image lane chosen per asset by a table inside the engine. So the
 * engine declares three narrow ports of its own - a guard, a pricer and a ledger - and
 * this is the adapter for all three.
 *
 * The ordering guarantee non-negotiable #3 asks for is **not** weakened by that. The
 * engine calls `budget.check` with the whole batch's estimate before it generates
 * anything (`ProduceAssetsUseCase.execute`, immediately after the demand plan), and
 * `GenerateAssetVersionUseCase` calls it again per asset before each image request. Both
 * land here, and both land on the same `BudgetGuard` the rest of the app uses, over the
 * same per-project meter. A refusal returns `BudgetExceededError` untouched: it names the
 * ceiling and is deliberately not retryable, and re-wrapping it would lose both.
 *
 * Every recorded call also raises a `cost-updated` event, for the same reason
 * `MeteredCallRunner` does: "how much has this cost so far" has to be answerable while
 * the run is still going, not filed as a receipt at the end.
 */

import type {
  PipelineStageKey,
  ProjectId,
  ProviderKind,
  QualityTier,
  RunId,
  TaskKind,
  UsageRecord,
} from '@rv/contracts';
import type { ProviderUsage } from '@rv/providers';
import type { BudgetExceededError, Logger, NanoUsd, Result, Unit } from '@rv/shared-kernel';
import { isErr, toUsd } from '@rv/shared-kernel';

import type { RunRepository } from '../application/ports/repository.ports';
import type { CostService, RunBudget } from '../cost/cost.service';
import type { RunEventBus } from '../events/run-event-bus';

/** Which project's ledger, and against which ceiling. Fixed for one produce run. */
export interface ProduceCostScope {
  readonly projectId: ProjectId;
  readonly budget: RunBudget;
}

export interface ProduceCostDeps {
  readonly cost: CostService;
  readonly events: RunEventBus;
  /** The durable ledger. The in-memory meter is what the guard reads; this is the bill. */
  readonly runs: RunRepository;
  readonly logger: Logger;
}

/**
 * The guard, the pricer and the ledger, as one object that satisfies all three ports.
 *
 * One class rather than three because they are one decision - "this project's money,
 * against this run's ceiling" - and three objects sharing a scope is three chances to
 * hand one of them the wrong project id.
 */
export class ProduceCostAdapter {
  readonly #deps: ProduceCostDeps;
  readonly #scope: ProduceCostScope;

  constructor(deps: ProduceCostDeps, scope: ProduceCostScope) {
    this.#deps = deps;
    this.#scope = scope;
  }

  /** `BudgetCheckPort`. Runs before the batch, and again before every image request. */
  check(request: {
    readonly runId: RunId;
    readonly projectedNanoUsd: NanoUsd;
  }): Result<Unit, BudgetExceededError> {
    const allowed = this.#deps.cost.check(
      this.#scope.projectId,
      this.#scope.budget,
      request.projectedNanoUsd,
    );
    if (isErr(allowed)) {
      this.#deps.logger.warn('produce refused by the budget guard', {
        runId: request.runId,
        projectedUsd: toUsd(request.projectedNanoUsd),
      });
      this.#deps.events.publish({
        type: 'issue-raised',
        runId: request.runId,
        stage: 'produce',
        severity: 'error',
        code: allowed.error.code,
        message: allowed.error.message,
      });
    }
    return allowed;
  }

  /** `UsagePricerPort`. Pure: prices a call from the catalogue without recording it. */
  price(provider: ProviderKind, model: string, usage: ProviderUsage): NanoUsd {
    return this.#deps.cost.price(this.#scope.projectId, provider, model, usage);
  }

  /**
   * `ProduceLedgerPort`. One row per provider call, successful or not.
   *
   * Synchronous, because the port is - the engine records and moves on, and a ledger
   * write that could block the chain would put the ledger on the critical path of a GPU
   * queue. The durable copy is written behind it: the in-memory meter is what the guard
   * reads, so a failed row means the run resource under-reports rather than the guard
   * being wrong, and that is worth an error line rather than a failed asset.
   */
  record(input: {
    readonly runId: RunId;
    readonly stage: PipelineStageKey;
    readonly provider: ProviderKind;
    readonly model: string;
    readonly task: 'image-draft' | 'image-final' | 'vision-score';
    readonly tier: QualityTier;
    readonly usage: ProviderUsage;
    readonly outcome: 'success' | 'failure';
    readonly cacheHit?: boolean;
  }): void {
    const record = this.#deps.cost.record(this.#scope.projectId, {
      runId: input.runId,
      stage: input.stage,
      provider: input.provider,
      model: input.model,
      // The engine's three task names are already `TaskKind` members; the annotation is
      // what makes that a compile error rather than a runtime surprise if one is renamed.
      task: input.task satisfies TaskKind,
      tier: input.tier,
      usage: input.usage,
      outcome: input.outcome,
      cacheHit: input.cacheHit ?? false,
    });

    void this.#persist(record);

    this.#deps.events.publish({
      type: 'cost-updated',
      runId: input.runId,
      stage: input.stage,
      deltaNanoUsd: record.costNanoUsd,
      totalNanoUsd: this.#deps.cost.totalForRun(this.#scope.projectId, input.runId),
      remainingNanoUsd: this.#deps.cost.remaining(this.#scope.projectId, this.#scope.budget),
    });
  }

  async #persist(record: UsageRecord): Promise<void> {
    const persisted = await this.#deps.runs.appendUsage(record);
    if (isErr(persisted)) {
      this.#deps.logger.error('produce ledger row not persisted', {
        runId: record.runId,
        code: persisted.error.code,
      });
    }
  }
}
