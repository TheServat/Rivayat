import type { Locale } from '@rv/contracts';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { Component } from 'vue';
import { createRouter, createWebHistory, type Router } from 'vue-router';

import { setStudioApi, StudioApi } from '../api/client';
import { FixtureTransport } from '../api/fixtures/fixture-transport';
import { createStudioI18n } from '../i18n/index';
import { routes } from '../router/index';
import { LOCALE_STORAGE_KEY } from '../stores/locale.store';

/**
 * One way to mount a component under test.
 *
 * It installs the real i18n, the real router and a real Pinia, and points the API
 * client at the fixture transport. Nothing here stubs the studio's own code - a test
 * that mounts a component against fake stores proves the fakes work, and the things
 * this suite has to prove (a form generated from a registry, a layout that survives
 * both directions) are exactly what a fake would paper over.
 */
export interface HarnessOptions {
  readonly locale?: Locale;
  readonly props?: Record<string, unknown>;
  readonly path?: string;
  /** Replaces the fixture-backed client, for the failure paths a fixture cannot produce. */
  readonly api?: StudioApi;
}

/**
 * Puts the environment back to a fresh profile in `locale`.
 *
 * The stored locale is written as a bare string, not JSON: `useLocalStorage` picks its
 * serialiser from the type of the default value, and for a string default that
 * serialiser is the identity.
 */
export function resetStudio(locale: Locale = 'fa'): Pinia {
  globalThis.localStorage.clear();
  globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.lang = locale;
  setStudioApi(new StudioApi(new FixtureTransport()));
  // A fresh Pinia as well as fresh storage. A store instance outlives the localStorage
  // entry it was built from, so clearing storage alone leaves the previous test's
  // locale in memory - and the "a fresh profile starts in Persian" assertion would
  // pass or fail depending on which test ran before it.
  const pinia = createPinia();
  setActivePinia(pinia);
  return pinia;
}

export function createTestRouter(): Router {
  return createRouter({ history: createWebHistory(), routes: [...routes] });
}

export async function mountStudio(
  component: Component,
  options: HarnessOptions = {},
): Promise<VueWrapper> {
  const locale = options.locale ?? 'fa';
  const pinia = resetStudio(locale);
  if (options.api !== undefined) setStudioApi(options.api);

  const router = createTestRouter();
  await router.push(options.path ?? '/settings');
  await router.isReady();

  return mount(component, {
    props: options.props ?? {},
    global: { plugins: [pinia, createStudioI18n(locale), router] },
    attachTo: document.body,
  });
}

/** Lets pending microtasks settle - the fixture transport resolves on one. */
export async function flush(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}
