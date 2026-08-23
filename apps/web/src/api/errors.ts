import type { ErrorKind } from '@rv/shared-kernel';
import { z } from 'zod';

/**
 * The error the API sends, and the one shape the studio shows a user.
 *
 * `ErrorKind` is imported as a *type* from `@rv/shared-kernel` rather than restated,
 * because the whole point of a `kind` is that the client and the server agree on the
 * list. The import is type-only, so nothing from the kernel is bundled - the studio
 * still ships no server code.
 *
 * What `@rv/contracts` does not yet have is a *Zod schema* for the wire envelope, so
 * `ERROR_KINDS` below is the runtime half. It is checked against the type at compile
 * time (see `_kindsAreExhaustive`), which means adding a kind upstream breaks this
 * build rather than silently arriving as an unrecognised string. See the report note:
 * this belongs in `@rv/contracts`.
 */
export const ERROR_KINDS = [
  'validation',
  'not-found',
  'conflict',
  'unsupported',
  'provider',
  'timeout',
  'rate-limit',
  'budget',
  'cancelled',
  'internal',
] as const satisfies readonly ErrorKind[];

// Fails to compile the moment `ErrorKind` gains a member this list does not have.
type MissingKinds = Exclude<ErrorKind, (typeof ERROR_KINDS)[number]>;
const _kindsAreExhaustive: MissingKinds extends never ? true : never = true;
void _kindsAreExhaustive;

export const ApiErrorKind = z.enum(ERROR_KINDS);

/**
 * One field the server refused, in the shape a form can act on.
 *
 * `path` is dotted and addresses the offending field - for a settings patch it is the
 * setting key - which is the whole reason this travels: a save that fails with "three
 * invalid entries" and no paths forces the user to find them, and the server already
 * knows which three.
 */
export const ApiErrorIssue = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string(),
});
export type ApiErrorIssue = z.infer<typeof ApiErrorIssue>;

/**
 * The JSON body of a failed request.
 *
 * **Nested under `error`, because that is what the API actually sends.** This schema
 * used to be flat, which meant every failure fell through to the status-derived
 * fallback: a `budget` refusal arrived as `http-402` with its real code, kind, context
 * and issues discarded, and the studio then rendered a generic message for an error the
 * server had described precisely. `apps/api/src/common/error-envelope.ts` is the
 * authority for this shape and emits it into the OpenAPI document.
 *
 * `context` is `unknown`-valued rather than typed: it is diagnostic detail whose shape
 * depends on the error, and pretending otherwise would mean a schema that rejects a
 * perfectly good error report because the server added a field to it. `z.object` rather
 * than `strictObject` for the same reason - an envelope that grows a field must not
 * become an unparseable error.
 */
export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string().min(1),
    kind: ApiErrorKind,
    message: z.string().default(''),
    retryable: z.boolean().default(false),
    context: z.record(z.string(), z.unknown()).default({}),
    /** Present when the failure was schema validation. */
    issues: z.array(ApiErrorIssue).optional(),
    /** The HTTP status, repeated by the server so a log line is self-contained. */
    status: z.number().int().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** Why a request failed, from the studio's point of view. */
export type ApiFailureKind =
  /** The server answered, and said no in the agreed envelope. */
  | 'api'
  /** The request never reached a server, or the connection dropped. */
  | 'network'
  /** The server answered, and the answer did not satisfy its own contract. */
  | 'schema';

/**
 * A failed API call, in a form a component can render without a `switch`.
 *
 * The interesting member is `schema`. A response that does not validate is a *failure*
 * here, never a value: `messageKey` resolves to "the server's response did not match
 * the data contract", the store never sees the payload, and the bad data cannot reach
 * a screen. Validating and then continuing anyway would be worse than not validating,
 * because it would look like the boundary was guarded.
 */
export class ApiError extends Error {
  readonly failure: ApiFailureKind;
  readonly code: string;
  readonly kind: ErrorKind | null;
  readonly status: number | null;
  readonly context: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  /**
   * Which fields the server refused, empty when the failure was not field-level.
   *
   * A first-class member rather than something buried in `context`, because the
   * settings form has to mark the rows a rejected patch names, and reaching into an
   * `unknown`-valued bag to find out is how that feature quietly stops working the
   * day the server renames the bag's key.
   */
  readonly issues: readonly ApiErrorIssue[];

  constructor(init: {
    failure: ApiFailureKind;
    code: string;
    message: string;
    kind?: ErrorKind | null;
    status?: number | null;
    context?: Readonly<Record<string, unknown>>;
    retryable?: boolean;
    issues?: readonly ApiErrorIssue[];
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.failure = init.failure;
    this.code = init.code;
    this.kind = init.kind ?? null;
    this.status = init.status ?? null;
    this.context = init.context ?? {};
    this.retryable = init.retryable ?? false;
    this.issues = init.issues ?? [];
  }

  static network(cause: unknown): ApiError {
    return new ApiError({
      failure: 'network',
      code: 'network-unreachable',
      message: 'the API could not be reached',
      retryable: true,
      cause,
    });
  }

  /**
   * A response that failed its own schema.
   *
   * The Zod issues are mapped into the same `{path, message, code}` triple the server
   * uses, so a caller that renders "which field is wrong" has one shape to read
   * whichever side produced the failure.
   */
  static schema(path: string, error: z.ZodError): ApiError {
    return new ApiError({
      failure: 'schema',
      code: 'response-schema-mismatch',
      message: `response from ${path} did not match its contract`,
      context: { path },
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
      cause: error,
    });
  }

  /**
   * The server's own envelope, unwrapped.
   *
   * `status` comes from the response line rather than from `error.status`: the two
   * agree in practice, and the one that actually happened is the one the transport
   * saw.
   */
  static fromBody(status: number, body: ApiErrorBody): ApiError {
    return new ApiError({
      failure: 'api',
      code: body.error.code,
      kind: body.error.kind,
      status,
      message: body.error.message,
      context: body.error.context,
      retryable: body.error.retryable,
      issues: body.error.issues ?? [],
    });
  }

  /** A non-2xx response whose body was not the agreed envelope. */
  static unrecognised(status: number, detail: string): ApiError {
    return new ApiError({
      failure: 'api',
      code: `http-${String(status)}`,
      kind: status >= 500 ? 'internal' : 'validation',
      status,
      message: detail,
      retryable: status >= 500,
    });
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
