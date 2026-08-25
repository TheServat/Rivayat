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

  /**
   * A JSON request whose *response* is binary.
   *
   * The shape every speech engine uses: a JSON body describing the utterance, an audio
   * stream back. Separate from `postJson` rather than a flag on it because the return
   * type differs, and separate from `getBytes` because the request has a body.
   */
  /**
   * POSTs and reads a newline-delimited JSON stream, returning the final object.
   *
   * This exists because of a timeout nobody set. Node's fetch caps the wait for the
   * *first response header* at 300 seconds, and a local model asked for a large
   * structured output sends nothing at all until it has finished generating - so a
   * generation that takes six minutes fails at five with `fetch failed`, which reads as
   * a network fault and is not one. Raising our own timeout cannot help: the cap is
   * below it and belongs to the HTTP stack.
   *
   * Streaming moves the first byte to the start of generation rather than the end, so
   * the header deadline is met immediately and the gap between chunks - a token or two -
   * is never close to any limit. The caller gets the same object it got before; the
   * difference is only in when the bytes cross the wire.
   *
   * `merge` folds each chunk into the accumulating result, because the shape of a
   * streamed response is the provider's business: Ollama sends partial `message.content`
   * to be concatenated and a final chunk carrying the counts.
   */
  async postNdjson<T>(
    path: string,
    body: unknown,
    merge: (accumulated: T | undefined, chunk: unknown) => T,
    options: RequestOptions = {},
  ): Promise<Result<T, AppError>> {
    const operation = `POST ${path}`;
    if (options.signal?.aborted === true) return err(new CancelledError(operation));

    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const signal = combineSignals(options.signal, timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: { ...this.#headers, 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        signal,
      });
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

    const stream = response.body;
    if (stream === null) {
      return err(
        new ProviderError({
          message: `${operation} answered with no body to stream`,
          provider: this.#provider,
          retryable: true,
          context: { operation },
        }),
      );
    }

    let accumulated: T | undefined;
    let buffer = '';
    try {
      const decoder = new TextDecoder();
      for await (const bytes of streamChunks(stream)) {
        buffer += decoder.decode(bytes, { stream: true });
        // Split on newlines and keep the tail: a chunk boundary lands mid-line often
        // enough that parsing what arrived would fail on perfectly good output.
        const lines = buffer.split(NEWLINE);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          accumulated = merge(accumulated, JSON.parse(line));
        }
      }
      if (buffer.trim().length > 0) accumulated = merge(accumulated, JSON.parse(buffer));
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

    if (accumulated === undefined) {
      return err(
        new ProviderError({
          message: `${operation} streamed no complete line`,
          provider: this.#provider,
          retryable: true,
          context: { operation },
        }),
      );
    }
    return ok(accumulated);
  }

  async postBytes(
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<Result<{ bytes: Uint8Array; contentType: string }, AppError>> {
    const outcome = await this.#send(path, 'POST', body, options, 'bytes');
    if (outcome.ok) {
      return ok(outcome.value as { bytes: Uint8Array; contentType: string });
    }
    return outcome;
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

/** The delimiter in newline-delimited JSON, named so the split reads as what it is. */
const NEWLINE = '\n';

/**
 * A `ReadableStream` as an async iterable.
 *
 * Node's streams are iterable already; the DOM type this is declared as is not, in every
 * runtime that matters. Reading it through a reader works in both, and avoids a cast
 * that would be a lie in one of them.
 */
async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
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
