/**
 * The one path a provider call is allowed to take.
 *
 * Non-negotiable #3 has two halves and they are easy to half-implement: every call is
 * metered, **and the guard runs before the spend**. A meter without a pre-flight guard
 * is a receipt; a guard that runs after the response has arrived is a receipt with an
 * opinion. So the order here is fixed and the type makes it hard to get wrong - the
 * caller hands over a *closure*, and this decides whether to invoke it.
 *
 * Refusal happens with the closure un-invoked. The e2e suite asserts exactly that by
 * counting calls on a fake provider: a budget test that only checks the status code
 * would pass on an implementation that pays for the call and then reports 402.
 *
 * Every outcome, including a refusal and including a failure, produces an event on the
 * run stream. "How much has this cost so far" has to be answerable while the run is
 * still going, which is the whole point of putting cost on the SSE channel.
 */

import type {
  PipelineStageKey,
  ProjectId,
  ProviderKind,
  QualityTier,
  TaskKind,
} from '@rv/contracts';
import type { ProviderUsage } from '@rv/providers';
import { type AppError, type Logger, type Result, isErr, ok, toUsd } from '@rv/shared-kernel';

import type { RunEventBus } from '../events/run-event-bus';
import type { RunRepository } from '../application/ports/repository.ports';
import type { CostService, RunBudget } from './cost.service';

/** What the call will produce, in the units the meter prices. */
export interface MeteredCallSpec {
  readonly projectId: ProjectId;
  readonly budget: RunBudget;
  readonly stage: PipelineStageKey;
  readonly task: TaskKind;
  readonly tier: QualityTier;
  readonly provider: ProviderKind;
  readonly model: string;
  /**
   * The pre-flight estimate.
   *
   * Deliberately the caller's job: only the caller knows how many tokens its prompt is
   * and how many images it is asking for, and a guard that estimated from nothing
   * would wave through the one call that matters.
   */
  readonly estimate: ProviderUsage;
}

/** What the closure returns: the value, and what it actually consumed. */
export interface MeteredOutcome<T> {
  readonly value: T;
  readonly usage: ProviderUsage;
}

export interface MeteredCallRunnerDeps {
  readonly cost: CostService;
  readonly events: RunEventBus;
  readonly runs: RunRepository;
  readonly logger: Logger;
}

export class MeteredCallRunner {
  readonly #cost: CostService;
  readonly #events: RunEventBus;
  readonly #runs: RunRepository;
  readonly #logger: Logger;

  constructor(deps: MeteredCallRunnerDeps) {
    this.#cost = deps.cost;
    this.#events = deps.events;
    this.#runs = deps.runs;
    this.#logger = deps.logger.child({ component: 'metered-call' });
  }

  /**
   * Guard, then call, then meter. In that order, always.
   *
   * @param call invoked only if the guard allows the projected spend
   */
  async run<T>(
    spec: MeteredCallSpec,
    call: () => Promise<Result<MeteredOutcome<T>, AppError>>,
  ): Promise<Result<T, AppError>> {
    const projected = this.#cost.price(spec.projectId, spec.provider, spec.model, spec.estimate);

    const allowed = this.#cost.check(spec.projectId, spec.budget, projected);
    if (isErr(allowed)) {
      this.#logger.warn('call refused by the budget guard', {
        stage: spec.stage,
        model: `${spec.provider}:${spec.model}`,
        projectedUsd: toUsd(projected),
      });
      this.#events.publish({
        type: 'issue-raised',
        runId: spec.budget.runId,
        stage: spec.stage,
        severity: 'error',
        code: allowed.error.code,
        message: allowed.error.message,
      });
      return allowed;
    }

    const outcome = await call();

    // Recorded on both paths: a call that burned input tokens and then returned a 500
    // still cost money, and a ledger that only records successes under-reports exactly
    // the runs worth understanding.
    const usage: ProviderUsage = isErr(outcome)
      ? { ...spec.estimate, latencyMs: spec.estimate.latencyMs }
      : outcome.value.usage;

    const record = this.#cost.record(spec.projectId, {
      runId: spec.budget.runId,
      stage: spec.stage,
      provider: spec.provider,
      model: spec.model,
      task: spec.task,
      tier: spec.tier,
      usage,
      outcome: isErr(outcome) ? 'failure' : 'success',
      errorCode: isErr(outcome) ? outcome.error.code : null,
    });

    const persisted = await this.#runs.appendUsage(record);
    if (isErr(persisted)) {
      // The in-memory ledger is authoritative for the guard, so a persistence failure
      // must not fail the call - but it does mean the run resource will under-report,
      // which is worth an error line rather than a silent shrug.
      this.#logger.error('ledger row not persisted', {
        runId: spec.budget.runId,
        code: persisted.error.code,
      });
    }

    this.#events.publish({
      type: 'cost-updated',
      runId: spec.budget.runId,
      stage: spec.stage,
      deltaNanoUsd: record.costNanoUsd,
      totalNanoUsd: this.#cost.totalForRun(spec.projectId, spec.budget.runId),
      remainingNanoUsd: this.#cost.remaining(spec.projectId, spec.budget),
    });

    return isErr(outcome) ? outcome : ok(outcome.value.value);
  }
}
