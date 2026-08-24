/**
 * The gate in front of every command that can cost money.
 *
 * Non-negotiable #3 is "cost is metered before it is spent", and on a CLI that means
 * something stricter than a log line after the fact: the estimate is printed, and the
 * call does not happen unless the lane is free or a human typed a flag that says so.
 * The gate returns a decision rather than performing the call, so the same helper
 * serves `style probe`, `assets edit`, `run` and `render` without any of them owning
 * the policy.
 *
 * `--lane free` is the default everywhere. That is not timidity - it is the only lane
 * whose estimate is provably zero, and a tool that generates images should make you say
 * the word before it bills you.
 */

import { AppError, formatUsd, nanoUsd, type NanoUsd } from '@rv/shared-kernel';

import { EXIT, type ExitCode } from './exit';
import type { CliIo } from './io';
import { emitJsonFailure } from './report';

/** The two lanes a command can run on. `free` never leaves the machine's own hardware. */
export const LANES = ['free', 'paid'] as const;
export type Lane = (typeof LANES)[number];

export function parseLane(value: string | undefined): Lane | undefined {
  if (value === undefined) return 'free';
  return LANES.find((lane) => lane === value);
}

export interface SpendRequest {
  /** What the command is about to do, in the user's words. */
  readonly what: string;
  readonly lane: Lane;
  readonly estimateNanoUsd: NanoUsd;
  /** `--yes`. The explicit "spend it" the paid lane requires. */
  readonly approved: boolean;
  readonly json: boolean;
}

export type SpendDecision =
  { readonly proceed: true } | { readonly proceed: false; readonly exit: ExitCode };

/**
 * Prints the estimate and decides whether the call may happen.
 *
 * Three outcomes and each is a real case: the free lane always proceeds and always
 * reports `$0.0000`; the paid lane with `--yes` proceeds after printing what it will
 * cost; the paid lane without it stops with {@link EXIT.spendRefused} and nothing spent.
 */
export function guardSpend(io: CliIo, request: SpendRequest): SpendDecision {
  const estimate = request.lane === 'free' ? nanoUsd(0) : request.estimateNanoUsd;

  if (request.lane === 'free') {
    if (!request.json) io.err(`  ${request.what}: free lane, estimate ${formatUsd(estimate)}`);
    return { proceed: true };
  }

  if (!request.approved) {
    const message =
      `${request.what} would run on the paid lane at an estimated ${formatUsd(estimate)}. ` +
      'Nothing has been spent. Re-run with --lane free, or add --yes to approve the spend.';
    if (request.json) emitJsonFailure(io, new SpendNotApproved(message, estimate));
    else io.err(`  ${message}`);
    return { proceed: false, exit: EXIT.spendRefused };
  }

  if (!request.json) {
    io.err(`  ${request.what}: paid lane approved, estimate ${formatUsd(estimate)}`);
  }
  return { proceed: true };
}

/**
 * The refusal, in the taxonomy.
 *
 * `budget` rather than `validation`: the command line was correct and the machine is
 * healthy - the operation was simply not paid for. A caller that retries on validation
 * failures must not retry this one.
 */
export class SpendNotApproved extends AppError {
  readonly code = 'SPEND_NOT_APPROVED';
  readonly kind = 'budget' as const;
  readonly retryable = false;

  constructor(message: string, estimate: NanoUsd) {
    super({ message, context: { estimateNanoUsd: estimate } });
  }
}
