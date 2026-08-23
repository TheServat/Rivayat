import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { setStudioApi, StudioApi } from '../api/client';
import { FixtureTransport } from '../api/fixtures/fixture-transport';
import type { StudioTransport } from '../api/transport';

import { LOCALE_STORAGE_KEY, useLocaleStore } from './locale.store';
import { useProjectsStore } from './projects.store';
import { THEME_STORAGE_KEY, useThemeStore } from './theme.store';

function emptyProjects(): StudioTransport {
  return {
    kind: 'http',
    send: (request) => Promise.resolve(request.schema.parse({ projects: [] })),
    eventSourceUrl: () => null,
  };
}

describe('locale store', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    setActivePinia(createPinia());
  });

  it('ignores a stored value that is not a locale the studio ships', () => {
    // `localStorage` is text the user can edit; a bad value must not reach the `dir`
    // lookup, which would then be `undefined`.
    globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, 'klingon');
    const locale = useLocaleStore();
    expect(locale.locale).toBe('fa');
    expect(locale.direction).toBe('rtl');
    expect(locale.tag).toBe('fa-IR');
  });

  it('exposes the BCP-47 tag Intl needs, which is not the message key', () => {
    const locale = useLocaleStore();
    locale.setLocale('en');
    expect(locale.tag).toBe('en-GB');
  });
});

describe('theme store', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    setActivePinia(createPinia());
    document.documentElement.removeAttribute('data-theme');
  });

  it('ignores a stored value that is not a known preference', () => {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(useThemeStore().preference).toBe('system');
  });

  it('resolves an explicit choice without asking the OS', () => {
    const theme = useThemeStore();
    theme.setPreference('dark');
    expect(theme.resolved).toBe('dark');
    theme.setPreference('light');
    expect(theme.resolved).toBe('light');
  });
});

describe('projects store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setStudioApi(new StudioApi(new FixtureTransport()));
  });

  it('sums spend across projects so the shell can show a running total', async () => {
    const projects = useProjectsStore();
    await projects.load();
    expect(projects.status).toBe('ready');
    expect(projects.totalSpentNanoUsd).toBe(1_842_000_000);
    expect(projects.isEmpty).toBe(false);
  });

  it('distinguishes "no projects" from "not loaded yet"', async () => {
    const projects = useProjectsStore();
    expect(projects.isEmpty).toBe(false);

    setStudioApi(new StudioApi(emptyProjects()));
    await projects.load();
    expect(projects.isEmpty).toBe(true);
  });

  it('records an API failure as an error rather than an empty list', async () => {
    setStudioApi(
      new StudioApi({
        kind: 'http',
        send: () => Promise.reject(new Error('offline')),
        eventSourceUrl: () => null,
      }),
    );
    const projects = useProjectsStore();
    await projects.load();

    expect(projects.status).toBe('error');
    expect(projects.isEmpty).toBe(false);
    expect(projects.error?.code).toBe('projects-load-failed');
  });
});
