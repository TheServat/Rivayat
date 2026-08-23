/**
 * One error shape for the whole API, and the taxonomy-to-status table.
 *
 * The table is data rather than a `switch` for the reason CLAUDE.md §2 gives: a
 * `Record<ErrorKind, number>` is total by construction, so adding a kind to the
 * taxonomy in `@rv/shared-kernel` fails to compile here instead of silently falling
 * through to 500. A client that has learned "402 means the budget guard stopped it"
 * would otherwise start seeing 500 the day someone adds a kind.
 *
 * The body carries `code`, `kind` and `context` and never a stack trace. `kind` is
 * what a client branches on, `code` is what it logs and reports, `context` is what
 * makes the report actionable - which ceiling, which resource, which provider. A stack
 * trace is none of those and is a disclosure risk, so it stops at the filter.
 */

import type { ErrorKind } from '@rv/shared-kernel';
import { z } from 'zod';

/**
 * `ErrorKind` to HTTP status.
 *
 * The five that are not a plain "the caller got it wrong" are worth their reasons:
 *
 * - `budget` → **402 Payment Required**. The one status that means "this would cost
 *   more than you allowed"; 403 would read as an authorisation failure and invite a
 *   retry with different credentials.
 * - `rate-limit` → **429**, with `Retry-After` when the provider told us how long.
 * - `unsupported` → **501 Not Implemented**. An engine that is still a scaffold, or an
 *   adapter that cannot serve a capability. Not 400: the request was fine.
 * - `provider` → **502 Bad Gateway**. The failure is upstream of us, and 500 would
 *   send an operator looking through our logs for our bug.
 * - `cancelled` → **499**. Nginx's non-standard "client closed request", used because
 *   the alternatives all claim the server failed. Not in the task's table; documented
 *   here because the taxonomy has the kind and the map must be total.
 */
export const STATUS_BY_ERROR_KIND: Readonly<Record<ErrorKind, number>> = {
  validation: 400,
  'not-found': 404,
  conflict: 409,
  budget: 402,
  'rate-limit': 429,
  unsupported: 501,
  provider: 502,
  timeout: 504,
  cancelled: 499,
  internal: 500,
};

export const ERROR_KINDS = Object.keys(STATUS_BY_ERROR_KIND) as readonly ErrorKind[];

/**
 * The response body of every failure the API produces.
 *
 * A schema rather than an interface so the OpenAPI document describes errors from the
 * same source the filter serialises - the drift non-negotiable #5 forbids applies to
 * the failure path too, and it is the path clients get wrong most often.
 */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string().describe('Stable machine identifier, e.g. "BUDGET_EXCEEDED".'),
    kind: z
      .enum(ERROR_KINDS as [ErrorKind, ...ErrorKind[]])
      .describe('The taxonomy class. What a client branches on; the status is derived from it.'),
    message: z.string().describe('For a human. Never the only field - see `code`.'),
    retryable: z.boolean().describe('Whether retrying the identical call could succeed.'),
    context: z
      .record(z.string(), z.unknown())
      .describe('Structured diagnostics. Never secrets, never a stack trace.'),
    issues: z
      .array(
        z.object({
          path: z.string().describe('Dotted path to the offending field, "" for the root.'),
          message: z.string(),
          code: z.string(),
        }),
      )
      .optional()
      .describe('Field-level detail. Present when the failure was schema validation.'),
    status: z.number().int().describe('The HTTP status, repeated so a log line is self-contained.'),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
