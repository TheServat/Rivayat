/**
 * The page-side half of the browser backend, as source text.
 *
 * It is a **seek protocol and nothing else**. ADR-0003's rule is "we seek; we never
 * play", and the page is where that rule is easiest to break: one
 * `requestAnimationFrame` loop, one CSS transition, one `Date.now()` in an easing
 * helper, and the render silently becomes wall-clock dependent - producing a different
 * file on a loaded CI box than on a developer's laptop, with nothing failing.
 *
 * So the harness exposes exactly two functions, both of which the Node side calls
 * explicitly, and `render-harness.spec.ts` scans this source for the forbidden
 * primitives. That scan is the enforcement RV-161 asks for; the comment above it is not.
 *
 * The **scene module** - PixiJS, the shaders, the filters - is supplied by the caller
 * and registers itself as `window.__rvScene`. This package does not bundle PixiJS:
 * `.dependency-cruiser.cjs` forbids an engine from importing `pixi.js`, and more to the
 * point the studio player already owns that code. Sharing it is what makes "renders
 * exactly as it does in the studio player" true rather than aspirational.
 */

/**
 * The contract the injected scene module must satisfy.
 *
 * ```js
 * window.__rvScene = {
 *   async init(spec) { ... },              // spec: { ir, size, background }
 *   async drawFrame(frame) { ... },        // draw, synchronously complete
 *   canvas,                                // the HTMLCanvasElement to read back
 * };
 * ```
 */
export const SCENE_GLOBAL = '__rvScene';
export const HARNESS_GLOBAL = '__rvHarness';

/**
 * Base64 RGBA rather than a transferable buffer.
 *
 * `page.evaluate` serialises its return value as JSON, so a `Uint8Array` arrives as an
 * object with numeric keys - 8.3 MB of frame becomes tens of megabytes of JSON per
 * frame. Base64 is 33 % overhead over a string that stays a string.
 */
export const RENDER_HARNESS_SOURCE = `
(() => {
  const state = { spec: null };

  function scene() {
    const module = window.${SCENE_GLOBAL};
    if (!module) throw new Error('no scene module registered as window.${SCENE_GLOBAL}');
    return module;
  }

  async function init(spec) {
    state.spec = spec;
    await scene().init(spec);
    return { ok: true };
  }

  async function seek(frame) {
    if (state.spec === null) throw new Error('seek before init');
    await scene().drawFrame(frame);

    const canvas = scene().canvas;
    if (!canvas) throw new Error('scene module exposes no canvas');

    const width = canvas.width;
    const height = canvas.height;
    const context = canvas.getContext('2d');
    let bytes;
    if (context && typeof context.getImageData === 'function') {
      bytes = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
    } else {
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) throw new Error('canvas exposes neither a 2d nor a webgl context');
      bytes = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      // WebGL's origin is bottom-left and every consumer here is top-left. Flipping in
      // the page costs one pass over the buffer; flipping in Node would mean the two
      // backends disagreed about which way up a frame is.
      const stride = width * 4;
      const flipped = new Uint8Array(bytes.length);
      for (let row = 0; row < height; row += 1) {
        flipped.set(bytes.subarray(row * stride, row * stride + stride), (height - 1 - row) * stride);
      }
      bytes = flipped;
    }

    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
    }
    return { width: width, height: height, base64: btoa(binary) };
  }

  window.${HARNESS_GLOBAL} = { init: init, seek: seek };
})();
`;

/**
 * The page document.
 *
 * No stylesheet beyond a reset, no fonts loaded over the network, no transitions. Every
 * one of those is a source of non-determinism: a font that arrives on the second frame
 * changes the first frame's pixels, and a CSS transition is a wall clock with better
 * manners.
 */
export function buildHarnessHtml(sceneScript: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>*{margin:0;padding:0;border:0}html,body{background:transparent;overflow:hidden}',
    '*{animation:none!important;transition:none!important}</style>',
    '</head><body>',
    `<script>${sceneScript}</script>`,
    `<script>${RENDER_HARNESS_SOURCE}</script>`,
    '</body></html>',
  ].join('');
}
