import { nextTick } from 'vue';
import type { Router } from 'vue-router';

/** How long the capture may wait for Vue before the transition is let go anyway. */
const CAPTURE_CEILING_MS = 220;

/**
 * Hands route changes to the View Transitions API where the browser has one.
 *
 * The fallback — a CSS `<Transition>` on the router view — can only fade one screen out
 * and move the next one in. It cannot carry an element *across* the change, because the
 * old element is gone by the time the new one exists. A view transition can: the
 * browser snapshots both states and interpolates between them, so an element that
 * exists on both sides travels rather than disappearing from one place and reappearing
 * in another. That is the single highest-value motion technique in an interface with
 * navigation, and it is worth twenty lines.
 *
 * Three guards, all of which matter:
 *
 *   - **No API, no change.** Firefox and older Safari fall through to the CSS
 *     transition, which is why `motion.css` keeps both and switches one off with the
 *     `rv-vt` class rather than assuming.
 *   - **Reduced motion opts out entirely.** A view transition is a full-page cross-fade
 *     at minimum, and the point of the preference is not to shorten that but to not do
 *     it. The CSS path degrades to a fade; this one is simply never installed.
 *   - **Not on the first navigation.** Booting into `/projects` from a blank document
 *     would transition from nothing to something, which reads as a flash rather than a
 *     movement.
 *
 * The `resolve()`-inside-the-callback shape is the documented way to bridge the two
 * APIs: `startViewTransition` wants a callback that mutates the DOM, and Vue Router
 * wants a guard that resolves before it will mutate anything. Resolving from inside the
 * callback lets the navigation continue while the transition is already capturing, and
 * the returned promise holds the "after" snapshot until Vue has actually patched. Both
 * halves of that wait are bounded — see `domSettled` and `after`.
 */

/**
 * Resolves once Vue has patched the DOM for the new route.
 *
 * Two ticks, not one. `resolve()` below lets the navigation continue, but the router
 * writes the new route in a microtask *after* the guard settles, and Vue only schedules
 * its render job once that write happens — so a single `nextTick()` returns an already
 * resolved promise and the "after" snapshot is taken of the screen the user is leaving.
 */
function domSettled(): Promise<void> {
  return new Promise((resolve) => {
    void nextTick(() => {
      void nextTick(() => {
        resolve();
      });
    });
  });
}

/**
 * A hard ceiling on the capture, on a timer rather than a frame.
 *
 * `requestAnimationFrame` does not fire while a view transition is capturing — the
 * browser has rendering suspended — so a frame-based wait inside the callback never
 * settles and Chrome eventually aborts the transition with "timeout in DOM update",
 * leaving the old snapshot on screen over the new route. A `setTimeout` still fires,
 * which makes this the one safe way to bound the wait.
 */
function after(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Installs the guard and returns the function that removes it again.
 *
 * Returned rather than tied to a component lifecycle, so the caller decides: the shell
 * unmounts in tests far more often than it does in a browser, and a guard left
 * registered on a discarded router is a leak that only shows up as a slow suite.
 */
export function installRouteViewTransition(router: Router): () => void {
  const doc = document;
  if (typeof doc.startViewTransition !== 'function') return () => undefined;
  if (globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => undefined;

  const start = doc.startViewTransition.bind(doc);
  doc.documentElement.classList.add('rv-vt');

  const remove = router.beforeResolve((_to, from) => {
    if (from.name === undefined) return true;
    return new Promise<boolean>((resolveGuard) => {
      start(() => {
        resolveGuard(true);
        return Promise.race([domSettled(), after(CAPTURE_CEILING_MS)]);
      });
    });
  });

  return () => {
    doc.documentElement.classList.remove('rv-vt');
    remove();
  };
}
