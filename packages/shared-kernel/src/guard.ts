/**
 * Guards for programmer error.
 *
 * The distinction from `Result`: a `Result` models a failure the caller is expected
 * to handle (the network was down, the model refused). A guard models a condition
 * that should be impossible - if it fires, the fix is a code change, not a retry.
 */

import { InternalError, ValidationError } from './errors';

/** Throws `InternalError` when the condition is false. For our own invariants. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new InternalError({ message: `Invariant violated: ${message}` });
  }
}

/** Throws `ValidationError` when the condition is false. For caller-supplied input. */
export function require_(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ValidationError({ message });
  }
}

export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

export function assertDefined<T>(value: T | null | undefined, what: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new InternalError({ message: `Expected ${what} to be defined` });
  }
}

/**
 * Compile-time exhaustiveness check.
 *
 * Put it in the `default` of a switch over a union: adding a new variant then breaks
 * the build at every site that has not handled it. This is how `OCP` is kept honest
 * for the union-shaped parts of the domain (behaviour kinds, export formats, ...).
 */
export function assertNever(value: never, context = 'value'): never {
  throw new InternalError({
    message: `Unhandled ${context}: ${JSON.stringify(value)}`,
    context: { unhandled: value },
  });
}

/** Indexed access that respects `noUncheckedIndexedAccess` without a non-null assertion. */
export function at<T>(items: readonly T[], index: number, what = 'element'): T {
  const value = items[index];
  if (value === undefined) {
    throw new InternalError({
      message: `Expected ${what} at index ${String(index)} of ${String(items.length)}`,
    });
  }
  return value;
}

/** Map lookup that fails loudly rather than propagating `undefined`. */
export function must<K, V>(map: ReadonlyMap<K, V>, key: K, what = 'key'): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new InternalError({ message: `Missing ${what}: ${String(key)}` });
  }
  return value;
}
