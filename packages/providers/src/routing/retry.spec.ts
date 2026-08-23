import { describe, expect, it, vi } from 'vitest';
import {
  CancelledError,
  ProviderError,
  RateLimitError,
  ValidationError,
  createRng,
  err,
  isErr,
  isOk,
  ok,
  type AppError,
  type Result,
} from '@rv/shared-kernel';

import { recordingSleep, testRng } from '../__fixtures__/support';
import { computeBackoffMs, withRetry } from './retry';

const BACKOFF = {
  initialBackoffMs: 100,
  backoffMultiplier: 2,
  maxBackoffMs: 5_000,
  jitter: 0.2,
};

describe('computeBackoffMs', () => {
  it('grows exponentially and honours the cap', () => {
    const noJitter = { ...BACKOFF, jitter: 0 };
    const rng = testRng();
    expect(computeBackoffMs(1, noJitter, rng)).toBe(100);
    expect(computeBackoffMs(2, noJitter, rng)).toBe(200);
    expect(computeBackoffMs(3, noJitter, rng)).toBe(400);
    expect(computeBackoffMs(20, noJitter, rng)).toBe(5_000);
  });

  it('is deterministic for a given seed', () => {
    // CLAUDE.md #1: a run whose retry timing is unrepeatable is not replayable. Two
    // generators built from the same seed must produce the same schedule.
    const a = Array.from({ length: 5 }, (_, i) =>
      computeBackoffMs(i + 1, BACKOFF, createRng('same-seed')),
    );
    const b = Array.from({ length: 5 }, (_, i) =>
      computeBackoffMs(i + 1, BACKOFF, createRng('same-seed')),
    );
    expect(a).toEqual(b);
  });

  it('differs between seeds, which is the only thing jitter is for', () => {
    const a = computeBackoffMs(4, BACKOFF, createRng('worker-1'));
    const b = computeBackoffMs(4, BACKOFF, createRng('worker-2'));
    expect(a).not.toBe(b);
  });

  it('jitters symmetrically around the base delay and never below zero', () => {
    const samples = Array.from({ length: 200 }, (_, i) =>
      computeBackoffMs(2, BACKOFF, createRng(`seed-${String(i)}`)),
    );
    const base = 200;
    const spread = base * BACKOFF.jitter;
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(Math.round(base - spread));
    expect(Math.max(...samples)).toBeLessThanOrEqual(Math.round(base + spread));
    // Symmetric, not purely subtractive: some draws must land above the base delay.
    expect(samples.some((value) => value > base)).toBe(true);
    expect(samples.some((value) => value < base)).toBe(true);
  });

  it('never exceeds the cap even after jitter', () => {
    const value = computeBackoffMs(9, { ...BACKOFF, maxBackoffMs: 1_000 }, createRng('x'));
    expect(value).toBeLessThanOrEqual(1_000);
  });
});

