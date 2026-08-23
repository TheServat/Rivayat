/**
 * The slice of Playwright the browser backend uses, restated structurally.
 *
 * `.dependency-cruiser.cjs` forbids `packages/*-engine/src` from reaching
 * `node_modules/playwright` at all - including a type-only import - so the engine
 * describes the shape it needs and the composition root hands it the real module:
 *
 * ```ts
 * import { chromium } from 'playwright';
 * const backend = new PixiPlaywrightBackend({ launcher: chromium });
 * ```
 *
 * That is not merely rule-compliance. Research §6 measured headless Chrome at 8-15 s
 * per 150 frames at 1080p, and CI does not install a browser at all (ADR-0003: "`pnpm
 * test` must never require it"). An injected launcher is what lets the backend's own
 * logic - the seek protocol, the readback, the error mapping - be tested with a fake at
 * full coverage while the real browser stays opt-in.
 *
 * Everything here is `unknown`-in / `unknown`-out at the edges where Playwright's own
 * types are structural noise; the backend narrows once, at the boundary.
 */

/** `page.evaluate` and friends. Only the members the harness actually calls. */
export interface BrowserPageLike {
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  setContent(html: string, options?: { waitUntil?: 'load' | 'domcontentloaded' }): Promise<void>;
  /**
   * Runs `fn` in the page with one serialisable argument.
   *
   * Typed as a string of JS rather than a function so nothing in this package depends
   * on Playwright's function-serialisation semantics, which differ between its own
   * versions and would be untestable against a fake.
   */
  evaluate(script: string, arg?: unknown): Promise<unknown>;
  on(event: 'console' | 'pageerror', handler: (payload: unknown) => void): void;
  close(): Promise<void>;
}

export interface BrowserContextLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

/** `chromium` from `playwright`, as far as this package is concerned. */
export interface BrowserLauncherLike {
  launch(options?: Record<string, unknown>): Promise<BrowserLike>;
}

/**
 * The sharp module, restated for the same reason.
 *
 * Used only by the perceptual comparison in `visual/`; the frame loop never touches
 * it. `sharp` is on the same forbidden list as `playwright`, so it arrives the same
 * way - injected from the composition root.
 */
export interface SharpInstanceLike {
  greyscale(): SharpInstanceLike;
  resize(width: number, height: number, options?: Record<string, unknown>): SharpInstanceLike;
  raw(): SharpInstanceLike;
  toBuffer(): Promise<Uint8Array>;
}

export type SharpLike = (input: Uint8Array, options?: Record<string, unknown>) => SharpInstanceLike;
