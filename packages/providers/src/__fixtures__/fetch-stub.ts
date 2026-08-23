/**
 * The stub every provider test runs against. No socket is ever opened.
 *
 * Three properties make it a useful test double rather than a mock that agrees with
 * whatever the code does:
 *
 *  - **An unmatched request fails loudly**, printing the method, URL and body. A test
 *    that quietly gets a 404 from a typo'd path proves nothing (RV-033).
 *  - **It honours `AbortSignal`** the way `fetch` does - throwing an `AbortError` -
 *    so cancellation is exercised rather than simulated.
 *  - **It records every request**, so a test can assert on the bytes that went out,
 *    which is the only way to check things like "the schema really was attached".
 */

import type { FetchLike } from '../http/json-http';

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body, or `undefined` for a GET or a non-JSON body. */
  readonly json: unknown;
  readonly rawBody: string | undefined;
}

export interface StubResponse {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  /** Throw instead of responding - a DNS failure, a refused connection. */
  readonly throws?: unknown;
  /** Never settle until the caller's signal aborts. For cancellation tests. */
  readonly hang?: boolean;
}

type Responder = StubResponse | ((request: RecordedRequest) => StubResponse);

interface Route {
  readonly matcher: string | RegExp;
  readonly responder: Responder;
  /** Responds once, then falls through to the next matching route. */
  readonly once: boolean;
  used: boolean;
}

export class FetchStub {
  readonly requests: RecordedRequest[] = [];
  readonly #routes: Route[] = [];

  /** Matches when the URL contains `matcher`, or the regex tests true. */
  on(matcher: string | RegExp, responder: Responder): this {
    this.#routes.push({ matcher, responder, once: false, used: false });
    return this;
  }

  /** Same, but consumed after one use - for "fails then succeeds" scenarios. */
  once(matcher: string | RegExp, responder: Responder): this {
    this.#routes.push({ matcher, responder, once: true, used: false });
    return this;
  }

  /** Requests whose URL contains `fragment`. */
  requestsFor(fragment: string): readonly RecordedRequest[] {
    return this.requests.filter((request) => request.url.includes(fragment));
  }

  readonly fetch: FetchLike = async (input, init) => {
    const record = toRecord(input, init);
    this.requests.push(record);

    const route = this.#routes.find(
      (candidate) => matches(candidate, record.url) && !(candidate.once && candidate.used),
    );
    if (route === undefined) {
      throw new Error(
        `FetchStub: no route for ${record.method} ${record.url}\nbody: ${record.rawBody ?? '(none)'}`,
      );
    }
    route.used = true;

    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) throw abortError();

    const response =
      typeof route.responder === 'function' ? route.responder(record) : route.responder;

    if (response.hang === true) {
      await new Promise<never>((_resolve, reject) => {
        if (signal === undefined) return;
        signal.addEventListener('abort', () => {
          reject(abortError());
        });
      });
    }

    if (response.throws !== undefined) {
      // Deliberately rethrows whatever the fixture named: adapters must survive a
      // provider throwing a non-Error, which is the whole point of `toAppError`.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw response.throws;
    }

    return toResponse(response);
  };
}

function matches(route: Route, url: string): boolean {
  return typeof route.matcher === 'string' ? url.includes(route.matcher) : route.matcher.test(url);
}

function toRecord(input: string, init: RequestInit | undefined): RecordedRequest {
  const rawBody = typeof init?.body === 'string' ? init.body : undefined;
  let json: unknown;
  if (rawBody !== undefined) {
    try {
      json = JSON.parse(rawBody);
    } catch {
      json = undefined;
    }
  }
  return {
    url: input,
    method: init?.method ?? 'GET',
    headers: normaliseHeaders(init?.headers),
    json,
    rawBody,
  };
}

function normaliseHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

function toResponse(stub: StubResponse): Response {
  const status = stub.status ?? 200;
  const headers = new Headers(stub.headers ?? {});

  if (stub.bytes !== undefined) {
    if (!headers.has('content-type')) headers.set('content-type', 'image/png');
    // A fresh copy: `Response` may detach the buffer, and fixtures are reused.
    return new Response(new Uint8Array(stub.bytes), { status, headers });
  }
  if (stub.json !== undefined) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(stub.json), {
      status,
      ...(stub.statusText === undefined ? {} : { statusText: stub.statusText }),
      headers,
    });
  }
  return new Response(stub.text ?? '', {
    status,
    ...(stub.statusText === undefined ? {} : { statusText: stub.statusText }),
    headers,
  });
}

/** The exact error shape `fetch` produces on abort, so the mapping is really exercised. */
export function abortError(): Error {
  return new DOMException('This operation was aborted', 'AbortError');
}
