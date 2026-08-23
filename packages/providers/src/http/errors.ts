/**
 * The one place a provider failure becomes an `AppError`.
 *
 * `AppError.retryable` is not cosmetic - the router reads it to decide backoff versus
 * failover versus give up (see `@rv/shared-kernel/errors`). So the mapping is a real
 * module with real tests rather than a `catch` block copied into four adapters, and
 * the shared contract suite asserts every adapter agrees with it.
 *
 * The rules, in the order they are applied:
 *
 *  | condition                        | error                      | retryable |
 *  | -------------------------------- | -------------------------- | --------- |
 *  | caller's signal aborted          | `CancelledError`           | no        |
 *  | fetch threw `AbortError`         | `CancelledError`           | no        |
 *  | fetch threw `TimeoutError`       | `TimeoutError`             | yes       |
 *  | fetch threw anything else        | `ProviderError`            | yes       |
 *  | HTTP 429                         | `RateLimitError`           | yes       |
 *  | HTTP 408 / 5xx                   | `ProviderError`            | yes       |
 *  | any other 4xx                    | `ProviderError`            | no        |
 *
 * A thrown fetch is retryable because at that point we do not know whether the
 * request was even sent; a 4xx is not, because the same bytes will be rejected again.
 */

import {
  type AppError,
  CancelledError,
  ProviderError,
  RateLimitError,
  TimeoutError,
} from '@rv/shared-kernel';

/** Longest body excerpt carried into an error message. Enough to read, short enough to log. */
const BODY_SNIPPET_LIMIT = 400;

/**
 * Parses `Retry-After`, which is either delta-seconds or an HTTP-date (RFC 9110).
 *
 * Returns `undefined` for an absent or unparseable header rather than guessing a
 * delay: `RateLimitError.retryAfterMs` being absent means "we were not told", and the
 * backoff has a sane default for that. Inventing a number here would look like the
 * provider asked for it.
 */
export function parseRetryAfterMs(headerValue: string | null, nowMs: number): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === '') return undefined;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.round(Number.parseFloat(trimmed) * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  // A date in the past means "you may retry now", not "retry a negative time ago".
  return Math.max(0, asDate - nowMs);
}

/** Reads a header from either a real `Headers` or a plain record, case-insensitively. */
function headerOf(
  headers: Headers | Readonly<Record<string, string>>,
  name: string,
): string | null {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const record = headers as Readonly<Record<string, string>>;
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return null;
}

export interface HttpFailure {
  readonly provider: string;
  readonly status: number;
  readonly statusText?: string;
  readonly headers: Headers | Readonly<Record<string, string>>;
  /** Response body as text, already read. Truncated before it reaches the error. */
  readonly body?: string;
  /** Wall clock in millis, injected so `Retry-After: <http-date>` is testable. */
  readonly nowMs: number;
  /** What was being attempted, e.g. `POST /api/chat`. */
  readonly operation: string;
}

/** Maps a non-2xx HTTP response to the right error. */
export function errorFromResponse(failure: HttpFailure): AppError {
  const snippet = (failure.body ?? '').slice(0, BODY_SNIPPET_LIMIT);

  if (failure.status === 429) {
    const retryAfterMs = parseRetryAfterMs(headerOf(failure.headers, 'retry-after'), failure.nowMs);
    // `RateLimitError`'s constructor takes an optional second argument, and
    // `exactOptionalPropertyTypes` makes "absent" and "explicitly undefined" different
    // things - so the two cases are spelled out rather than passed through.
    return retryAfterMs === undefined
      ? new RateLimitError(failure.provider)
      : new RateLimitError(failure.provider, retryAfterMs);
  }

  return new ProviderError({
    message:
      `${failure.operation} failed: ${String(failure.status)} ${failure.statusText ?? ''}`.trim(),
    provider: failure.provider,
    status: failure.status,
    context: { operation: failure.operation, body: snippet },
  });
}

export interface ThrownFailure {
  readonly provider: string;
  readonly operation: string;
  readonly caught: unknown;
  /** The caller's signal, if any. An aborted one outranks whatever fetch threw. */
  readonly signal?: AbortSignal;
  /** Used only to describe a `TimeoutError`. */
  readonly timeoutMs?: number;
}

/**
 * Maps an exception escaping `fetch` (or a vendor SDK) to an `AppError`.
 *
 * The caller's signal is checked first because `fetch` reports an internal timeout
 * abort and a user cancellation with the same `AbortError`, and the two must not be
 * conflated: one is retryable, the other is the user saying stop.
 */
export function errorFromThrown(failure: ThrownFailure): AppError {
  if (failure.signal?.aborted === true) return new CancelledError(failure.operation);

  const name = failure.caught instanceof Error ? failure.caught.name : '';
  if (name === 'AbortError') return new CancelledError(failure.operation);
  if (name === 'TimeoutError') {
    return new TimeoutError(failure.operation, failure.timeoutMs ?? 0);
  }

  const message = failure.caught instanceof Error ? failure.caught.message : String(failure.caught);
  return new ProviderError({
    message: `${failure.operation} failed: ${message}`,
    provider: failure.provider,
    // No status: the request may never have left the machine, so one more try is fair.
    retryable: true,
    context: { operation: failure.operation },
    cause: failure.caught,
  });
}

/**
 * Maps an error a vendor SDK threw, using the numeric status it carries when it has one.
 *
 * `@google/genai` throws `ApiError { status }`; reading it structurally rather than by
 * `instanceof` means the mapping keeps working when the SDK is stubbed in a test and
 * when a future version renames the class.
 */
export function errorFromSdk(failure: ThrownFailure & { readonly nowMs: number }): AppError {
  const status = statusOf(failure.caught);
  if (status === undefined) return errorFromThrown(failure);
  if (failure.signal?.aborted === true) return new CancelledError(failure.operation);

  const message = failure.caught instanceof Error ? failure.caught.message : String(failure.caught);
  if (status === 429) {
    const retryAfterMs = retryAfterOf(failure.caught, failure.nowMs);
    return retryAfterMs === undefined
      ? new RateLimitError(failure.provider)
      : new RateLimitError(failure.provider, retryAfterMs);
  }

  return new ProviderError({
    message: `${failure.operation} failed: ${String(status)} ${message}`,
    provider: failure.provider,
    status,
    context: { operation: failure.operation },
    cause: failure.caught,
  });
}

function statusOf(caught: unknown): number | undefined {
  if (caught === null || typeof caught !== 'object') return undefined;
  const status: unknown = (caught as Record<string, unknown>).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/** Digs a `Retry-After` out of whatever headers an SDK error happened to keep. */
function retryAfterOf(caught: unknown, nowMs: number): number | undefined {
  if (caught === null || typeof caught !== 'object') return undefined;
  const headers: unknown = (caught as Record<string, unknown>).headers;
  if (headers === null || typeof headers !== 'object') return undefined;
  return parseRetryAfterMs(
    headerOf(headers as Readonly<Record<string, string>>, 'retry-after'),
    nowMs,
  );
}
