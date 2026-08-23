import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createStudioI18n, DEFAULT_LOCALE, LOCALE_DIRECTION, messages } from './index';
import en from './messages/en';
import fa from './messages/fa';

type Tree = Record<string, unknown>;

/** Every leaf path in a catalogue, e.g. `settings.groups.budget`. */
function keyPaths(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return typeof value === 'object' && value !== null ? keyPaths(value as Tree, path) : [path];
  });
}

function resolve(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Tree)[part];
  }, tree);
}

const SRC = __RV_SRC__;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|vue)$/.test(entry) && !entry.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('message catalogues', () => {
  const faKeys = keyPaths(fa).toSorted();
  const enKeys = keyPaths(en).toSorted();

  it('fa and en have identical key sets', () => {
    // Two assertions rather than one, because "en is missing budget.onExceed" and
    // "en has an orphan key" are different bugs and the diff should say which.
    expect(faKeys.filter((key) => !enKeys.includes(key))).toEqual([]);
    expect(enKeys.filter((key) => !faKeys.includes(key))).toEqual([]);
  });

  it('every message is a non-empty string', () => {
    for (const key of faKeys) {
      expect(resolve(fa, key), `fa.${key}`).toBeTypeOf('string');
      expect(String(resolve(fa, key)).length, `fa.${key}`).toBeGreaterThan(0);
      expect(resolve(en, key), `en.${key}`).toBeTypeOf('string');
      expect(String(resolve(en, key)).length, `en.${key}`).toBeGreaterThan(0);
    }
  });

  it('the same message uses the same interpolation placeholders in both locales', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').toSorted();

    for (const key of faKeys) {
      const faText = String(resolve(fa, key));
      const enText = String(resolve(en, key));
      // A translation that drops `{count}` renders a sentence with a hole in it, and
      // nothing else in the toolchain notices.
      expect(placeholders(enText), key).toEqual(placeholders(faText));
    }
  });

  it('the same message offers the same number of plural forms in both locales', () => {
    for (const key of faKeys) {
      const faForms = String(resolve(fa, key)).split('|').length;
      const enForms = String(resolve(en, key)).split('|').length;
      expect(enForms, key).toBe(faForms);
    }
  });
});

describe('Persian pluralisation', () => {
  /**
   * Zero and one share a grammatical form, and a three-form message opts out.
   *
   * Both halves are asserted because the second exists to fix a bug the first caused: a
   * project with no episodes rendered "one episode", since a two-form Persian message
   * has nothing to say about zero. Grammatical agreement and factual accuracy are
   * different problems; a message that needs to say "none" supplies a third form.
   */
  const i18n = createStudioI18n('fa');
  const translate = i18n.global.t.bind(i18n.global);

  it('puts zero and one in the same form when a message offers two', () => {
    // `settings.dirtyCount` is a two-form message: "one unsaved change | N changes".
    expect(translate('settings.dirtyCount', 0)).toBe(translate('settings.dirtyCount', 1));
    expect(translate('settings.dirtyCount', 2)).not.toBe(translate('settings.dirtyCount', 1));
  });

  it('gives zero its own form when a message offers three', () => {
    const none = translate('projects.episodeCount', { count: '۰' }, 0);
    const one = translate('projects.episodeCount', { count: '۱' }, 1);
    const many = translate('projects.episodeCount', { count: '۵' }, 5);

    expect(none).not.toBe(one);
    expect(none).toBe('بدون قسمت');
    expect(one).toBe('یک قسمت');
    expect(many).toBe('۵ قسمت');
  });

  it('leaves English alone', () => {
    const english = createStudioI18n('en');
    const t = english.global.t.bind(english.global);
    expect(t('projects.episodeCount', { count: '0' }, 0)).toBe('No episodes');
    expect(t('projects.episodeCount', { count: '1' }, 1)).toBe('One episode');
    expect(t('projects.episodeCount', { count: '5' }, 5)).toBe('5 episodes');
  });
});

describe('translation coverage of the source', () => {
  /**
   * Every literal key passed to `t()` resolves in the Persian catalogue.
   *
   * vue-i18n's `t` accepts any `string`, so a typo in a key path is not a type error.
   * The runtime `missing` handler throws, which stops a raw key ever reaching a user -
   * but only on the code path that renders it. This scan is what turns "would throw
   * when someone opens that screen" into "fails the build now".
   */
  it('every t() key literal exists in fa', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z][\w.-]*)'/g)) {
        const key = match[1] ?? '';
        if (typeof resolve(fa, key) !== 'string') offenders.push(`${file}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('locale configuration', () => {
  it('defaults to Persian, which is right-to-left', () => {
    expect(DEFAULT_LOCALE).toBe('fa');
    expect(LOCALE_DIRECTION.fa).toBe('rtl');
    expect(LOCALE_DIRECTION.en).toBe('ltr');
  });

  it('carries a catalogue for every supported locale', () => {
    expect(Object.keys(messages).toSorted()).toEqual(['en', 'fa']);
  });

  it('throws rather than rendering a raw key for a missing translation', () => {
    const i18n = createStudioI18n('fa');
    // Reaching into the composer directly: the point is the handler, and no component
    // should be able to produce this state now that the catalogues are typed.
    expect(() => i18n.global.t('settings.thisKeyDoesNotExist')).toThrow(/missing translation/);
  });
});