describe('withRetry', () => {
  it('returns the first success without waiting', async () => {
    const { sleep, waits } = recordingSleep();
    const operation = vi.fn(() => Promise.resolve(ok('done')));

    const outcome = await withRetry(operation, {
      maxAttempts: 3,
      ...BACKOFF,
      rng: testRng(),
      sleep,
    });

    expect(isOk(outcome)).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('retries a retryable failure and reports the attempt number', async () => {
    const { sleep, waits } = recordingSleep();
    const seen: number[] = [];
    const operation = (attempt: number): Promise<Result<string, AppError>> => {
      seen.push(attempt);
      return Promise.resolve(
        attempt < 3
          ? err(new ProviderError({ message: 'boom', provider: 'x', status: 503 }))
          : ok('done'),
      );
    };

    const outcome = await withRetry(operation, {
      maxAttempts: 4,
      ...BACKOFF,
      rng: testRng(),
      sleep,
    });

    expect(isOk(outcome)).toBe(true);
    expect(seen).toEqual([1, 2, 3]);
    expect(waits).toHaveLength(2);
  });

  it('stops immediately on a non-retryable failure', async () => {
    const { sleep, waits } = recordingSleep();
    const operation = vi.fn(() =>
      Promise.resolve(err(new ValidationError({ message: 'bad input' }))),
    );

    const outcome = await withRetry(operation, {
      maxAttempts: 5,
      ...BACKOFF,
      rng: testRng(),
      sleep,
    });

    expect(isErr(outcome)).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('obeys the provider’s retryAfterMs over the computed backoff', async () => {
    // Ignoring the header is how a client gets banned rather than throttled.
    const { sleep, waits } = recordingSleep();
    let attempts = 0;
    const operation = (): Promise<Result<string, AppError>> => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1 ? err(new RateLimitError('openrouter', 4_321)) : ok('done'),
      );
    };

    await withRetry(operation, { maxAttempts: 3, ...BACKOFF, rng: testRng(), sleep });

    expect(waits).toEqual([4_321]);
  });

  it('falls back to computed backoff when the provider gave no delay', async () => {
    const { sleep, waits } = recordingSleep();
    let attempts = 0;
    const operation = (): Promise<Result<string, AppError>> => {
      attempts += 1;
      return Promise.resolve(attempts === 1 ? err(new RateLimitError('openrouter')) : ok('done'));
    };

    await withRetry(operation, { maxAttempts: 3, ...BACKOFF, jitter: 0, rng: testRng(), sleep });

    expect(waits).toEqual([100]);
  });

  it('gives up after maxAttempts and returns the last error', async () => {
    const { sleep } = recordingSleep();
    const operation = vi.fn(() =>
      Promise.resolve(
        err(new ProviderError({ message: 'still down', provider: 'x', status: 500 })),
      ),
    );

    const outcome = await withRetry(operation, {
      maxAttempts: 3,
      ...BACKOFF,
      rng: testRng(),
      sleep,
    });

    expect(operation).toHaveBeenCalledTimes(3);
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.message).toContain('still down');
  });

  it('treats maxAttempts below one as a single attempt', async () => {
    const operation = vi.fn(() => Promise.resolve(ok('once')));
    await withRetry(operation, { maxAttempts: 0, ...BACKOFF, rng: testRng() });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('reports each retry through the callback', async () => {
    const { sleep } = recordingSleep();
    const seen: { attempt: number; delay: number; code: string }[] = [];
    let attempts = 0;

    await withRetry(
      (): Promise<Result<string, AppError>> => {
        attempts += 1;
        return Promise.resolve(
          attempts < 2
            ? err(new ProviderError({ message: 'x', provider: 'p', status: 502 }))
            : ok('done'),
        );
      },
      {
        maxAttempts: 3,
        ...BACKOFF,
        rng: testRng(),
        sleep,
        onRetry: (attempt, delay, error) => seen.push({ attempt, delay, code: error.code }),
      },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.code).toBe('PROVIDER_ERROR');
  });

  it('stops before the first attempt when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(() => Promise.resolve(ok('never')));

    const outcome = await withRetry(operation, {
      maxAttempts: 3,
      ...BACKOFF,
      rng: testRng(),
      signal: controller.signal,
    });

    expect(operation).not.toHaveBeenCalled();
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error).toBeInstanceOf(CancelledError);
  });

  it('stops between attempts when the caller aborts mid-flight', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const outcome = await withRetry(
      (): Promise<Result<string, AppError>> => {
        attempts += 1;
        controller.abort();
        return Promise.resolve(
          err(new ProviderError({ message: 'x', provider: 'p', status: 500 })),
        );
      },
      {
        maxAttempts: 4,
        ...BACKOFF,
        rng: testRng(),
        sleep: () => Promise.resolve(),
        signal: controller.signal,
      },
    );

    expect(attempts).toBe(1);
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('cancelled');
  });

  it('uses a real timer when no sleep is injected', async () => {
    let attempts = 0;
    const outcome = await withRetry(
      (): Promise<Result<string, AppError>> => {
        attempts += 1;
        return Promise.resolve(attempts === 1 ? err(new RateLimitError('x', 1)) : ok('done'));
      },
      { maxAttempts: 2, ...BACKOFF, rng: testRng() },
    );
    expect(isOk(outcome)).toBe(true);
  });
});
