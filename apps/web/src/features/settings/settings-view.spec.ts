import { describe, expect, it } from 'vitest';

import { StudioApi } from '../../api/client';
import { FixtureTransport } from '../../api/fixtures/fixture-transport';
import type { StudioTransport } from '../../api/transport';
import { useLocaleStore } from '../../stores/locale.store';
import { useSettingsStore } from '../../stores/settings.store';
import { flush, mountStudio } from '../../test/harness';

import SettingsView from './SettingsView.vue';

const unreachable: StudioTransport = {
  kind: 'http',
  send: () => Promise.reject(new Error('offline')),
  eventSourceUrl: () => null,
};

describe('the settings screen’s states', () => {
  it('reports a load failure with a retry, instead of an empty form', async () => {
    const wrapper = await mountStudio(SettingsView, {
      locale: 'en',
      api: new StudioApi(unreachable),
    });
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.findAll('.rv-panel')).toHaveLength(0);

    const retry = wrapper.findAll('button').find((button) => button.text() === 'Try again');
    expect(retry).toBeDefined();
    await retry?.trigger('click');
    await flush();
    // Still unreachable, so still an alert - but the retry actually re-asked.
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });

  it('says so when a search matches nothing, rather than showing an empty page', async () => {
    const wrapper = await mountStudio(SettingsView, { locale: 'en' });
    await flush();
    await wrapper.vm.$nextTick();

    await wrapper.find('input[type="search"]').setValue('zzzz-no-such-setting');
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.rv-panel')).toHaveLength(0);
    expect(wrapper.text()).toContain('No setting matches that search');
  });

  it('groups settings into panels with translated headings', async () => {
    const wrapper = await mountStudio(SettingsView, { locale: 'en' });
    await flush();
    await wrapper.vm.$nextTick();

    const headings = wrapper.findAll('.rv-panel__heading').map((node) => node.text());
    expect(headings).toContain('Budget and cost ceilings');
    expect(headings).toContain('Per-stage model choice');
    // The two groups that replaced `style`, `ui` and `storage`.
    expect(headings).toContain('Appearance and language');
    expect(headings).toContain('Runtime and paths');

    // Every panel is labelled by its heading, so a screen reader can jump between them.
    for (const panel of wrapper.findAll('section.rv-panel')) {
      const labelled = panel.attributes('aria-labelledby');
      expect(labelled).toBeDefined();
      expect(wrapper.find(`#${labelled ?? ''}`).exists()).toBe(true);
    }
  });

  it('lets the environment warning be dismissed for this visit', async () => {
    const wrapper = await mountStudio(SettingsView, { locale: 'en' });
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.rv-settings__warnings').exists()).toBe(true);
    const close = wrapper
      .findAll('.rv-settings__warnings button')
      .find((button) => button.text() === 'Close');
    await close?.trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.rv-settings__warnings').exists()).toBe(false);
  });

  it('saves a change and shows the new provenance', async () => {
    const wrapper = await mountStudio(SettingsView, { locale: 'en' });
    await flush();
    await wrapper.vm.$nextTick();

    const row = '[data-setting-key="model.routingPolicy"]';
    expect(wrapper.find(row).text()).toContain('Default');

    // Index 0 is `cheapest`.
    await wrapper.find(`${row} select`).setValue('0');
    await wrapper.vm.$nextTick();

    const save = wrapper.findAll('button').find((button) => button.text() === 'Save all changes');
    await save?.trigger('click');
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.find(row).text()).toContain('Global');
    expect(wrapper.text()).not.toContain('unsaved change');
  });

  it('discards every pending change at once', async () => {
    const wrapper = await mountStudio(SettingsView, { locale: 'en' });
    await flush();
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-setting-key="model.pinStageOverrides"] input').setValue(false);
    await wrapper.find('[data-setting-key="render.concurrency"] input').setValue('9');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('2 unsaved changes');

    const discard = wrapper
      .findAll('.rv-settings__actions button')
      .find((button) => button.text() === 'Discard changes');
    await discard?.trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).not.toContain('unsaved change');
  });

  /**
   * Clearing falls back to the layer underneath, which is not always the default.
   *
   * `.env` sets a daily ceiling and the global layer overrides it; removing the global
   * override lands on the machine value. A chain that only ever fell back to `default`
   * would be a two-layer chain wearing a four-layer badge.
   */
  it('clears an override from the row and inherits from the layer below', async () => {
    const wrapper = await mountStudio(SettingsView, { locale: 'en' });
    await flush();
    await wrapper.vm.$nextTick();

    const row = '[data-setting-key="budget.perDayNanoUsd"]';
    expect(wrapper.find(row).text()).toContain('Global');

    const clear = wrapper
      .findAll(`${row} button`)
      .find((button) => button.text() === 'Clear override and inherit');
    expect(clear).toBeDefined();
    await clear?.trigger('click');
    await wrapper.vm.$nextTick();

    const save = wrapper.findAll('button').find((button) => button.text() === 'Save all changes');
    await save?.trigger('click');
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.find(row).text()).toContain('Machine');
  });

  it('reloads the registry when the language changes, so labels are filtered in the new one', async () => {
    const wrapper = await mountStudio(SettingsView, { locale: 'en' });
    await flush();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Budget and cost ceilings');

    useLocaleStore().setLocale('fa');
    await flush();
    await wrapper.vm.$nextTick();
    await flush();
    await wrapper.vm.$nextTick();

    expect(useSettingsStore().status).toBe('ready');
    expect(wrapper.text()).toContain('بودجه');
  });

  it('shows a restart warning on the settings that need one', async () => {
    const wrapper = await mountStudio(SettingsView, { locale: 'en' });
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-setting-key="runtime.apiPort"]').text()).toContain(
      'Needs a restart',
    );
    expect(wrapper.find('[data-setting-key="model.routingPolicy"]').text()).not.toContain(
      'Needs a restart',
    );
  });

  it('hides a setting whose dependency is unmet and reveals it when it is met', async () => {
    const wrapper = await mountStudio(SettingsView, {
      locale: 'en',
      api: new StudioApi(new FixtureTransport()),
    });
    await flush();
    await wrapper.vm.$nextTick();

    // The lane defaults to local ComfyUI, so every ComfyUI row is relevant.
    expect(wrapper.find('[data-setting-key="image.comfyui.host"]').exists()).toBe(true);
    expect(wrapper.find('[data-setting-key="image.comfyui.authToken"]').exists()).toBe(true);

    // Index 2 in the lane's options is `cloud-api`, where none of them mean anything.
    await wrapper.find('[data-setting-key="image.lane"] select').setValue('2');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-setting-key="image.comfyui.host"]').exists()).toBe(false);
    expect(wrapper.find('[data-setting-key="image.comfyui.authToken"]').exists()).toBe(false);
  });
});
