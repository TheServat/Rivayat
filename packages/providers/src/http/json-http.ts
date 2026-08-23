/**
 * A very small HTTP client, shared by the three adapters that speak plain JSON.
 *
 * It exists for four reasons that each caused a bug when they were left to the call
 * site: `fetch` is injected (so tests never touch a socket), the caller's `AbortSignal`
 * is checked *before* the request goes out (so a cancelled call provably issues zero
 * requests), every failure path lands in `errorFromResponse`/`errorFromThrown` (so
 * `retryable` is consistent across providers), and the response is handed back as
 * `unknown` for the caller to validate with Zod rather than being cast.
 *
 * It is deliberately not a retry client. Retry policy belongs to `routing/retry.ts`,
 * which has the injected `Rng` the jitter needs (CLAUDE.md #1).
 */

import {
  type AppError,
  CancelledError,
  type Clock,
  ProviderError,
  type Result,
  SystemClock,
  err,
  ok,
} from '@rv/shared-kernel';

import { errorFromResponse, errorFromThrown } from './errors';

/** The one seam every adapter takes instead of reaching for global `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JsonHttpOptions {
  /** No trailing slash; paths are appended verbatim. */
  readonly baseUrl: string;
  /** Provider name for the error taxonomy, e.g. `ollama`. */
  readonly provider: string;
  readonly fetch?: FetchLike;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly clock?: Clock;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the client-wide timeout for one call - image jobs are slow. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class JsonHttpClient {
  readonly #baseUrl: string;
  readonly #provider: string;
  readonly #fetch: FetchLike;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;
  readonly #clock: Clock;

  constructor(options: JsonHttpOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#provider = options.provider;
    // Bound: an unbound `globalThis.fetch` throws "Illegal invocation" in some runtimes.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#headers = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#clock = options.clock ?? new SystemClock();
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async getJson(path: string, options: RequestOptions = {}): Promise<Result<unknown, AppError>> {
    return this.#send(path, 'GET', undefined, options, 'json');
  }

  async postJson(
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<Result<unknown, AppError>> {
    return this.#send(path, 'POST', body, options, 'json');
  }

  /**
   * Multipart upload.
   *
   * The one non-JSON request in the package - ComfyUI's `/upload/image`. `content-type`
   * is deliberately not set: `fetch` derives it from the `FormData` body along with the
   * boundary, and setting it by hand produces a boundary-less header the server rejects.
   */
  async postForm(
    path: string,
    form: FormData,
    options: RequestOptions = {},
  ): Promise<Result<unknown, AppError>> {
    return this.#send(path, 'POST', form, options, 'json');
  }

  /** For `/view`-style endpoints that return image bytes rather than JSON. */
  async getBytes(
    path: string,
    options: RequestOptions = {},
  ): Promise<Result<{ bytes: Uint8Array; contentType: string }, AppError>> {
    const outcome = await this.#send(path, 'GET', undefined, options, 'bytes');
    if (outcome.ok) {
      return ok(outcome.value as { bytes: Uint8Array; contentType: string });
    }
    return outcome;
  }

  async #send(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    options: RequestOptions,
    as: 'json' | 'bytes',
  ): Promise<Result<unknown, AppError>> {
    const operation = `${method} ${path}`;

    // Before anything is sent: a cancelled call must provably make zero requests.
    if (options.signal?.aborted === true) {
      return err(new CancelledError(operation));
    }

    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const signal = combineSignals(options.signal, timeoutMs);

    const isForm = body instanceof FormData;
    const init: RequestInit = {
      method,
      headers: {
        ...this.#headers,
        ...(body === undefined || isForm ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
      signal,
    };

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, init);
    } catch (caught) {
      return err(
        errorFromThrown({
          provider: this.#provider,
          operation,
          caught,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs,
        }),
      );
    }

    if (!response.ok) {
      const text = await readTextSafely(response);
      return err(
        errorFromResponse({
          provider: this.#provider,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: text,
          nowMs: this.#clock.now(),
          operation,
        }),
      );
    }

    try {
      if (as === 'bytes') {
        const buffer = await response.arrayBuffer();
        return ok({
          bytes: new Uint8Array(buffer),
          contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        });
      }
      const parsed: unknown = await response.json();
      return ok(parsed);
    } catch (caught) {
      // A 200 whose body is not the promised type is the provider's fault, and one
      // more attempt is cheap enough to be worth it - a truncated stream is common.
      return err(
        new ProviderError({
          message: `${operation} returned an unreadable body`,
          provider: this.#provider,
          retryable: true,
          context: { operation },
          cause: caught,
        }),
      );
    }
  }
}

/**
 * Combines the caller's signal with a timeout.
 *
 * `AbortSignal.any` keeps the two distinguishable downstream: the caller's signal
 * still reads `aborted` when *it* fired, which is what lets `errorFromThrown` tell a
 * user cancellation from a deadline.
 */
function combineSignals(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
}

async function readTextSafely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
