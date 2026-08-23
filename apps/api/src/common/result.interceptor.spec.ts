/**
 * Unwrapping, and the failure mode it exists to prevent.
 *
 * An `Err` returned rather than thrown would be serialised as `{"ok":false,…}` with
 * status 200. That is the worst failure an API can have, because every client treats
 * it as success and the error surfaces days later as missing data. So the interesting
 * assertion is not "an `Ok` is unwrapped" - it is "an `Err` throws".
 */

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { NotFoundError, err, ok } from '@rv/shared-kernel';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { ResultInterceptor } from './result.interceptor';

const CONTEXT = {} as ExecutionContext;

function run(value: unknown): Promise<unknown> {
  const next: CallHandler = { handle: () => of(value) };
  return firstValueFrom(new ResultInterceptor().intercept(CONTEXT, next));
}

describe('ResultInterceptor', () => {
  it('unwraps an Ok to its value', async () => {
    await expect(run(ok({ id: 'prj_1' }))).resolves.toEqual({ id: 'prj_1' });
  });

  it('unwraps an Ok carrying a falsy value rather than treating it as absent', async () => {
    await expect(run(ok(0))).resolves.toBe(0);
    await expect(run(ok(null))).resolves.toBeNull();
    await expect(run(ok(false))).resolves.toBe(false);
  });

  it('throws the AppError inside an Err, so the filter can map it', async () => {
    await expect(run(err(new NotFoundError('project', 'prj_1')))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      kind: 'not-found',
    });
  });

  it('leaves a plain value alone', async () => {
    const value = { openapi: '3.1.0' };
    await expect(run(value)).resolves.toBe(value);
  });

  it('does not mistake a look-alike object for a Result', async () => {
    // `{ ok: true }` with no `value` is a plausible domain object - a health report,
    // say - and unwrapping it would return `undefined` and a 200 with an empty body.
    const lookalike = { ok: true };
    await expect(run(lookalike)).resolves.toBe(lookalike);
  });

  it('leaves null and undefined alone', async () => {
    await expect(run(null)).resolves.toBeNull();
    await expect(run(undefined)).resolves.toBeUndefined();
  });

  it('rethrows a non-AppError payload rather than swallowing it', async () => {
    // A use-case whose `Err` carries something other than an `AppError` is a bug. It
    // must reach the filter's 500 floor, not be hidden here.
    await expect(run({ ok: false, error: 'a bare string' })).rejects.toBeInstanceOf(Error);
  });
});
