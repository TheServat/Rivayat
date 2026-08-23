/**
 * A source scan, which is exactly what RV-161 asks for.
 *
 * "Given the page, when it renders, then it is driven by explicit `seek(t)` calls - a
 * source scan asserts no `requestAnimationFrame`-driven timing in the render harness."
 *
 * The scan is the enforcement. A comment saying "do not add a rAF loop here" is not,
 * and the harness is the single easiest place in the system to reintroduce wall-clock
 * timing by accident - one animation library that starts its own ticker and the render
 * is no longer reproducible, with nothing failing.
 */

import { describe, expect, it } from 'vitest';

import {
  HARNESS_GLOBAL,
  RENDER_HARNESS_SOURCE,
  SCENE_GLOBAL,
  buildHarnessHtml,
} from './render-harness';

describe('render harness source', () => {
  it.each([
    'requestAnimationFrame',
    'setInterval',
    'setTimeout',
    'Date.now',
    'performance.now',
    'Math.random',
  ])('contains no %s', (forbidden) => {
    expect(RENDER_HARNESS_SOURCE).not.toContain(forbidden);
  });

  it('exposes exactly the two functions the Node side calls', () => {
    expect(RENDER_HARNESS_SOURCE).toContain(
      `window.${HARNESS_GLOBAL} = { init: init, seek: seek }`,
    );
  });

  it('reads pixels back rather than screenshotting', () => {
    // A screenshot goes through the compositor and picks up device scaling; reading the
    // canvas is the frame the scene drew.
    expect(RENDER_HARNESS_SOURCE).toContain('getImageData');
    expect(RENDER_HARNESS_SOURCE).toContain('readPixels');
  });

  it('flips the WebGL readback, because its origin is bottom-left', () => {
    expect(RENDER_HARNESS_SOURCE).toContain('height - 1 - row');
  });

  it('refuses to seek before init', () => {
    expect(RENDER_HARNESS_SOURCE).toContain('seek before init');
  });

  it('names the scene module it expects the caller to register', () => {
    expect(RENDER_HARNESS_SOURCE).toContain(`window.${SCENE_GLOBAL}`);
  });
});

describe('buildHarnessHtml', () => {
  const html = buildHarnessHtml('window.__rvScene = {};');

  it('inlines the scene script before the harness', () => {
    expect(html.indexOf('__rvScene')).toBeLessThan(html.indexOf(HARNESS_GLOBAL));
  });

  it('disables CSS animation and transitions', () => {
    // A CSS transition is a wall clock with better manners.
    expect(html).toContain('animation:none!important');
    expect(html).toContain('transition:none!important');
  });

  it('loads nothing over the network', () => {
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('<link');
  });
});
