/**
 * The browser backend: a Chromium page, driven one `seek` at a time.
 *
 * It exists because WebGL does things Skia does not - filters, shaders, particle
 * systems, blend modes - and because "renders exactly as it does in the studio player"
 * is only true if it is the same PixiJS code. It is *not* the default: research §6
 * measured 8-15 s per 150 frames at 1080p, almost all of it browser overhead, and a
 * title card does not need a GPU.
 *
 * The launcher is injected (see `ports/browser.ts`) for three reasons that all point
 * the same way: `.dependency-cruiser.cjs` forbids the import, CI does not install a
 * browser, and ADR-0003 requires that `pnpm test` never need one. What that buys is
 * that everything interesting here - the seek protocol, the readback decode, the
 * console capture, the "does not hang" guarantee - is covered by tests that run in
 * milliseconds against a fake page.
 */

import {
  ProviderError,
  TimeoutError,
  err,
  ok,
  toAppError,
  type AppError,
  type Result,
} from '@rv/shared-kernel';

import type {
  BackendCapabilities,
  FrameBackendId,
  FrameBuffer,
  FrameRenderer,
  FrameSessionSpec,
  FrameSource,
} from '../../ports/frame-renderer';
import type {
  BrowserContextLike,
  BrowserLauncherLike,
  BrowserLike,
  BrowserPageLike,
} from '../../ports/browser';
import { BROWSER_FEATURES, detectFeatures, missingFeatures } from '../selector';
import { HARNESS_GLOBAL, buildHarnessHtml } from './render-harness';

const BACKEND_ID: FrameBackendId = 'pixi-playwright';
const PROVIDER = 'playwright:chromium';

export interface PixiPlaywrightOptions {
  /** `chromium` from `playwright`, handed in by the composition root. */
  readonly launcher: BrowserLauncherLike;
  /**
   * The scene module's JS source. It must register `window.__rvScene`.
   *
   * Source text rather than a URL because the page is loaded with `setContent` and
   * never over the network: a render that depends on a dev server being up is a render
   * that fails differently on every machine.
   */
  readonly sceneScript: string;
  /** Extra launch options, e.g. `{ args: ['--disable-gpu'] }`. */
  readonly launchOptions?: Record<string, unknown>;
  /**
   * Per-call ceiling. A WebGL context loss leaves `evaluate` pending forever, and a
   * render worker that hangs is worse than one that fails - it holds the queue slot.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The page's reply to `seek`. Validated rather than trusted: it crossed a JSON boundary. */
interface SeekReply {
  readonly width: number;
  readonly height: number;
  readonly base64: string;
}

class PlaywrightFrameSource implements FrameSource {
  readonly backend: FrameBackendId = BACKEND_ID;
  readonly #page: BrowserPageLike;
  readonly #context: BrowserContextLike;
  readonly #browser: BrowserLike;
  readonly #timeoutMs: number;
  readonly #console: string[];

  constructor(
    page: BrowserPageLike,
    context: BrowserContextLike,
    browser: BrowserLike,
    timeoutMs: number,
    consoleLog: string[],
  ) {
    this.#page = page;
    this.#context = context;
    this.#browser = browser;
    this.#timeoutMs = timeoutMs;
    this.#console = consoleLog;
  }

  async renderFrame(frame: number): Promise<Result<FrameBuffer, AppError>> {
    let reply: unknown;
    try {
      reply = await withTimeout(
        this.#page.evaluate(`window.${HARNESS_GLOBAL}.seek(arg)`, frame),
        this.#timeoutMs,
        `seek frame ${String(frame)}`,
      );
    } catch (caught: unknown) {
      return err(this.#pageError(caught, `seek frame ${String(frame)} failed`));
    }

    const decoded = decodeSeekReply(reply);
    if (decoded === null) {
      return err(
        this.#pageError(
          new Error('malformed seek reply'),
          `frame ${String(frame)} returned no usable pixels`,
        ),
      );
    }
    return ok(decoded);
  }

