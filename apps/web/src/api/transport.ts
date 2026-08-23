import type { z } from 'zod';

import { ApiError, ApiErrorBody } from './errors';

export type TransportKind = 'http' | 'fixture';

export interface TransportRequest<T> {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  /** Parsed and validated before it is returned. Never skipped, not even for `void`. */
  readonly schema: z.ZodType<T>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * How the studio reaches the API.
 *
 * An interface rather than a bare `fetch` wrapper for one reason: the e2e suite and a
 * UI-only dev session have to run with no backend, and the honest way to do that is a
 * second implementation of the same contract - not a mock layered inside the real one.
 * The shell renders a visible badge whenever the active transport is not `http`, so a
 * fixture-backed screen can never be mistaken for a working one.
 */
export interface StudioTransport {
  readonly kind: TransportKind;
  send: <T>(request: TransportRequest<T>) => Promise<T>;
  /** Absolute URL for an SSE endpoint, or `null` when this transport has no stream. */
  eventSourceUrl: (path: string) => string | null;
}

/**
 * Validates a payload at the boundary and refuses anything that does not fit.
 *
 * The refusal is the point. A response that fails its schema becomes an `ApiError`, so
 * the caller's `await` rejects and the store never assigns. Returning the raw payload
 * "because the shape is probably fine" would put unvalidated data one property access
 * away from a component, which is the failure validating at the boundary exists to
 * prevent.
 */
export function parseOrThrow<T>(path: string, schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) throw ApiError.schema(path, result.error);
  return result.data;
}

export class HttpTransport implements StudioTransport {
  readonly kind = 'http' as const;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(
    baseUrl: string,
    // Bound, not a bare reference. `fetch` is an intrinsic whose `this` must be the
    // global; storing `globalThis.fetch` and calling it as `this.#fetch(...)` throws
    // `Illegal invocation` in a browser. Node's undici tolerates it, so this passes
    // every jsdom test and fails on the first real page load - the failure surfaces as
    // a `network-unreachable` error with no request ever leaving the tab.
    fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  ) {
    // Trailing slashes are stripped so `${base}${path}` is unambiguous; `path` always
    // starts with one.
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetchImpl;
  }

  eventSourceUrl(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  async send<T>(request: TransportRequest<T>): Promise<T> {
    const url = `${this.#baseUrl}${request.path}`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: request.method,
        headers:
          request.body === undefined
            ? { Accept: 'application/json' }
            : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (cause) {
      // `fetch` rejects only for a transport failure; an HTTP error status resolves.
      throw ApiError.network(cause);
    }

    const payload = await readJson(response);

    if (!response.ok) {
      const parsed = ApiErrorBody.safeParse(payload);
      throw parsed.success
        ? ApiError.fromBody(response.status, parsed.data)
        : ApiError.unrecognised(response.status, response.statusText);
    }

    return parseOrThrow(request.path, request.schema, payload);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON at all - an HTML error page from a proxy, most often. Handing the text
    // back lets the error path report the status without pretending it parsed.
    return { nonJsonBody: text.slice(0, 500) };
  }
}
