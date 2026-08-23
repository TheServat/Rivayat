/**
 * Test doubles for everything on the far side of a port.
 *
 * The important ones are the browser and the process runner. ADR-0003 requires that
 * `pnpm test` never need a Chromium download, and CI has no browser at all - so the
 * Playwright backend is exercised through {@link FakeBrowserLauncher}, which implements
 * the same seek protocol the real page does. What that covers is everything this
 * package actually wrote: the protocol, the readback decode, the console capture and
 * the teardown. What it cannot cover is PixiJS drawing, which is not this package's
 * code.
 *
 * The doubles are *behavioural*, not stubs that return a constant. A fake that always
 * succeeds would make the error paths untested and the tests green regardless.
 */

import {
  instant,
  ok,
  type AppError,
  type Clock,
  type Instant,
  type Result,
  type Unit,
} from '@rv/shared-kernel';

import type {
  BrowserContextLike,
  BrowserLauncherLike,
  BrowserLike,
  BrowserPageLike,
} from '../ports/browser';
import type { AssetImagePort, FrameBuffer } from '../ports/frame-renderer';
import type { PipedProcess, ProcessPort, ProcessResult, ProcessSpec } from '../ports/process';
import type {
  CanvasContext2DLike,
  DrawableImage,
  Surface2D,
  SurfaceProvider,
} from '../backends/surface';

// ── time ────────────────────────────────────────────────────────────────────

/**
 * A clock that advances by a fixed step on every read.
 *
 * `FixedClock` never moves, which makes throughput unmeasurable and every
 * time-throttled emission silently a no-op - a progress test against it passes by
 * asserting nothing. This one moves predictably, so "at least one tick per second" is a
 * real assertion and still fully deterministic.
 */
export class SteppingClock implements Clock {
  #current: number;

  constructor(
    start = 1_700_000_000_000,
    private readonly stepMs = 20,
  ) {
    this.#current = start;
  }

  now(): Instant {
    const value = this.#current;
    this.#current += this.stepMs;
    return instant(value);
  }
}

// ── frames ──────────────────────────────────────────────────────────────────

/** A solid frame, useful whenever the pixels do not matter but the size does. */
export function solidFrame(width: number, height: number, value: number): FrameBuffer {
  const data = new Uint8Array(width * height * 4);
  data.fill(value);
  return { width, height, data };
}

