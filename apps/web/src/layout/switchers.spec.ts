import { describe, expect, it } from 'vitest';

import { useLocaleStore } from '../stores/locale.store';
import { useThemeStore } from '../stores/theme.store';
import { flush, mountStudio } from '../test/harness';

import LocaleSwitcher from './LocaleSwitcher.vue';
import ThemeSwitcher from './ThemeSwitcher.vue';

describe('LocaleSwitcher', () => {
  it('switches language and direction without a reload', async () => {
    const wrapper = await mountStudio(LocaleSwitcher, { locale: 'fa' });
    expect(document.documentElement.dir).toBe('rtl');

    await wrapper.find('select').setValue('en');
    await flush();

    expect(useLocaleStore().locale).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });

  it('ignores a value that is not a supported locale', async () => {
    const wrapper = await mountStudio(LocaleSwitcher, { locale: 'fa' });
    const select = wrapper.find('select').element as HTMLSelectElement;
    // A tampered option, which is all `localStorage` and the DOM can ever offer.
    const rogue = document.createElement('option');
    rogue.value = 'de';
    select.append(rogue);
    select.value = 'de';
    await wrapper.find('select').trigger('change');

    expect(useLocaleStore().locale).toBe('fa');
  });

  it('has an accessible name even though the label is visually hidden', async () => {
    const wrapper = await mountStudio(LocaleSwitcher, { locale: 'en' });
    expect(wrapper.find('label span.rv-visually-hidden').text()).toBe('Language');
  });
});

describe('ThemeSwitcher', () => {
  it('writes an explicit choice onto the document', async () => {
    const wrapper = await mountStudio(ThemeSwitcher, { locale: 'en' });
    await wrapper.find('select').setValue('dark');
    await flush();

    expect(useThemeStore().preference).toBe('dark');
    expect(useThemeStore().resolved).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('leaves the OS in charge when the choice is "system"', async () => {
    const wrapper = await mountStudio(ThemeSwitcher, { locale: 'en' });
    await wrapper.find('select').setValue('light');
    await flush();
    await wrapper.find('select').setValue('system');
    await flush();

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    // jsdom reports no dark preference, so "system" resolves to light here.
    expect(useThemeStore().resolved).toBe('light');
  });

  it('ignores a value that is not a known preference', async () => {
    const wrapper = await mountStudio(ThemeSwitcher, { locale: 'en' });
    const select = wrapper.find('select').element as HTMLSelectElement;
    const rogue = document.createElement('option');
    rogue.value = 'sepia';
    select.append(rogue);
    select.value = 'sepia';
    await wrapper.find('select').trigger('change');

    expect(useThemeStore().preference).toBe('system');
  });
});
