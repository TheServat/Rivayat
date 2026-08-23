import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { flush, mountStudio } from '../test/harness';

import AppShell from './AppShell.vue';

const SRC = __RV_SRC__;

function styleSources(directory: string): { file: string; css: string }[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return styleSources(full);
    if (entry.endsWith('.css')) return [{ file: full, css: readFileSync(full, 'utf8') }];
    if (!entry.endsWith('.vue')) return [];
    const text = readFileSync(full, 'utf8');
    const blocks = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(
      (match) => match[1] ?? '',
    );
    return blocks.length === 0 ? [] : [{ file: full, css: blocks.join('\n') }];
  });
}

/**
 * Physical properties, as a rule the build enforces rather than a habit reviewers
 * remember.
 *
 * `margin-left` is not a style choice in a bilingual studio; it is a bug that is only
 * visible in one of the two directions - and the direction it breaks in is the one the
 * owner works in. The scan is deliberately over the *source*, not the rendered
 * stylesheet, so the failure names the file and the line.
 */
const FORBIDDEN = [
  /(^|[\s;{])(margin|padding|border|inset)-(left|right)\s*:/,
  /(^|[\s;{])border-(left|right)-(color|width|style)\s*:/,
  /(^|[\s;{])(left|right)\s*:/,
  /text-align\s*:\s*(left|right)\b/,
  /float\s*:\s*(left|right)\b/,
  /\bclear\s*:\s*(left|right)\b/,
];

describe('stylesheets are direction-agnostic', () => {
  it('uses no physical left/right properties anywhere in src', () => {
    const offenders: string[] = [];
    for (const { file, css } of styleSources(SRC)) {
      css.split('\n').forEach((line, index) => {
        const stripped = line.replace(/\/\*.*?\*\//g, '');
        if (FORBIDDEN.some((pattern) => pattern.test(stripped))) {
          offenders.push(`${file}:${String(index + 1)} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('defines every colour as a token and uses no literal hex outside the token file', () => {
    const offenders: string[] = [];
    for (const { file, css } of styleSources(SRC)) {
      if (file.endsWith('tokens.css')) continue;
      css.split('\n').forEach((line, index) => {
        if (/#[0-9a-fA-F]{3,8}\b/.test(line.replace(/\/\*.*?\*\//g, ''))) {
          offenders.push(`${file}:${String(index + 1)} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('the shell renders in both directions', () => {
  it('is right-to-left and in Persian by default', async () => {
    const wrapper = await mountStudio(AppShell, { locale: 'fa', path: '/settings' });
    await flush();

    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('fa');
    expect(wrapper.text()).toContain('روایت');
    expect(wrapper.text()).toContain('تنظیمات');
    expect(wrapper.text()).not.toContain('Settings');
  });

  it('is left-to-right and in English when the locale is en', async () => {
    const wrapper = await mountStudio(AppShell, { locale: 'en', path: '/settings' });
    await flush();

    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
    expect(wrapper.text()).toContain('Rivayat');
    expect(wrapper.text()).toContain('Settings');
    expect(wrapper.text()).not.toContain('تنظیمات');
  });

  it('renders the same elements in both directions, with no mirrored markup', async () => {
    const structure = async (locale: 'fa' | 'en'): Promise<string[]> => {
      const wrapper = await mountStudio(AppShell, { locale, path: '/projects' });
      await flush();
      await wrapper.vm.$nextTick();
      return [...(wrapper.element as Element).querySelectorAll('[class]')].map(
        (node) => node.getAttribute('class') ?? '',
      );
    };

    // Direction is a property of `<html>` and of the logical properties that resolve
    // against it. If a screen ever mirrors itself by swapping markup or classes, this
    // is where it shows up.
    //
    // Projects rather than Settings, because a numeric setting deliberately renders an
    // extra Persian-digit echo beside its ASCII input (RV-203). That is a difference in
    // *content*, not in layout, and folding it into this assertion would only teach the
    // next person to weaken the assertion.
    expect(await structure('fa')).toEqual(await structure('en'));
  });

  it('marks the active nav item without depending on a side', async () => {
    const wrapper = await mountStudio(AppShell, { locale: 'fa', path: '/projects' });
    await flush();

    const active = wrapper.findAll('a.router-link-active');
    expect(active.length).toBeGreaterThan(0);
    expect(active.some((link) => link.attributes('href') === '/projects')).toBe(true);
  });
});
