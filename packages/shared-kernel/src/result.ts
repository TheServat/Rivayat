/**
 * `Result<T, E>` - explicit, typed failure.
 *
 * Why not just throw? Because this codebase orchestrates a dozen fallible remote
 * services and a long resumable pipeline. Exceptions erase which step failed and
 * whether it is worth retrying; a `Result` in the signature makes both part of the
 * type. Throwing is reserved for genuine programmer error (see `guard.ts`).
 *
 * Adapter boundaries convert exceptions into `Result` exactly once, via
 * `fromPromise` / `fromThrowable`.
 */

import type { AppError } from './errors';

export interface Ok<out T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<out E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = AppError> = Ok<T> | Err<E>;

/** A `Result` carrying no meaningful success value. */
export type Unit = Record<string, never>;
export const UNIT: Unit = Object.freeze({});

// ── construction ────────────────────────────────────────────────────────────

export function ok(): Ok<Unit>;
export function ok<T>(value: T): Ok<T>;
export function ok<T>(value?: T): Ok<T | Unit> {
  // `arguments.length`, not a check against `undefined`: `ok(undefined)` means "the
  // value is undefined", while `ok()` means "there is no value". Collapsing the two
  // would silently rewrite a legitimate `Ok<undefined>` into `Ok<Unit>`.
  return { ok: true, value: arguments.length === 0 ? UNIT : (value as T) };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

// ── narrowing ───────────────────────────────────────────────────────────────

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

// ── transformation ──────────────────────────────────────────────────────────

export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Monadic bind: chain a fallible step onto a successful one. */
export function andThen<T, U, E, F>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return result.ok ? fn(result.value) : result;
}

/** Recover from a failure with another fallible step. */
export function orElse<T, U, E, F>(
  result: Result<T, E>,
  fn: (error: E) => Result<U, F>,
): Result<T | U, F> {
  return result.ok ? result : fn(result.error);
}

/** Run a side effect on success without changing the result. */
export function tap<T, E>(result: Result<T, E>, fn: (value: T) => void): Result<T, E> {
  if (result.ok) fn(result.value);
  return result;
}

/** Run a side effect on failure without changing the result. */
export function tapErr<T, E>(result: Result<T, E>, fn: (error: E) => void): Result<T, E> {
  if (!result.ok) fn(result.error);
  return result;
}

// ── extraction ──────────────────────────────────────────────────────────────

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function unwrapOrElse<T, E>(result: Result<T, E>, fn: (error: E) => T): T {
  return result.ok ? result.value : fn(result.error);
}

/**
 * Throws on failure. Only for tests and for the outermost boundary where an
 * error genuinely cannot be handled.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error instanceof Error
    ? result.error
    : new Error(`Called unwrap on an Err: ${JSON.stringify(result.error)}`);
}

// ── combination ─────────────────────────────────────────────────────────────

/** All-or-nothing: first failure short-circuits. */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/**
 * Best-effort: keep both sides.
 *
 * The asset pipeline needs this constantly - if 3 of 40 assets fail to generate we
 * want the 37 and a precise list of the 3, not one opaque rejection.
 */
export function partition<T, E>(
  results: readonly Result<T, E>[],
): { readonly values: T[]; readonly errors: E[] } {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return { values, errors };
}

// ── interop with throwing code ──────────────────────────────────────────────

export function fromThrowable<T, E>(fn: () => T, mapCaught: (caught: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (caught: unknown) {
    return err(mapCaught(caught));
  }
}

export async function fromPromise<T, E>(
  promise: Promise<T>,
  mapCaught: (caught: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (caught: unknown) {
    return err(mapCaught(caught));
  }
}
