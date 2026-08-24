/**
 * Every failure leaves the API through here, in one shape.
 *
 * Three sources converge: an `AppError` thrown by a use-case or unwrapped from a
 * `Result`, an `HttpException` Nest raised on its own (an unmatched route, a body too
 * large), and anything else - which is by definition a bug and is reported as 500 with
 * its message kept out of the response.
 *
 * The filter never puts a stack in the body and never reflects an unknown error's
 * message to the client. Both are the same rule: the response says what the caller can
 * act on, the log says what we can act on.
 */

import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  AppError,
  RateLimitError,
  isAppError,
  type ErrorKind,
  type Logger,
} from '@rv/shared-kernel';
import type { Request, Response } from 'express';

import { LOGGER } from '../tokens';
import { STATUS_BY_ERROR_KIND, type ErrorEnvelope } from './error-envelope';

/**
 * An `HttpException` Nest raised on its own, expressed in the taxonomy.
 *
 * Nest owns some failures the domain has no opinion about - 404 for an unmatched
 * route, 413 for an oversized body. Rather than inventing a domain error for them, the
 * status is kept and a `kind` is chosen from it, so the envelope stays one shape.
 */
class HttpBoundaryError extends AppError {
  readonly code: string;
  readonly kind: ErrorKind;
  readonly retryable = false;

  constructor(code: string, kind: ErrorKind, message: string, status: number) {
    super({ message, context: { status } });
    this.code = code;
    this.kind = kind;
  }
}

/** The floor. Its message is fixed, because an unknown throw's message is untrusted. */
class UnhandledError extends AppError {
  readonly code = 'INTERNAL_ERROR';
  readonly kind = 'internal' as const;
  readonly retryable = false;
}

/** Field-level issues, when the error carries them. */
function issuesOf(error: AppError): ErrorEnvelope['error']['issues'] {
  const context = error.context as { issues?: unknown };
  if (!Array.isArray(context.issues)) return undefined;
  const structured = context.issues.filter(
    (issue): issue is { path: string; message: string; code: string } =>
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as { path?: unknown }).path === 'string' &&
      typeof (issue as { message?: unknown }).message === 'string',
  );
  return structured.length > 0 ? structured : undefined;
}

/** An HTTP status a non-Nest middleware attached to its own error, if it did. */
function statusOf(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const carrier = exception as { status?: unknown; statusCode?: unknown };
  const status = typeof carrier.status === 'number' ? carrier.status : carrier.statusCode;
  if (typeof status !== 'number') return undefined;
  return status >= 400 && status < 500 ? status : undefined;
}

/** The message such an error carries. Safe to relay: it is ours, not a user's input. */
function messageOf(exception: unknown): string {
  return exception instanceof Error ? exception.message : 'Request rejected';
}

function boundary(status: number, message: string): HttpBoundaryError {
  const kind: ErrorKind = status === 404 ? 'not-found' : status < 500 ? 'validation' : 'internal';
  return new HttpBoundaryError(`HTTP_${String(status)}`, kind, message, status);
}

/** Anything that is not an `AppError` becomes one, at the boundary, exactly once. */
function normalise(exception: unknown): { readonly error: AppError; readonly status: number } {
  if (isAppError(exception)) {
    return { error: exception, status: STATUS_BY_ERROR_KIND[exception.kind] };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { error: boundary(status, exception.message), status };
  }

  // Express middleware failures - a body over the limit, malformed JSON, an
  // unsupported charset - are plain `Error`s carrying a numeric `status`, not
  // `HttpException`s. Without this arm every one of them was a 500 with an empty
  // context, so "your composition is too large" and "the server has a bug" were the
  // same response. The status is only trusted in the 4xx range: a middleware claiming
  // 5xx is reporting our fault, and our faults do not get to choose their own message.
  const relayed = statusOf(exception);
  if (relayed !== undefined) {
    return { error: boundary(relayed, messageOf(exception)), status: relayed };
  }

  return {
    error: new UnhandledError({
      message: 'Internal server error',
      ...(exception === undefined ? {} : { cause: exception }),
    }),
    status: 500,
  };
}

@Catch()
export class AppErrorFilter implements ExceptionFilter {
  readonly #logger: Logger;

  constructor(@Inject(LOGGER) logger: Logger) {
    this.#logger = logger.child({ component: 'http' });
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const { error, status } = normalise(exception);

    // A rate limit that does not say *how long* forces the client to guess, and the
    // guess is always "immediately". `RateLimitError` carries the provider's own
    // number when it gave one; the header is the only place it can reach the client.
    if (error instanceof RateLimitError && error.retryAfterMs !== undefined) {
      response.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
    }

    // 501 is a 5xx that is not a fault: it is a route whose engine package is a
    // scaffold, and every one of them would otherwise fill the log with a stack that
    // points at the stub. Everything else in the 5xx range is ours and gets the stack.
    const isFault = status >= 500 && error.kind !== 'unsupported';
    this.#logger[isFault ? 'error' : 'warn']('request failed', {
      method: request.method,
      path: request.url,
      status,
      code: error.code,
      kind: error.kind,
      // The stack goes here and only here.
      ...(isFault ? { stack: error.stack } : {}),
    });

    const issues = issuesOf(error);
    const body: ErrorEnvelope = {
      error: {
        code: error.code,
        kind: error.kind,
        message: error.message,
        retryable: error.retryable,
        context: error.context,
        status,
        ...(issues === undefined ? {} : { issues }),
      },
    };

    response.status(status).json(body);
  }
}
