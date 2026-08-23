/**
 * Exponential backoff with jitter.
 *
 * Three things make this non-obvious enough to be its own module:
 *
 *  - **The jitter comes from an injected `Rng`, never `Math.random()`.** CLAUDE.md #1:
 *    a pipeline run must be replayable, and a run whose retry timing is unrepeatable
 *    is not. Seeded jitter still de-synchronises parallel jobs, which is the only
 *    thing jitter is for.
 *  - **`RateLimitError.retryAfterMs` wins over the computed delay when the provider
 *    sent one.** Ignoring it is how a client gets banned rather than throttled.
 *  - **`AppError.retryable` decides, not the status code.** The mapping from status to
 *    retryability already happened in `http/errors.ts`; re-deriving it here would give
 *    us two answers to the same question.
 */

import {
  type AppError,
  CancelledError,
  type Result,
  type Rng,
  err,
  isErr,
} from '@rv/shared-kernel';

export interface RetryOptions {
  /** Total attempts including the first. `1` disables retrying. */
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly backoffMultiplier: number;
  readonly maxBackoffMs: number;
  /** Fraction of the delay to randomise, 0..1. */
  readonly jitter: number;
  /** Seeded. See the module header. */
  readonly rng: Rng;
  /** Injected so tests do not spend real seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Called before each wait, for logging and for tests to observe the schedule. */
  readonly onRetry?: (attempt: number, delayMs: number, error: AppError) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The delay before attempt `attempt` (1-based; attempt 1 never waits).
 *
 * Jitter is *symmetric* around the base delay rather than only subtractive: a purely
 * subtractive jitter shortens the average wait, which is the opposite of what backoff
 * is for under sustained load.
 */
export function computeBackoffMs(
  attempt: number,
  options: Pick<RetryOptions, 'initialBackoffMs' | 'backoffMultiplier' | 'maxBackoffMs' | 'jitter'>,
  rng: Rng,
): number {
  const exponential =
    options.initialBackoffMs * Math.pow(options.backoffMultiplier, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, options.maxBackoffMs);
  if (options.jitter <= 0) return Math.round(capped);

  const spread = capped * options.jitter;
  const jittered = capped + rng.float(-spread, spread);
  return Math.round(Math.max(0, Math.min(jittered, options.maxBackoffMs)));
}

/** Reads a provider-supplied delay off the error, when it carried one. */
function retryAfterOf(error: AppError): number | undefined {
  const value: unknown = (error as unknown as Record<string, unknown>).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Runs `operation`, retrying while the failure says it is worth retrying.
 *
 * The operation returns a `Result`; nothing here catches exceptions, because an
 * adapter that throws has already broken its contract and swallowing it would hide
 * that (the shared contract suite asserts adapters never throw).
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<Result<T, AppError>>,
  options: RetryOptions,
): Promise<Result<T, AppError>> {
  const sleep = options.sleep ?? defaultSleep;
  const attempts = Math.max(1, options.maxAttempts);
  let last: Result<T, AppError> | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted === true) {
      return err(new CancelledError(`retry attempt ${String(attempt)}`));
    }

    const outcome = await operation(attempt);
    if (!isErr(outcome)) return outcome;
    last = outcome;

    if (!outcome.error.retryable || attempt === attempts) break;

    // The provider's own figure outranks ours: it knows when its window resets.
    const delay = retryAfterOf(outcome.error) ?? computeBackoffMs(attempt, options, options.rng);
    options.onRetry?.(attempt, delay, outcome.error);
    await sleep(delay);
  }

  // `last` is always set: the loop runs at least once and only exits via `break`
  // after assigning, or via a `return` on success.
  return last ?? err(new CancelledError('retry produced no outcome'));
}