/** A frame whose pixels are a function of the frame index, so two frames never collide. */
export function indexedFrame(width: number, height: number, frame: number): FrameBuffer {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = (frame * 7 + index) % 256;
    data[index * 4 + 1] = (frame * 13) % 256;
    data[index * 4 + 2] = (index * 3) % 256;
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

export class MapAssetImages implements AssetImagePort {
  readonly requested: string[] = [];
  readonly #images: ReadonlyMap<string, FrameBuffer | null>;

  constructor(images: ReadonlyMap<string, FrameBuffer | null>) {
    this.#images = images;
  }

  load(key: string): Promise<Result<FrameBuffer | null, AppError>> {
    this.requested.push(key);
    return Promise.resolve(ok(this.#images.get(key) ?? null));
  }
}

// ── surfaces ────────────────────────────────────────────────────────────────

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * A canvas that records rather than draws.
 *
 * Lets the painter's decisions be asserted exactly - "the ellipse was centred at these
 * coordinates under this matrix" - which a pixel comparison can only approximate.
 */
export class RecordingContext implements CanvasContext2DLike {
  globalAlpha = 1;
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  lineJoin = '';
  lineCap = '';
  font = '';
  textAlign = '';
  textBaseline = '';
  direction = '';

  readonly calls: RecordedCall[] = [];
  /** Width per character, so `measureText` is predictable. */
  charWidth = 10;

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  save(): void {
    this.#record('save');
  }
  restore(): void {
    this.#record('restore');
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#record('setTransform', a, b, c, d, e, f);
  }
  clearRect(x: number, y: number, width: number, height: number): void {
    this.#record('clearRect', x, y, width, height);
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.#record('fillRect', x, y, width, height, this.fillStyle, this.globalAlpha);
  }
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.#record('strokeRect', x, y, width, height, this.strokeStyle);
  }
  beginPath(): void {
    this.#record('beginPath');
  }
  closePath(): void {
    this.#record('closePath');
  }
  moveTo(x: number, y: number): void {
    this.#record('moveTo', x, y);
  }
  lineTo(x: number, y: number): void {
    this.#record('lineTo', x, y);
  }
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
  ): void {
    this.#record('ellipse', x, y, radiusX, radiusY, rotation, startAngle, endAngle);
  }
  fill(path?: unknown): void {
    this.#record('fill', path);
  }
  stroke(path?: unknown): void {
    this.#record('stroke', path);
  }
  fillText(text: string, x: number, y: number): void {
    this.#record('fillText', text, x, y, this.fillStyle, this.font);
  }
  measureText(text: string): { readonly width: number } {
    return { width: text.length * this.charWidth };
  }
  drawImage(image: unknown, dx: number, dy: number): void {
    this.#record('drawImage', image, dx, dy);
  }

  callsTo(method: string): readonly RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

export class RecordingSurface implements Surface2D {
  readonly context = new RecordingContext();
  disposed = false;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  read(): FrameBuffer {
    return solidFrame(this.width, this.height, 1);
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class RecordingSurfaceProvider implements SurfaceProvider {
  readonly surfaces: RecordingSurface[] = [];
  /** `false` makes `createPath` return null, exercising the no-Path2D branch. */
  supportsPaths = true;

  create(width: number, height: number): Surface2D {
    const surface = new RecordingSurface(width, height);
    this.surfaces.push(surface);
    return surface;
  }

  createBitmap(buffer: FrameBuffer): DrawableImage {
    return { width: buffer.width, height: buffer.height };
  }

  createPath(data: string): object | null {
    return this.supportsPaths ? { d: data } : null;
  }
}

// ── processes ───────────────────────────────────────────────────────────────

export interface FakeRun {
  readonly spec: ProcessSpec;
}

/**
 * A process runner that never spawns anything.
 *
 * Records every invocation, so "FFmpeg was called with these arguments" is an assertion
 * on structure rather than on a rendered command line.
 */
export class FakeProcessRunner implements ProcessPort {
  readonly runs: FakeRun[] = [];
  readonly piped: { spec: ProcessSpec; chunks: Uint8Array[] }[] = [];

  /** Queued replies for `run`, consumed in order. Falls back to a clean exit. */
  readonly replies: ProcessResult[] = [];
  /** Reply for every `spawnPiped().end()`. */
  pipedResult: ProcessResult = { exitCode: 0, stdout: '', stderr: '' };
  /** When set, `spawnPiped` fails immediately. */
  spawnError: AppError | null = null;
  writeError: AppError | null = null;

  run(spec: ProcessSpec): Promise<Result<ProcessResult, AppError>> {
    this.runs.push({ spec });
    return Promise.resolve(ok(this.replies.shift() ?? { exitCode: 0, stdout: '', stderr: '' }));
  }

  spawnPiped(spec: ProcessSpec): Result<PipedProcess, AppError> {
    if (this.spawnError !== null) return { ok: false, error: this.spawnError };
    const record = { spec, chunks: [] as Uint8Array[] };
    this.piped.push(record);
    const writeError = (): AppError | null => this.writeError;
    const result = (): ProcessResult => this.pipedResult;

    return ok({
      write: (chunk: Uint8Array): Promise<Result<Unit, AppError>> => {
        const failure = writeError();
        if (failure !== null) return Promise.resolve({ ok: false, error: failure });
        record.chunks.push(Uint8Array.from(chunk));
        return Promise.resolve(ok());
      },
      end: (): Promise<Result<ProcessResult, AppError>> => Promise.resolve(ok(result())),
      abort: (): Promise<void> => Promise.resolve(),
    });
  }

  /** Total bytes handed to the last piped process. */
  pipedBytes(): number {
    const last = this.piped[this.piped.length - 1];
    return last === undefined ? 0 : last.chunks.reduce((total, chunk) => total + chunk.length, 0);
  }
}

// ── browser ─────────────────────────────────────────────────────────────────

export interface FakeBrowserOptions {
  /** Pixels the page returns per frame. Defaults to a 4x4 frame keyed by index. */
  readonly frame?: (index: number) => FrameBuffer;
  /** Throw from `evaluate` for `seek`, to exercise the error path. */
  readonly failSeekAt?: number;
  /** Never resolve `seek`, to exercise the timeout. */
  readonly hangSeek?: boolean;
  /** Return something the decoder must reject. */
  readonly malformedSeek?: boolean;
  /** Throw from `setContent`, to exercise the open-failure unwind. */
  readonly failOpen?: boolean;
}

export class FakePage implements BrowserPageLike {
  readonly evaluated: { script: string; arg: unknown }[] = [];
  readonly handlers = new Map<string, (payload: unknown) => void>();
  closed = false;
  viewport: { width: number; height: number } | null = null;
  html = '';

  constructor(private readonly options: FakeBrowserOptions) {}

  setViewportSize(size: { width: number; height: number }): Promise<void> {
    this.viewport = size;
    return Promise.resolve();
  }

  setContent(html: string): Promise<void> {
    this.html = html;
    if (this.options.failOpen === true) return Promise.reject(new Error('scene script threw'));
    return Promise.resolve();
  }

  evaluate(script: string, arg?: unknown): Promise<unknown> {
    this.evaluated.push({ script, arg });
    if (!script.includes('seek')) return Promise.resolve({ ok: true });

    const index = typeof arg === 'number' ? arg : 0;
    if (this.options.hangSeek === true) return new Promise<never>(() => undefined);
    if (this.options.failSeekAt === index) {
      // Mirrors a page error: the harness throws and Playwright rejects the evaluate.
      this.handlers.get('pageerror')?.(new Error('WebGL context lost'));
      return Promise.reject(new Error('Evaluation failed: WebGL context lost'));
    }
    if (this.options.malformedSeek === true) {
      return Promise.resolve({ width: 4, height: 4, base64: 'AAAA' });
    }

    const buffer = (this.options.frame ?? ((i: number) => indexedFrame(4, 4, i)))(index);
    this.handlers.get('console')?.(`drew frame ${String(index)}`);
    return Promise.resolve({
      width: buffer.width,
      height: buffer.height,
      base64: Buffer.from(buffer.data).toString('base64'),
    });
  }

  on(event: 'console' | 'pageerror', handler: (payload: unknown) => void): void {
    this.handlers.set(event, handler);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export class FakeBrowserLauncher implements BrowserLauncherLike {
  readonly pages: FakePage[] = [];
  browserClosed = false;
  contextClosed = false;

  constructor(private readonly options: FakeBrowserOptions = {}) {}

  launch(): Promise<BrowserLike> {
    const context: BrowserContextLike = {
      newPage: (): Promise<BrowserPageLike> => {
        const page = new FakePage(this.options);
        this.pages.push(page);
        return Promise.resolve(page);
      },
      close: (): Promise<void> => {
        this.contextClosed = true;
        return Promise.resolve();
      },
    };
    const browser: BrowserLike = {
      newContext: (): Promise<BrowserContextLike> => Promise.resolve(context),
      close: (): Promise<void> => {
        this.browserClosed = true;
        return Promise.resolve();
      },
    };
    return Promise.resolve(browser);
  }
}
