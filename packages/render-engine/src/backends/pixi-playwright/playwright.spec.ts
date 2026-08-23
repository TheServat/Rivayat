/**
 * The browser backend, through its port, with a fake page.
 *
 * ADR-0003: "`pnpm test` must never require it - browser-backed render tests are
 * opt-in." So Playwright is never launched here. What *is* covered is everything this
 * package wrote: the seek protocol, the readback decode and its rejection of a
 * malformed payload, the console capture on failure, the timeout that stops a lost
 * WebGL context hanging a worker, and the teardown order. What is deliberately not
 * covered is PixiJS drawing, which lives in the injected scene module.
 */

import { unwrap } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { FakeBrowserLauncher, indexedFrame } from '../../__fixtures__/doubles';
import { pure2dIr } from '../../__fixtures__/ir';
import { hashFrame } from '../../frames/frame-hash';
import { HARNESS_GLOBAL } from './render-harness';
import { PixiPlaywrightBackend, decodeSeekReply, withTimeout } from './playwright-backend';

const SIZE = { width: 4, height: 4 };
const SCENE_SCRIPT = 'window.__rvScene = { init(){}, drawFrame(){}, canvas: null };';

function backend(launcher: FakeBrowserLauncher, timeoutMs = 1000): PixiPlaywrightBackend {
  return new PixiPlaywrightBackend({ launcher, sceneScript: SCENE_SCRIPT, timeoutMs });
}

describe('PixiPlaywrightBackend', () => {
  it('sets the viewport to the render size and loads the harness inline', async () => {
    const launcher = new FakeBrowserLauncher();
    const source = unwrap(await backend(launcher).open({ ir: pure2dIr(), size: SIZE }));
    const page = launcher.pages[0];
    expect(page?.viewport).toEqual(SIZE);
    expect(page?.html).toContain(SCENE_SCRIPT);
    expect(page?.html).toContain(HARNESS_GLOBAL);
    await source.close();
  });

  it('drives the page by explicit seek calls', async () => {
    const launcher = new FakeBrowserLauncher();
    const source = unwrap(await backend(launcher).open({ ir: pure2dIr(), size: SIZE }));
    await source.renderFrame(7);
    const calls = launcher.pages[0]?.evaluated ?? [];
    expect(calls[0]?.script).toContain('init');
    expect(calls[1]).toMatchObject({ script: expect.stringContaining('seek'), arg: 7 });
    await source.close();
  });

  it('decodes the page payload back into the frame the page drew', async () => {
    const launcher = new FakeBrowserLauncher({ frame: (index) => indexedFrame(4, 4, index) });
    const source = unwrap(await backend(launcher).open({ ir: pure2dIr(), size: SIZE }));
    const frame = unwrap(await source.renderFrame(3));
    expect(hashFrame(frame)).toBe(hashFrame(indexedFrame(4, 4, 3)));
    await source.close();
  });

  it('rejects a payload whose byte count disagrees with its declared size', async () => {
    // A short buffer encodes as a green band nobody notices until the upload.
    const launcher = new FakeBrowserLauncher({ malformedSeek: true });
    const source = unwrap(await backend(launcher).open({ ir: pure2dIr(), size: SIZE }));
    const result = await source.renderFrame(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROVIDER_ERROR');
    await source.close();
  });

  it('captures the browser console when a frame fails', async () => {
    const launcher = new FakeBrowserLauncher({ failSeekAt: 2 });
    const source = unwrap(await backend(launcher).open({ ir: pure2dIr(), size: SIZE }));
    const result = await source.renderFrame(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context).toMatchObject({
      console: expect.arrayContaining([expect.stringContaining('WebGL context lost')]) as unknown,
    });
    await source.close();
  });

  it('times out rather than hanging on a lost context', async () => {
    const launcher = new FakeBrowserLauncher({ hangSeek: true });
    const source = unwrap(await backend(launcher, 20).open({ ir: pure2dIr(), size: SIZE }));
    const result = await source.renderFrame(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('timeout');
  });

  it('unwinds the browser when opening fails', async () => {
    // A failed launch that leaves Chromium running eats a gigabyte per worker.
    const launcher = new FakeBrowserLauncher({ failOpen: true });
    const opened = await backend(launcher).open({ ir: pure2dIr(), size: SIZE });
    expect(opened.ok).toBe(false);
    expect(launcher.pages[0]?.closed).toBe(true);
    expect(launcher.contextClosed).toBe(true);
    expect(launcher.browserClosed).toBe(true);
  });

  it('closes page, context and browser on a clean close', async () => {
    const launcher = new FakeBrowserLauncher();
    const source = unwrap(await backend(launcher).open({ ir: pure2dIr(), size: SIZE }));
    await source.close();
    expect(launcher.pages[0]?.closed).toBe(true);
    expect(launcher.contextClosed).toBe(true);
    expect(launcher.browserClosed).toBe(true);
  });

  it('does not let a teardown failure mask the real error', async () => {
    // A close that throws must not become the reported failure - and must still let the
    // context and browser be closed, or a Chromium process outlives the worker.
    const launcher = new FakeBrowserLauncher();
    const source = unwrap(await backend(launcher).open({ ir: pure2dIr(), size: SIZE }));
    const page = launcher.pages[0];
    if (page === undefined) throw new Error('no page');
    page.close = (): Promise<void> => Promise.reject(new Error('already detached'));
    await expect(source.close()).resolves.toBeUndefined();
    expect(launcher.browserClosed).toBe(true);
  });

  it('renders whatever the browser puts on the console into the error context', async () => {
    // Playwright hands `console` a message object, `pageerror` an Error, and a fake or a
    // future version may hand either a plain string. All three have to survive into the
    // diagnostic rather than becoming "[object Object]".
    const launcher = new FakeBrowserLauncher({ failSeekAt: 0 });
    const source = unwrap(await backend(launcher).open({ ir: pure2dIr(), size: SIZE }));
    const page = launcher.pages[0];
    if (page === undefined) throw new Error('no page');
    page.handlers.get('console')?.({ text: (): string => 'from a message object' });
    page.handlers.get('console')?.(42);
    const result = await source.renderFrame(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const captured = (result.error.context as { console: readonly string[] }).console;
    expect(captured).toContain('from a message object');
    expect(captured).toContain('42');
    await source.close();
  });

  it('reports itself as the browser backend and claims every feature', () => {
    const instance = backend(new FakeBrowserLauncher());
    expect(instance.id).toBe('pixi-playwright');
    expect(instance.capabilities.features.has('particles')).toBe(true);
    expect(instance.capabilities.features.has('filter')).toBe(true);
  });
});

describe('decodeSeekReply', () => {
  it('accepts a well-formed payload', () => {
    const frame = indexedFrame(2, 2, 1);
    const decoded = decodeSeekReply({
      width: 2,
      height: 2,
      base64: Buffer.from(frame.data).toString('base64'),
    });
    expect(decoded?.data).toEqual(frame.data);
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['missing dimensions', { base64: 'AA==' }],
    ['missing pixels', { width: 1, height: 1 }],
    ['wrong byte count', { width: 4, height: 4, base64: 'AAAA' }],
  ])('rejects %s', (_name, payload) => {
    expect(decodeSeekReply(payload)).toBeNull();
  });
});

describe('withTimeout', () => {
  it('passes a value straight through', async () => {
    await expect(withTimeout(Promise.resolve(5), 1000, 'x')).resolves.toBe(5);
  });

  it('rejects with a typed timeout', async () => {
    await expect(withTimeout(new Promise(() => undefined), 5, 'seek')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});
