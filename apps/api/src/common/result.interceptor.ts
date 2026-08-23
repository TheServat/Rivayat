/**
 * Unwraps a `Result` so controllers stay three lines long.
 *
 * The application layer returns `Result<T, AppError>` because CLAUDE.md reserves
 * throwing for programmer error. HTTP has the opposite convention: a failure is an
 * exception the filter formats. Something has to bridge the two, and the choice is
 * between doing it in every controller method - twenty copies of the same `if
 * (!result.ok) throw result.error` - or once, here.
 *
 * Doing it here also means a controller *cannot* forget: an `Err` that is returned
 * rather than thrown would otherwise be serialised as `{"ok":false,...}` with status
 * 200, which is the single worst failure mode an API can have, because every client
 * treats it as success.
 */

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Result } from '@rv/shared-kernel';
import { isAppError } from '@rv/shared-kernel';
import { map, type Observable } from 'rxjs';

/**
 * Structural, not `instanceof`: `Result` is a plain object union by design, and the
 * `ok` discriminant is the whole of its identity.
 */
function isResult(value: unknown): value is Result<unknown, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { ok?: unknown; value?: unknown; error?: unknown };
  if (candidate.ok === true) return 'value' in candidate;
  if (candidate.ok === false) return 'error' in candidate;
  return false;
}

@Injectable()
export class ResultInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value: unknown) => {
        if (!isResult(value)) return value;
        if (value.ok) return value.value;
        // Throwing an `AppError` hands it to `AppErrorFilter`, which owns the mapping.
        // A non-`AppError` payload is a bug in the use-case, and rethrowing it as-is
        // lets the filter's floor report it as 500 rather than hiding it.
        throw isAppError(value.error) ? value.error : new Error(String(value.error));
      }),
    );
  }
}
