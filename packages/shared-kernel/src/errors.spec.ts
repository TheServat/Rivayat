import { describe, expect, it } from 'vitest';

import {
  AppError,
  BudgetExceededError,
  CancelledError,
  ConflictError,
  InternalError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  UnsupportedCapabilityError,
  ValidationError,
  isAppError,
  isRetryable,
  toAppError,
} from './errors';

describe('AppError base behaviour', () => {
  it('names itself after the concrete subclass', () => {
    expect(new ValidationError({ message: 'x' }).name).toBe('ValidationError');
    expect(new InternalError({ message: 'x' }).name).toBe('InternalError');
  });

  it('is both an AppError and a real Error', () => {
    const error = new ValidationError({ message: 'x' });
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(isAppError(error)).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('nope')).toBe(false);
  });

  it('defaults context to an empty object', () => {
    expect(new InternalError({ message: 'x' }).context).toEqual({});
  });

  it('preserves the cause chain', () => {
    const root = new Error('root');
    const wrapped = new InternalError({ message: 'wrapped', cause: root });
    expect(wrapped.cause).toBe(root);
  });

  it('serialises to a structured record including a nested AppError cause', () => {
    const inner = new RateLimitError('openrouter', 1500);
    const outer = new ProviderError({
      message: 'call failed',
      provider: 'openrouter',
      status: 429,
      cause: inner,
    });

    const json = outer.toJSON();
    expect(json).toMatchObject({
      name: 'ProviderError',
      code: 'PROVIDER_ERROR',
      kind: 'provider',
      retryable: true,
      context: { provider: 'openrouter', status: 429 },
    });
    expect(json.cause).toMatchObject({ code: 'RATE_LIMITED', kind: 'rate-limit' });
  });

  it('stringifies a non-AppError cause rather than dropping it', () => {
    const json = new InternalError({ message: 'x', cause: 'a string cause' }).toJSON();
    expect(json.cause).toBe('a string cause');
  });

  it('omits cause from the payload when there is none', () => {
    expect(new InternalError({ message: 'x' }).toJSON().cause).toBeUndefined();
  });

  it('toString includes the machine-readable code', () => {
    expect(new ConflictError({ message: 'dup' }).toString()).toBe('ConflictError[CONFLICT]: dup');
  });
});

describe('retryability drives router behaviour, so it is asserted explicitly', () => {
  it.each([
    [new ValidationError({ message: 'x' }), false],
    [new NotFoundError('Asset', 'a_1'), false],
    [new ConflictError({ message: 'x' }), false],
    [new UnsupportedCapabilityError('ollama', 'image'), false],
    [new TimeoutError('generate', 30_000), true],
    [new RateLimitError('gemini'), true],
    [new BudgetExceededError('run', 5, 6), false],
    [new CancelledError('render'), false],
    [new InternalError({ message: 'x' }), false],
  ])('%s -> retryable=%s', (error, expected) => {
    expect(error.retryable).toBe(expected);
    expect(isRetryable(error)).toBe(expected);
  });

  it('treats a non-error value as not retryable', () => {
    expect(isRetryable('boom')).toBe(false);
  });
});

describe('ProviderError status heuristics', () => {
  it.each([
    [500, true],
    [503, true],
    [429, true],
    [408, true],
    [400, false],
    [401, false],
    [404, false],
  ])('status %i -> retryable=%s', (status, expected) => {
    expect(new ProviderError({ message: 'e', provider: 'p', status }).retryable).toBe(expected);
  });

  it('treats a missing status as a network failure worth one retry', () => {
    expect(new ProviderError({ message: 'e', provider: 'p' }).retryable).toBe(true);
  });

  it('honours an explicit override over the heuristic', () => {
    const error = new ProviderError({
      message: 'content filtered',
      provider: 'gemini',
      status: 500,
      retryable: false,
    });
    expect(error.retryable).toBe(false);
  });
});

describe('message shaping', () => {
  it('NotFoundError names the resource and id', () => {
    const error = new NotFoundError('Episode', 'ep_01');
    expect(error.message).toBe('Episode not found: ep_01');
    expect(error.context).toEqual({ resource: 'Episode', id: 'ep_01' });
  });

  it('NotFoundError keeps the diagnostic context the caller supplied', () => {
    // A lookup that failed usually knows *why* it was looking - the story time, the
    // variant, the run. Dropping that on the floor is worst exactly when it matters.
    const error = new NotFoundError('AssetVersion', 'asv_1', {
      context: { storyOrdinal: 10, variantKey: 'winter' },
    });
    expect(error.context).toEqual({
      storyOrdinal: 10,
      variantKey: 'winter',
      resource: 'AssetVersion',
      id: 'asv_1',
    });
  });

  it('NotFoundError does not let the caller shadow resource or id', () => {
    const error = new NotFoundError('Asset', 'ast_1', { context: { resource: 'lie', id: 'lie' } });
    expect(error.context).toMatchObject({ resource: 'Asset', id: 'ast_1' });
  });

  it('BudgetExceededError reports both the limit and the projected spend', () => {
    const error = new BudgetExceededError('run', 5, 5.25);
    expect(error.message).toContain('$5.0000');
    expect(error.message).toContain('$5.2500');
  });

  it('UnsupportedCapabilityError names provider and capability', () => {
    const error = new UnsupportedCapabilityError('ollama', 'image-generation');
    expect(error.context).toEqual({ provider: 'ollama', capability: 'image-generation' });
  });

  it('RateLimitError carries retryAfterMs when the provider supplied one', () => {
    expect(new RateLimitError('gemini', 2000).retryAfterMs).toBe(2000);
    expect(new RateLimitError('gemini').retryAfterMs).toBeUndefined();
  });
});

describe('toAppError', () => {
  it('returns an AppError unchanged', () => {
    const original = new ValidationError({ message: 'x' });
    expect(toAppError(original)).toBe(original);
  });

  it('wraps a plain Error, keeping the message and the cause', () => {
    const cause = new TypeError('bad type');
    const wrapped = toAppError(cause);
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.message).toBe('bad type');
    expect(wrapped.cause).toBe(cause);
  });

  it('wraps a non-Error value and preserves it in context', () => {
    const wrapped = toAppError({ weird: true }, 'fallback');
    expect(wrapped.message).toBe('fallback');
    expect(wrapped.context).toEqual({ caught: '[object Object]' });
  });
});
