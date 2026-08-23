/**
 * The taxonomy-to-HTTP mapping, asserted kind by kind.
 *
 * This is a table test on purpose. The mapping is the API's public contract - a client
 * that has learned "402 means the budget guard stopped it" breaks silently if the kind
 * ever falls through to 500 - and the only way a table stays true is if every row is
 * checked. The loop over `ERROR_KINDS` also means adding a kind to
 * `@rv/shared-kernel` fails here rather than in production.
 */

import type { ArgumentsHost } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import {
  AppError,
  BudgetExceededError,
  ConflictError,
  InternalError,
  MemoryLogger,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  UnsupportedCapabilityError,
  ValidationError,
  type ErrorKind,
} from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { AppErrorFilter } from './app-error.filter';
import { ERROR_KINDS, STATUS_BY_ERROR_KIND, type ErrorEnvelope } from './error-envelope';

interface Captured {
  status: number;
  body: ErrorEnvelope | null;
  headers: Record<string, string>;
}

function fakeHost(): { host: ArgumentsHost; captured: Captured } {
  const captured: Captured = { status: 0, body: null, headers: {} };
  const response = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: ErrorEnvelope) {
      captured.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', url: '/api/things' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, captured };
}

/** One error per kind, so no row of the table is checked with a stand-in. */
class CancelledStub extends AppError {
  readonly code = 'CANCELLED';
  readonly kind = 'cancelled' as const;
  readonly retryable = false;
}
class ProviderStub extends AppError {
  readonly code = 'PROVIDER_ERROR';
  readonly kind = 'provider' as const;
  readonly retryable = true;
}

const SAMPLES: Readonly<Record<ErrorKind, AppError>> = {
  validation: new ValidationError({ message: 'bad body' }),
  'not-found': new NotFoundError('project', 'prj_1'),
  conflict: new ConflictError({ message: 'already exists' }),
  unsupported: new UnsupportedCapabilityError('@rv/story-engine', 'S2'),
  provider: new ProviderStub({ message: 'upstream said no' }),
  timeout: new TimeoutError('generate', 30_000),
  'rate-limit': new RateLimitError('openrouter', 4200),
  budget: new BudgetExceededError('run', 5, 6.25),
  cancelled: new CancelledStub({ message: 'the user stopped it' }),
  internal: new InternalError({ message: 'a bug' }),
};

function run(error: unknown): Captured {
  const { host, captured } = fakeHost();
  new AppErrorFilter(new MemoryLogger()).catch(error, host);
  return captured;
}

describe('AppErrorFilter', () => {
  it.each(ERROR_KINDS)('maps %s to its documented status', (kind) => {
    const captured = run(SAMPLES[kind]);
    expect(captured.status).toBe(STATUS_BY_ERROR_KIND[kind]);
    expect(captured.body?.error.kind).toBe(kind);
    expect(captured.body?.error.status).toBe(STATUS_BY_ERROR_KIND[kind]);
  });

  it('covers every kind the taxonomy declares, so no row is missing', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...ERROR_KINDS].sort());
  });

  it('publishes code, kind and context, and never a stack', () => {
    const captured = run(new BudgetExceededError('run', 5, 6.25));
    expect(captured.body?.error.code).toBe('BUDGET_EXCEEDED');
    expect(captured.body?.error.kind).toBe('budget');
    expect(captured.body?.error.context).toMatchObject({ scope: 'run', limitUsd: 5 });
    expect(JSON.stringify(captured.body)).not.toContain('at ');
    expect(captured.body).not.toHaveProperty('error.stack');
  });

  it('sets Retry-After in seconds when the provider named a delay', () => {
    const captured = run(new RateLimitError('openrouter', 4200));
    // 4200 ms rounds *up* to 5 s: rounding down tells the client to retry inside the
    // window the provider just closed.
    expect(captured.headers['Retry-After']).toBe('5');
    expect(captured.status).toBe(429);
  });

  it('omits Retry-After when the provider did not say', () => {
    const captured = run(new RateLimitError('ollama'));
    expect(captured.headers['Retry-After']).toBeUndefined();
  });

  it('carries the field-level issues a validation failure collected', () => {
    const captured = run(
      new ValidationError({
        message: 'body failed validation',
        context: {
          issues: [{ path: 'stages.0', message: 'invalid stage', code: 'invalid_value' }],
        },
      }),
    );
    expect(captured.body?.error.issues).toEqual([
      { path: 'stages.0', message: 'invalid stage', code: 'invalid_value' },
    ]);
  });

  it('keeps a Nest HttpException at its own status rather than inventing a kind', () => {
    const captured = run(new HttpException('Cannot GET /api/nope', 404));
    expect(captured.status).toBe(404);
    expect(captured.body?.error.kind).toBe('not-found');
    expect(captured.body?.error.code).toBe('HTTP_404');
  });

  it('reports an unknown throw as 500 without reflecting its message', () => {
    const captured = run(new Error('connection string: postgres://user:hunter2@host'));
    expect(captured.status).toBe(500);
    expect(captured.body?.error.message).toBe('Internal server error');
    expect(JSON.stringify(captured.body)).not.toContain('hunter2');
  });
});
