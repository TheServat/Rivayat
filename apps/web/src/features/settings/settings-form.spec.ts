import { describe, expect, it } from 'vitest';

import { SETTING_LAYER_VALUES } from '../../api/fixtures/settings.fixture';
import { SETTINGS_REGISTRY, isWritableAt } from '../../api/schemas/settings';
import { flush, mountStudio } from '../../test/harness';

import {
  RENDERABLE_CONTROLS,
  SETTING_CONTROL_COMPONENTS,
  type SettingControlKind,
} from './controls/index';
import SettingsView from './SettingsView.vue';

/** The selector each control kind renders, so the test asserts the real element. */
const EXPECTED_ELEMENT: Readonly<Record<SettingControlKind, string>> = {
  toggle: 'input[type="checkbox"]',
  select: 'select',
  'multi-select': 'input[type="checkbox"]',
  number: 'input[type="number"]',
  slider: 'input[type="range"]',
  text: 'input[type="text"], textarea',
  secret: 'input[type="password"]',
  url: 'input[type="url"]',
  money: 'input[type="number"]',
  'model-picker': 'select',
  json: 'textarea',
};

/** The kinds the registry actually declares today. Derived, never listed. */
const DECLARED_KINDS = [
  ...new Set(SETTINGS_REGISTRY.map((descriptor) => descriptor.control.kind)),
].toSorted();

function rowFor(html: Element, key: string): Element {
  const row = html.querySelector(`[data-setting-key="${key}"]`);
  if (row === null) throw new Error(`no row rendered for ${key}`);
  return row;
}

async function renderSettings(locale: 'fa' | 'en' = 'en'): Promise<Element> {
  const wrapper = await mountStudio(SettingsView, { locale });
  await flush();
  await wrapper.vm.$nextTick();
  return wrapper.element as Element;
}

describe('the settings form is generated from the registry', () => {
  it('has a component for every control kind the union allows', () => {
    // Wider than "every kind the registry uses": a kind with no component would be a
    // blank row the day a setting starts using it, and the union is the real contract.
    for (const control of RENDERABLE_CONTROLS) {
      expect(SETTING_CONTROL_COMPONENTS[control], control).toBeDefined();
    }
  });

  /**
   * Every declared setting reaches the screen, with the input its control implies.
   *
   * The set of kinds exercised is derived from `SETTINGS_REGISTRY`, not from a list
   * written here: a registry that gains an eleventh kind must make this fail rather
   * than pass on the ten it already covered.
   */
  it('renders the right control element for every setting in the registry', async () => {
    const root = await renderSettings();
    const seen = new Set<SettingControlKind>();

    for (const descriptor of SETTINGS_REGISTRY) {
      const row = root.querySelector(`[data-setting-key="${descriptor.key}"]`);
      expect(row, `${descriptor.key} rendered no row`).not.toBeNull();
      if (row === null) continue;
      seen.add(descriptor.control.kind);
      expect(
        row.querySelector(EXPECTED_ELEMENT[descriptor.control.kind]),
        `${descriptor.key} (${descriptor.control.kind})`,
      ).not.toBeNull();
    }

    expect([...seen].toSorted()).toEqual(DECLARED_KINDS);
  });

  it('labels every control, so each row is reachable and announced', async () => {
    const root = await renderSettings();

    const labels = [...root.querySelectorAll('label.rv-row__label')];
    expect(labels).toHaveLength(SETTINGS_REGISTRY.length);
    for (const label of labels) {
      // Ids are built by replacing the key's dots with dashes precisely so a selector
      // built from one addresses an element rather than a class.
      const target = label.getAttribute('for') ?? '';
      expect(target, 'a row label with no target').not.toBe('');
      expect(root.querySelector(`#${target}`), target).not.toBeNull();
    }
  });
});

