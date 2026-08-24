import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import App from './App.vue';
import PlaceholderView from './features/placeholder/PlaceholderView.vue';
import { IMPLEMENTED, NAV_KEYS, routes } from './router/index';
import { flush, mountStudio, resetStudio } from './test/harness';
import { useLocaleStore } from './stores/locale.store';
import { useThemeStore } from './stores/theme.store';

const SRC = __RV_SRC__;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|vue)$/.test(entry) && !entry.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('the studio shell', () => {
  it('has a route for every navigable section', () => {
    const named = new Set(routes.map((route) => route.name).filter(Boolean));
    for (const name of Object.keys(NAV_KEYS)) {
      expect(named.has(name), `no route named ${name}`).toBe(true);
    }
  });

  it('sends the root path to Projects', () => {
    expect(routes.find((route) => route.path === '/')?.redirect).toBe('/projects');
  });

  it('is honest about which screens exist', () => {
    // The claim is a *relation*, not a list: a section is marked implemented exactly
    // when its route no longer renders `PlaceholderView`. Asserted this way rather than
    // against a hard-coded roster because six screens are being built by different
    // people at different times, and a roster makes every one of those promotions a
    // three-way edit in a file nobody owns - which is how the badge and the screen drift
    // apart. The invariant is what matters and it holds at every point in between.
    const placeholders = new Set(
      routes
        .filter((route) => route.component === PlaceholderView)
        .map((route) => String(route.name)),
    );
    for (const [name, done] of Object.entries(IMPLEMENTED)) {
      expect(done, `${name} claims to be ${done ? 'built' : 'a placeholder'}`).toBe(
        !placeholders.has(name),
      );
    }
    // And at least the two that were real before any of this started.
    expect(IMPLEMENTED.projects && IMPLEMENTED.settings).toBe(true);
  });

  it('renders a placeholder that states what the screen will hold', async () => {
    // Whichever screen is still unbuilt, rather than a named one: the point is that the
    // placeholder says what will live there and which story delivers it, and naming a
    // route here would make this test fail the day that route is implemented - which is
    // the day it stops being about placeholders at all.
    const pending = routes.find((route) => route.component === PlaceholderView);
    if (pending === undefined) return;

    const wrapper = await mountStudio(App, { locale: 'en', path: String(pending.path) });
    await flush();

    expect(wrapper.text()).toContain('Not built yet');
    expect(wrapper.text()).toMatch(/RV-2\d\d/);
  });

  it('offers a skip link as the first focusable element', async () => {
    const wrapper = await mountStudio(App, { locale: 'en', path: '/projects' });
    await flush();

    const skip = wrapper.find('a.rv-skip-link');
    expect(skip.exists()).toBe(true);
    expect(skip.attributes('href')).toBe('#rv-main');
    expect(wrapper.find('#rv-main').exists()).toBe(true);
  });
});

describe('locale and theme are persisted', () => {
  it('starts a fresh profile in Persian', () => {
    // RV-201: no stored preference at all, not "stored as fa".
    resetStudio('fa');
    globalThis.localStorage.clear();
    const locale = useLocaleStore();
    expect(locale.locale).toBe('fa');
    expect(locale.direction).toBe('rtl');
  });

  it('writes the chosen locale to storage and flips the document direction', async () => {
    await mountStudio(App, { locale: 'fa', path: '/projects' });
    const locale = useLocaleStore();

    locale.setLocale('en');
    await flush();

    expect(globalThis.localStorage.getItem('rv.locale')).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('writes an explicit theme to the document and leaves system implicit', async () => {
    await mountStudio(App, { locale: 'en', path: '/projects' });
    const theme = useThemeStore();

    theme.setPreference('dark');
    await flush();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(globalThis.localStorage.getItem('rv.theme')).toBe('dark');

    theme.setPreference('system');
    await flush();
    // No attribute: `prefers-color-scheme` in `tokens.css` decides, so the two
    // mechanisms cannot disagree.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('types come from the contracts', () => {
  /**
   * RV-200: no locally declared response interfaces.
   *
   * The one sanctioned exception is `src/api/schemas/pending-contracts.ts`, which
   * exists because `@rv/contracts` does not yet export `ProjectSummary` or
   * `RunEvent`, and which says so at the top of the file. Anything else
   * declaring a DTO is drift. `src/api/schemas/settings.ts` needs no exception: it
   * composes the real registry shapes rather than restating any.
   */
  it('declares no response DTO outside the single pending-contracts adapter', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith(join('api', 'schemas', 'pending-contracts.ts'))) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(
        /\b(?:export\s+)?(?:interface|type)\s+(\w*(?:Response|Dto|Payload|Envelope))\b/g,
      )) {
        offenders.push(`${file}: ${match[1] ?? ''}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports no server-only workspace package', () => {
    // `pnpm arch:check` enforces this too; asserting it here means a bad import fails
    // the fast suite instead of waiting for the architecture job.
    // `settings` is on the list even though `@rv/contracts` re-exports the registry it
    // reads: the resolver package itself loads `.env` and talks to the repository, and
    // the studio's fixture transport re-implements the walk locally rather than
    // importing it.
    // `anim-engine` is deliberately **not** on this list, and it is the one exception.
    // The dependency rule is `apps -> engines -> core-domain/contracts -> shared-kernel`,
    // and `.dependency-cruiser.cjs` bans exactly four things from `apps/web`:
    // `apps/api`, `providers`, `asset-registry` and `render-engine`. The IR evaluator is
    // none of those - it is pure arithmetic over the contracts with no IO and no SDK -
    // and the timeline player is required to use its `evaluate` rather than a
    // preview-grade copy, because a preview that disagrees with the renderer makes every
    // downstream judgement guesswork. See `docs/06-screen-briefs.md`, Timeline.
    //
    // The scan reads *module specifiers*, not prose. It used to match the package name
    // anywhere in the file, which made the sentence "the studio may not import
    // `@rv/style-engine`" a build failure - so the honest comment explaining why a
    // fixture exists was punished and a silent `import` a few lines below it would have
    // been caught by exactly the same regex. Matching `from '...'`, `import('...')` and
    // `require('...')` catches every way a bundler can be made to resolve one, and lets
    // a file say what it is not allowed to do.
    const PACKAGES =
      'providers|persistence|render-engine|asset-registry|asset-engine|story-engine|style-engine|core-domain|prompt-kit|narrative-memory|export-kit|settings';
    const forbidden = new RegExp(
      String.raw`(?:from|import|require)\s*\(?\s*['"]@rv/(?:${PACKAGES})(?:/|['"])`,
    );
    const offenders = sourceFiles(SRC).filter((file) => forbidden.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
