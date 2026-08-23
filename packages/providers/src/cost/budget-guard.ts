/**
 * The guard that runs **before** the call.
 *
 * CLAUDE.md non-negotiable #3 is "cost is metered before it is spent", and the second
 * half of that sentence is the whole point: a check that runs after the provider
 * returned is not a guard, it is a receipt. So `check` takes an *estimate*, consults
 * the ledger for what has already gone, and returns `Result<Unit, BudgetExceededError>`
 * with the provider never having been touched.
 *
 * The refusal is deliberately **not retryable** (see `BudgetExceededError`): retrying
 * spends exactly the money the guard just prevented, and a router that treated it as a
 * transient failure would loop until the ceiling was crossed anyway.
 *
 * Three ceilings, because they fail differently: per-run stops one bad prompt loop,
 * per-day stops a runaway scheduler, and per-project is the number the person paying
 * actually agreed to.
 */

import type { BudgetPolicy, RunId } from '@rv/contracts';
import {
  BudgetExceededError,
  type Clock,
  type NanoUsd,
  type Result,
  UNIT,
  type Unit,
  ZERO_USD,
  addUsd,
  err,
  ok,
  toUsd,
} from '@rv/shared-kernel';

import type { SpendReader } from './cost-meter';

/** What is about to be spent, and on whose behalf. */
export interface BudgetCheck {
  readonly runId: RunId;
  /** The pre-call estimate for this one call, in nano-dollars. */
  readonly projectedNanoUsd: NanoUsd;
}

export interface BudgetGuardDeps {
  readonly policy: BudgetPolicy;
  readonly ledger: SpendReader;
  readonly clock: Clock;
  /**
   * Length of the "day" window, in millis. Default 24 h.
   *
   * A parameter rather than a constant so a test does not have to move a clock by a
   * day to exercise the boundary.
   */
  readonly dayWindowMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Named scopes, so a refusal says which ceiling was hit rather than just "budget". */
type Scope = 'run' | 'day' | 'project';

export class BudgetGuard {
  readonly #policy: BudgetPolicy;
  readonly #ledger: SpendReader;
  readonly #clock: Clock;
  readonly #dayWindowMs: number;

  constructor(deps: BudgetGuardDeps) {
    this.#policy = deps.policy;
    this.#ledger = deps.ledger;
    this.#clock = deps.clock;
    this.#dayWindowMs = deps.dayWindowMs ?? DAY_MS;
  }

  /**
   * Refuses before the spend, or gets out of the way.
   *
   * A ceiling of `null` means "no ceiling at this scope" and is skipped entirely -
   * treating an absent limit as zero would refuse every call in the default
   * configuration, which is how a guard gets switched off in anger.
   */
  check(request: BudgetCheck): Result<Unit, BudgetExceededError> {
    const checks: readonly { scope: Scope; limit: number | null; spent: NanoUsd }[] = [
      {
        scope: 'run',
        limit: this.#policy.perRunNanoUsd,
        spent: this.#ledger.totalForRun(request.runId),
      },
      {
        scope: 'day',
        limit: this.#policy.perDayNanoUsd,
        spent: this.#ledger.totalSince(this.#clock.now() - this.#dayWindowMs),
      },
      {
        scope: 'project',
        limit: this.#policy.perProjectNanoUsd,
        spent: this.#ledger.totalNanoUsd(),
      },
    ];

    for (const { scope, limit, spent } of checks) {
      if (limit === null) continue;
      const wouldReach = addUsd(spent, request.projectedNanoUsd);
      if (wouldReach > limit) {
        return err(new BudgetExceededError(scope, toUsd(limit as NanoUsd), toUsd(wouldReach)));
      }
    }

    return ok(UNIT);
  }

  /**
   * Whether this spend crosses the "stop and ask" threshold.
   *
   * Separate from `check` because it is not a refusal: `confirmAboveNanoUsd` exists
   * because the failure mode that matters is not "spent too much", it is "spent
   * anything at all without being asked".
   */
  requiresConfirmation(projectedNanoUsd: NanoUsd): boolean {
    const threshold = this.#policy.confirmAboveNanoUsd;
    return threshold !== null && projectedNanoUsd > threshold;
  }

  /** Remaining headroom at the tightest configured ceiling. `null` when uncapped. */
  remaining(runId: RunId): NanoUsd | null {
    const limits: readonly (number | null)[] = [
      this.#policy.perRunNanoUsd === null
        ? null
        : this.#policy.perRunNanoUsd - this.#ledger.totalForRun(runId),
      this.#policy.perDayNanoUsd === null
        ? null
        : this.#policy.perDayNanoUsd -
          this.#ledger.totalSince(this.#clock.now() - this.#dayWindowMs),
      this.#policy.perProjectNanoUsd === null
        ? null
        : this.#policy.perProjectNanoUsd - this.#ledger.totalNanoUsd(),
    ];

    const present = limits.filter((value): value is number => value !== null);
    if (present.length === 0) return null;
    return Math.max(0, Math.min(...present)) as NanoUsd;
  }

  /** Zero spend so far, for a guard consulted before any call has been made. */
  static get zeroSpend(): SpendReader {
    return {
      totalNanoUsd: () => ZERO_USD,
      totalForRun: () => ZERO_USD,
      totalSince: () => ZERO_USD,
    };
  }
}
