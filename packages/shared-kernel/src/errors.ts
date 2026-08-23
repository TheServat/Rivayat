/**
 * The error taxonomy.
 *
 * Two properties drive real behaviour and are therefore mandatory on every error:
 *
 *  - `kind`      - what class of problem this is, so callers can branch without
 *                  string-matching messages.
 *  - `retryable` - whether retrying the *same* call could plausibly succeed. The
 *                  provider router reads this to decide backoff vs. failover, so
 *                  getting it wrong is a real bug, not a cosmetic one.
 */

export type ErrorKind =
  /** Input did not satisfy a schema or invariant. Never retryable. */
  | 'validation'
  /** A referenced entity does not exist. */
  | 'not-found'
  /** State changed underneath us, or a uniqueness constraint was violated. */
  | 'conflict'
  /** The requested capability is not implemented by this adapter. */
  | 'unsupported'
  /** An upstream provider failed. Retryability depends on the status. */
  | 'provider'
  /** A deadline elapsed. */
  | 'timeout'
  /** Upstream asked us to slow down. */
  | 'rate-limit'
  /** The operation would exceed a configured spending limit. */
  | 'budget'
  /** The caller aborted. */
  | 'cancelled'
  /** A bug on our side. */
  | 'internal';

export interface AppErrorOptions {
  readonly message: string;
  /** Structured fields for logging. Must not contain secrets. */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export interface SerialisedError {
  readonly name: string;
  readonly code: string;
  readonly kind: ErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;
  readonly cause?: SerialisedError | string;
}

export abstract class AppError extends Error {
  /** Stable, machine-readable identifier. Safe to switch on and to show in an API. */
  abstract readonly code: string;
  abstract readonly kind: ErrorKind;
  abstract readonly retryable: boolean;

  readonly context: Readonly<Record<string, unknown>>;

  // Public rather than protected: subclasses that add no fields of their own would
  // otherwise inherit a protected constructor and become impossible to construct.
  constructor(options: AppErrorOptions) {
    super(options.message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.context = options.context ?? {};
    // Keep the subclass frame at the top of the stack rather than this constructor.
    Error.captureStackTrace(this, new.target);
  }

  toJSON(): SerialisedError {
    const base = {
      name: this.name,
      code: this.code,
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
    if (this.cause === undefined) return base;
    return {
      ...base,
      cause: this.cause instanceof AppError ? this.cause.toJSON() : describeCause(this.cause),
    };
  }

  override toString(): string {
    return `${this.name}[${this.code}]: ${this.message}`;
  }
}

/**
 * Renders an unknown `cause` for the log without risking `[object Object]`.
 *
 * A cause is whatever a third-party library threw, so it may be anything at all.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') return cause;
  try {
    // Typed as `string` by lib.dom, but genuinely returns `undefined` for undefined, a
    // function or a symbol - all of which a third-party library can throw. Widened to
    // `unknown` so the check is real rather than one the compiler thinks is dead.
    const json: unknown = JSON.stringify(cause);
    return typeof json === 'string' ? json : Object.prototype.toString.call(cause);
  } catch {
    return Object.prototype.toString.call(cause);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** True when retrying the identical call could plausibly succeed. */
export function isRetryable(value: unknown): boolean {
  return isAppError(value) && value.retryable;
}

// ── concrete errors ─────────────────────────────────────────────────────────

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_FAILED';
  readonly kind = 'validation' as const;
  readonly retryable = false;

  constructor(options: AppErrorOptions & { readonly issues?: readonly string[] }) {
    super(options);
  }
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';
  readonly kind = 'not-found' as const;
  readonly retryable = false;

  constructor(resource: string, id: string, options?: Omit<AppErrorOptions, 'message'>) {
    // `resource` and `id` are merged *into* the caller's context rather than replacing
    // it. Overwriting silently discarded whatever diagnostic fields the caller passed
    // alongside, which is exactly when they are most wanted.
    super({
      ...options,
      message: `${resource} not found: ${id}`,
      context: { ...options?.context, resource, id },
    });
  }
}

export class ConflictError extends AppError {
  readonly code = 'CONFLICT';
  readonly kind = 'conflict' as const;
  readonly retryable = false;
}

/**
 * An adapter was asked for something it does not implement.
 *
 * This should be rare at runtime: the router consults the capability matrix first.
 * Reaching this error means the matrix and the adapter disagree.
 */
export class UnsupportedCapabilityError extends AppError {
  readonly code = 'UNSUPPORTED_CAPABILITY';
  readonly kind = 'unsupported' as const;
  readonly retryable = false;

  constructor(provider: string, capability: string) {
    super({
      message: `Provider "${provider}" does not support capability "${capability}"`,
      context: { provider, capability },
    });
  }
}

export class ProviderError extends AppError {
  readonly code = 'PROVIDER_ERROR';
  readonly kind = 'provider' as const;
  readonly retryable: boolean;
  readonly provider: string;
  readonly status: number | undefined;

  constructor(
    options: AppErrorOptions & {
      readonly provider: string;
      readonly status?: number;
      /** Defaults to true for 5xx and 408/429, false otherwise. */
      readonly retryable?: boolean;
    },
  ) {
    super({
      ...options,
      context: { ...options.context, provider: options.provider, status: options.status },
    });
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? defaultRetryableForStatus(options.status);
  }
}

function defaultRetryableForStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network-level failure: worth one more try
  return status >= 500 || status === 408 || status === 429;
}

export class TimeoutError extends AppError {
  readonly code = 'TIMEOUT';
  readonly kind = 'timeout' as const;
  readonly retryable = true;

  constructor(operation: string, timeoutMs: number) {
    super({
      message: `Operation "${operation}" timed out after ${String(timeoutMs)}ms`,
      context: { operation, timeoutMs },
    });
  }
}

export class RateLimitError extends AppError {
  readonly code = 'RATE_LIMITED';
  readonly kind = 'rate-limit' as const;
  readonly retryable = true;
  /** Milliseconds the provider asked us to wait, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(provider: string, retryAfterMs?: number) {
    super({
      message: `Rate limited by "${provider}"`,
      context: { provider, retryAfterMs },
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The operation was refused because it would exceed a spending limit.
 *
 * Deliberately not retryable: retrying spends the money the guard just prevented.
 */
export class BudgetExceededError extends AppError {
  readonly code = 'BUDGET_EXCEEDED';
  readonly kind = 'budget' as const;
  readonly retryable = false;

  constructor(scope: string, limitUsd: number, wouldSpendUsd: number) {
    super({
      message: `Budget for "${scope}" exceeded: limit $${limitUsd.toFixed(4)}, this call would reach $${wouldSpendUsd.toFixed(4)}`,
      context: { scope, limitUsd, wouldSpendUsd },
    });
  }
}

export class CancelledError extends AppError {
  readonly code = 'CANCELLED';
  readonly kind = 'cancelled' as const;
  readonly retryable = false;

  constructor(operation: string) {
    super({ message: `Operation "${operation}" was cancelled`, context: { operation } });
  }
}

export class InternalError extends AppError {
  readonly code = 'INTERNAL_ERROR';
  readonly kind = 'internal' as const;
  readonly retryable = false;
}

/**
 * Last-resort conversion for a value caught from third-party code.
 *
 * Adapters should map known shapes to a specific error first; this is the floor,
 * not the default.
 */
export function toAppError(caught: unknown, fallbackMessage = 'Unexpected error'): AppError {
  if (isAppError(caught)) return caught;
  if (caught instanceof Error) {
    return new InternalError({ message: caught.message, cause: caught });
  }
  return new InternalError({ message: fallbackMessage, context: { caught: String(caught) } });
}