describe('provenance on the row', () => {
  it('shows which layer each value came from', async () => {
    const root = await renderSettings();

    // Set in the global layer, which is the layer this view writes to.
    expect(rowFor(root, 'model.qualityTier').textContent).toContain('Global');
    // Set in `.env` and overridden globally: the winner is named, the loser explained.
    expect(rowFor(root, 'budget.perDayNanoUsd').textContent).toContain('Global');
    // Set in `.env` only.
    expect(rowFor(root, 'render.concurrency').textContent).toContain('Machine');
    // Set nowhere in this stack: the built-in default.
    expect(rowFor(root, 'model.routingPolicy').textContent).toContain('Default');
  });

  it('names the layer being edited, so "set here" can be read', async () => {
    const root = await renderSettings();
    expect(root.textContent).toContain('Editing the Global layer');
  });

  it('offers to clear an override only where one exists', async () => {
    const root = await renderSettings();

    expect(rowFor(root, 'model.qualityTier').textContent).toContain('Clear override');
    expect(rowFor(root, 'model.routingPolicy').textContent).not.toContain('Clear override');
  });

  it('says when a layer stores a value the schema refused', async () => {
    const root = await renderSettings();
    const backend = rowFor(root, 'render.backend').textContent;
    expect(backend).toContain('invalid value');
    // And it still renders the value that is actually in force.
    expect(backend).toContain('Default');
  });

  it('reports an unknown environment variable instead of ignoring it', async () => {
    const root = await renderSettings();
    expect(root.textContent).toContain('Environment file warnings');
    expect(root.textContent).toContain('RV_BUDGET_USD_PER_WEEK');
  });
});

describe('rows this layer cannot write', () => {
  /**
   * Read-only, never hidden.
   *
   * Architecture 7b promises every option is visible. `.env` is not writable through
   * the API, so a machine-scope row is shown with the one actionable thing its reader
   * needs: the name of the variable that holds it.
   */
  it('marks every machine-scope setting read-only and names its .env variable', async () => {
    const root = await renderSettings();
    const machineOnly = SETTINGS_REGISTRY.filter(
      (descriptor) => !isWritableAt(descriptor, 'global'),
    );
    expect(machineOnly.length).toBeGreaterThan(0);

    for (const descriptor of machineOnly) {
      const text = rowFor(root, descriptor.key).textContent;
      expect(text, descriptor.key).toContain('Read-only');
      if (descriptor.env !== undefined) {
        expect(text, descriptor.key).toContain(descriptor.env.name);
      }
    }
  });

  it('leaves a writable row unmarked', async () => {
    const root = await renderSettings();
    expect(rowFor(root, 'model.qualityTier').textContent).not.toContain('Read-only');
  });
});

describe('secrets', () => {
  it('never renders a secret’s value anywhere in the document', async () => {
    // The fixture's machine layer really does hold this value; the point of the test is
    // that it never crosses the boundary.
    const stored = SETTING_LAYER_VALUES.machine['provider.openrouter.apiKey'];
    expect(typeof stored).toBe('string');

    const root = await renderSettings();
    expect(root.innerHTML).not.toContain(String(stored));

    const row = rowFor(root, 'provider.openrouter.apiKey');
    const field = row.querySelector('input[type="password"]');
    expect(field).not.toBeNull();
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('reports a secret as present or absent, which is all the API sends', async () => {
    const root = await renderSettings();
    expect(rowFor(root, 'provider.openrouter.apiKey').textContent).toContain('Set');
    // Blank in `.env` is not "set".
    expect(rowFor(root, 'provider.gemini.apiKey').textContent).toContain('Not set');
  });
});

describe('editing', () => {
  it('marks a row dirty and enables saving when a control emits a change', async () => {
    const wrapper = await mountStudio(SettingsView, { locale: 'en' });
    await flush();
    await wrapper.vm.$nextTick();

    const toggle = wrapper.find(
      '[data-setting-key="model.pinStageOverrides"] input[type="checkbox"]',
    );
    expect(toggle.exists()).toBe(true);
    await toggle.setValue(false);

    expect(wrapper.text()).toContain('One unsaved change');
    const save = wrapper.findAll('button').find((button) => button.text() === 'Save all changes');
    expect(save?.attributes('disabled')).toBeUndefined();
  });

  it('blocks saving and explains why when a value fails its schema', async () => {
    const wrapper = await mountStudio(SettingsView, { locale: 'en' });
    await flush();
    await wrapper.vm.$nextTick();

    const port = wrapper.find('[data-setting-key="runtime.apiPort"] input[type="number"]');
    // The row is read-only, so it cannot be the one to test with - use a writable
    // number instead and prove the read-only one really is inert.
    expect(port.attributes('readonly')).toBeDefined();

    const money = wrapper.find('[data-setting-key="budget.perRunNanoUsd"] input[type="number"]');
    await money.setValue('-5');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-setting-key="budget.perRunNanoUsd"] .rv-row__error').exists()).toBe(
      true,
    );
    const save = wrapper.findAll('button').find((button) => button.text() === 'Save all changes');
    expect(save?.attributes('disabled')).toBeDefined();
  });
});
