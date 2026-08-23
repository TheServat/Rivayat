/**
 * Time as a dependency.
 *
 * Nothing in this codebase may call `Date.now()` directly. Renders must be
 * bit-reproducible and pipeline stages must be replayable, both of which break the
 * moment wall-clock time leaks into logic. Inject a `Clock`; use `FixedClock` in tests.
 */

import type { Brand } from './brand';

/** Milliseconds since the Unix epoch. */
export type Instant = Brand<number, 'Instant'>;

/** A duration in milliseconds. Distinct from `Instant` so the two cannot be swapped. */
export type Millis = Brand<number, 'Millis'>;

export function instant(epochMillis: number): Instant {
  return epochMillis as Instant;
}

export function millis(value: number): Millis {
  return value as Millis;
}

export function toIso(value: Instant): string {
  return new Date(value).toISOString();
}

export function fromIso(iso: string): Instant {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`Not an ISO-8601 instant: ${iso}`);
  }
  return instant(parsed);
}

export function addMillis(value: Instant, delta: Millis): Instant {
  return instant(value + delta);
}

export function since(from: Instant, to: Instant): Millis {
  return millis(to - from);
}

export interface Clock {
  now(): Instant;
}

export class SystemClock implements Clock {
  now(): Instant {
    return instant(Date.now());
  }
}

/**
 * A clock that only moves when told to.
 *
 * Use in every test that touches timestamps, and in deterministic replays of a
 * pipeline run.
 */
export class FixedClock implements Clock {
  #current: Instant;

  constructor(start: Instant | string = instant(0)) {
    this.#current = typeof start === 'string' ? fromIso(start) : start;
  }

  now(): Instant {
    return this.#current;
  }

  set(value: Instant): void {
    this.#current = value;
  }

  advance(delta: Millis | number): Instant {
    this.#current = instant(this.#current + delta);
    return this.#current;
  }
}
