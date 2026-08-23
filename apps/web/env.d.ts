/// <reference types="vite/client" />

/**
 * The environment the studio reads at build time.
 *
 * Declared rather than inferred so that a typo in a `VITE_` name is a compile error
 * instead of `undefined` at runtime, and so that the set of switches the app honours
 * is readable in one place.
 */
interface ImportMetaEnv {
  /**
   * Base URL of `apps/api`, e.g. `http://localhost:3000/api`. Empty means "same
   * origin", which is what a production build behind one reverse proxy wants.
   */
  readonly VITE_RV_API_BASE_URL?: string;
  /**
   * `http` talks to the API. `fixture` serves the recorded payloads in
   * `src/api/fixtures/` instead, which is how the e2e suite and a UI-only dev session
   * run with no backend. The shell renders a visible badge whenever it is not `http`,
   * because a screen backed by fixtures must never be mistaken for a working one.
   */
  readonly VITE_RV_TRANSPORT?: 'http' | 'fixture';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Absolute path to `apps/web/src`, injected by `vitest.config.ts`.
 *
 * Only the source-scanning specs use it. It is not available to the application - a
 * screen has no business reading its own source - and `vite.config.ts` deliberately
 * does not define it, so an accidental use fails the build.
 */
declare const __RV_SRC__: string;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
