import { describe, expect, it } from 'vitest';
import { CancelledError, ProviderError, RateLimitError, TimeoutError } from '@rv/shared-kernel';

import { errorFromResponse, errorFromSdk, errorFromThrown, parseRetryAfterMs } from './errors';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('30', NOW)).toBe(30_000);
    expect(parseRetryAfterMs(' 2.5 ', NOW)).toBe(2_500);
  });

  it('reads an HTTP-date as a delay from now', () => {
    expect(parseRetryAfterMs('Sun, 23 Aug 2026 12:00:45 GMT', NOW)).toBe(45_000);
  });

  it('clamps a past HTTP-date to zero rather than going negative', () => {
    expect(parseRetryAfterMs('Sun, 23 Aug 2026 11:59:00 GMT', NOW)).toBe(0);
  });

  it('returns undefined when the header is absent or unparseable', () => {
    // Absent means "we were not told", which the backoff handles differently from a
    // delay of zero - so this must not fall back to a number.
    expect(parseRetryAfterMs(null, NOW)).toBeUndefined();
    expect(parseRetryAfterMs('', NOW)).toBeUndefined();
    expect(parseRetryAfterMs('soon', NOW)).toBeUndefined();
  });
});

describe('errorFromResponse', () => {
  const base = { provider: 'ollama', operation: 'POST /api/chat', nowMs: NOW };

  it('maps 429 to a retryable RateLimitError carrying retryAfterMs', () => {
    const error = errorFromResponse({
      ...base,
      status: 429,
      headers: { 'Retry-After': '12' },
    });

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.kind).toBe('rate-limit');
    expect(error.retryable).toBe(true);
    expect((error as RateLimitError).retryAfterMs).toBe(12_000);
  });

  it('maps 429 without the header to a RateLimitError with no delay', () => {
    const error = errorFromResponse({ ...base, status: 429, headers: {} });
    expect((error as RateLimitError).retryAfterMs).toBeUndefined();
  });

  it('reads Retry-After from a real Headers object, case-insensitively', () => {
    const error = errorFromResponse({
      ...base,
      status: 429,
      headers: new Headers({ 'retry-after': '3' }),
    });
    expect((error as RateLimitError).retryAfterMs).toBe(3_000);
  });

  it.each([500, 502, 503, 408])('treats %i as retryable', (status) => {
    const error = errorFromResponse({ ...base, status, headers: {} });
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    expect((error as ProviderError).status).toBe(status);
  });

  it.each([400, 401, 403, 404, 422])('treats %i as not retryable', (status) => {
    const error = errorFromResponse({ ...base, status, headers: {} });
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(false);
  });

  it('carries a truncated body excerpt for diagnosis', () => {
    const error = errorFromResponse({
      ...base,
      status: 400,
      headers: {},
      body: 'x'.repeat(1000),
    });
    expect(String(error.context.body)).toHaveLength(400);
  });
});

describe('errorFromThrown', () => {
  it('maps an aborted caller signal to CancelledError even when fetch threw something else', () => {
    const controller = new AbortController();
    controller.abort();

    const error = errorFromThrown({
      provider: 'gemini',
      operation: 'generateContent',
      caught: new Error('socket hang up'),
      signal: controller.signal,
    });

    expect(error).toBeInstanceOf(CancelledError);
    expect(error.retryable).toBe(false);
  });

  it('maps a fetch AbortError to CancelledError', () => {
    const error = errorFromThrown({
      provider: 'ollama',
      operation: 'POST /api/chat',
      caught: new DOMException('aborted', 'AbortError'),
    });
    expect(error.kind).toBe('cancelled');
  });

  it('maps a fetch TimeoutError to a retryable TimeoutError', () => {
    const error = errorFromThrown({
      provider: 'ollama',
      operation: 'POST /api/chat',
      caught: new DOMException('timed out', 'TimeoutError'),
      timeoutMs: 5_000,
    });
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.retryable).toBe(true);
  });

  it('maps a network failure to a retryable ProviderError', () => {
    // No status: the request may never have left the machine, so one more try is fair.
    const error = errorFromThrown({
      provider: 'comfyui',
      operation: 'POST /prompt',
      caught: new TypeError('fetch failed'),
    });
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    expect((error as ProviderError).status).toBeUndefined();
  });

  it('handles a non-Error throw without losing the value', () => {
    const error = errorFromThrown({ provider: 'x', operation: 'op', caught: 'boom' });
    expect(error.message).toContain('boom');
  });
});

describe('errorFromSdk', () => {
  it('uses a numeric status carried by the SDK error', () => {
    const caught = Object.assign(new Error('quota'), { status: 503 });
    const error = errorFromSdk({
      provider: 'gemini',
      operation: 'generateContent',
      caught,
      nowMs: NOW,
    });
    expect(error.retryable).toBe(true);
    expect((error as ProviderError).status).toBe(503);
  });

  it('maps an SDK 429 to RateLimitError, reading Retry-After when the error kept headers', () => {
    const caught = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '7' },
    });
    const error = errorFromSdk({
      provider: 'gemini',
      operation: 'generateContent',
      caught,
      nowMs: NOW,
    });
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(7_000);
  });

  it('maps an SDK 429 with no headers to RateLimitError without a delay', () => {
    const caught = Object.assign(new Error('rate limited'), { status: 429 });
    const error = errorFromSdk({ provider: 'gemini', operation: 'op', caught, nowMs: NOW });
    expect((error as RateLimitError).retryAfterMs).toBeUndefined();
  });

  it('falls back to the thrown-value mapping when there is no status', () => {
    const error = errorFromSdk({
      provider: 'gemini',
      operation: 'op',
      caught: new TypeError('fetch failed'),
      nowMs: NOW,
    });
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
  });

  it('prefers cancellation over the status when the caller aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const caught = Object.assign(new Error('aborted'), { status: 500 });
    const error = errorFromSdk({
      provider: 'gemini',
      operation: 'op',
      caught,
      signal: controller.signal,
      nowMs: NOW,
    });
    expect(error).toBeInstanceOf(CancelledError);
  });
});