  async close(): Promise<void> {
    // Every level is closed independently and none may mask a failure in the next: a
    // leaked Chromium process outlives the worker and eats a gigabyte.
    await settle(this.#page.close());
    await settle(this.#context.close());
    await settle(this.#browser.close());
  }

  /** A page failure, with whatever the browser said about it attached. */
  #pageError(caught: unknown, message: string): AppError {
    if (caught instanceof TimeoutError) return caught;
    return new ProviderError({
      message,
      provider: PROVIDER,
      retryable: false,
      cause: caught,
      // Bounded: a page in a crash loop can emit thousands of lines, and the point is
      // to explain the failure, not to reproduce the console.
      context: { console: this.#console.slice(-40) },
    });
  }
}

export class PixiPlaywrightBackend implements FrameRenderer {
  readonly id: FrameBackendId = BACKEND_ID;
  readonly capabilities: BackendCapabilities = { features: BROWSER_FEATURES };
  readonly #options: PixiPlaywrightOptions;

  constructor(options: PixiPlaywrightOptions) {
    this.#options = options;
  }

  async open(spec: FrameSessionSpec): Promise<Result<FrameSource, AppError>> {
    const missing = missingFeatures(detectFeatures(spec.ir), this.capabilities.features);
    /* c8 ignore next 3 -- the browser backend supports every declared feature; the
       branch exists so that adding a feature to RENDER_FEATURES cannot silently make
       this backend claim something it has not implemented. */
    if (missing.length > 0) {
      return err(
        new ProviderError({ message: `unsupported: ${missing.join(', ')}`, provider: PROVIDER }),
      );
    }

    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const consoleLog: string[] = [];

    let browser: BrowserLike | undefined;
    let context: BrowserContextLike | undefined;
    let page: BrowserPageLike | undefined;
    try {
      browser = await this.#options.launcher.launch(this.#options.launchOptions ?? {});
      context = await browser.newContext({
        // 1 device pixel per CSS pixel: the output size is the frame size, and a
        // retina-aware default would silently render everything at 2x.
        deviceScaleFactor: 1,
        viewport: { width: spec.size.width, height: spec.size.height },
      });
      page = await context.newPage();
      page.on('console', (payload) => consoleLog.push(describe(payload)));
      page.on('pageerror', (payload) => consoleLog.push(`pageerror: ${describe(payload)}`));

      await page.setViewportSize({ width: spec.size.width, height: spec.size.height });
      await page.setContent(buildHarnessHtml(this.#options.sceneScript), {
        waitUntil: 'domcontentloaded',
      });
      await withTimeout(
        page.evaluate(`window.${HARNESS_GLOBAL}.init(arg)`, {
          ir: spec.ir,
          size: spec.size,
          background: spec.background ?? null,
        }),
        timeoutMs,
        'harness init',
      );
    } catch (caught: unknown) {
      // Unwind in reverse. A failed launch must not leave a browser running, and the
      // caller gets one typed error rather than a cascade.
      if (page !== undefined) await settle(page.close());
      if (context !== undefined) await settle(context.close());
      if (browser !== undefined) await settle(browser.close());
      const error = caught instanceof TimeoutError ? caught : undefined;
      return err(
        error ??
          new ProviderError({
            message: 'could not open a render page',
            provider: PROVIDER,
            retryable: false,
            cause: caught,
            context: { console: consoleLog.slice(-40) },
          }),
      );
    }

    return ok(new PlaywrightFrameSource(page, context, browser, timeoutMs, consoleLog));
  }
}

// ── plumbing ────────────────────────────────────────────────────────────────

/**
 * Validates and decodes the page's reply.
 *
 * `page.evaluate` returns `unknown` by construction - the value crossed a JSON
 * boundary and the page is, from Node's point of view, untrusted code. A frame whose
 * byte count disagrees with its declared size is rejected rather than padded: a short
 * buffer would encode as a green band nobody notices until the upload.
 */
export function decodeSeekReply(reply: unknown): FrameBuffer | null {
  if (typeof reply !== 'object' || reply === null) return null;
  const candidate = reply as Partial<SeekReply>;
  if (typeof candidate.width !== 'number' || typeof candidate.height !== 'number') return null;
  if (typeof candidate.base64 !== 'string') return null;

  const data = Uint8Array.from(Buffer.from(candidate.base64, 'base64'));
  if (data.length !== candidate.width * candidate.height * 4) return null;
  return { width: candidate.width, height: candidate.height, data };
}

/** Rejects with a typed `TimeoutError` rather than leaving the caller pending forever. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError(operation, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Close failures are reported, never thrown: cleanup must not mask the real error. */
async function settle(promise: Promise<void>): Promise<void> {
  try {
    await promise;
  } catch (caught: unknown) {
    // Swallowed deliberately. `toAppError` normalises it so the value is inspectable
    // in a debugger rather than an opaque rejection.
    void toAppError(caught, 'browser teardown failed');
  }
}

function describe(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Error) return `${payload.name}: ${payload.message}`;
  if (typeof payload === 'object' && payload !== null && 'text' in payload) {
    const text: unknown = payload.text;
    return typeof text === 'function'
      ? String((text as () => unknown).call(payload))
      : String(text);
  }
  return String(payload);
}
