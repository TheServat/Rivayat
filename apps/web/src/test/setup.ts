/**
 * Test environment shims.
 *
 * jsdom implements neither `matchMedia` nor `EventSource`, and both are load-bearing:
 * the theme store asks the OS what it prefers, and the run-progress composable opens an
 * SSE stream. `matchMedia` is faked once here because every component test mounts the
 * shell; `EventSource` is left absent on purpose, so a spec that cares about SSE
 * installs its own double and cannot silently inherit one another spec left behind.
 */

const stubMediaQueryList = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
});

if (typeof globalThis.matchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: stubMediaQueryList });
}
