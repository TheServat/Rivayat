import { describe, expect, it } from 'vitest';

import { MODEL_CHOICES, SETTING_DESCRIPTORS } from '../../../api/fixtures/settings.fixture';
import type { SettingDescriptorMeta } from '../../../api/schemas/settings';
import { mountStudio } from '../../../test/harness';

import JsonControl from './JsonControl.vue';
import ModelPickerControl from './ModelPickerControl.vue';
import MoneyControl from './MoneyControl.vue';
import MultiSelectControl from './MultiSelectControl.vue';
import NumberControl from './NumberControl.vue';
import SecretControl from './SecretControl.vue';
import SelectControl from './SelectControl.vue';
import SliderControl from './SliderControl.vue';
import TextControl from './TextControl.vue';
import ToggleControl from './ToggleControl.vue';
import UrlControl from './UrlControl.vue';

function descriptorFor(key: string): SettingDescriptorMeta {
  const found = SETTING_DESCRIPTORS.find((descriptor) => descriptor.key === key);
  if (found === undefined) throw new Error(`the registry declares no ${key}`);
  return found;
}

/** A non-secret resolved value, which is what every control but `secret` receives. */
function props(key: string, draft: unknown, overrides: Record<string, unknown> = {}) {
  return {
    descriptor: descriptorFor(key),
    value: {
      key,
      origin: 'default' as const,
      shadowed: [],
      ignored: [],
      secret: false as const,
      value: draft,
    },
    draft,
    invalid: false,
    readonly: false,
    inputId: 'control-under-test',
    describedBy: 'control-help',
    models: MODEL_CHOICES,
    ...overrides,
  };
}

/** The secret branch of the union: a `set` bit and nowhere to put a value. */
function secretProps(key: string, set: boolean, draft: unknown = undefined) {
  return props(key, draft, {
    value: { key, origin: 'machine', shadowed: [], ignored: [], secret: true, set },
  });
}

describe('ToggleControl', () => {
  it('emits the new boolean, not a string', async () => {
    const wrapper = await mountStudio(ToggleControl, {
      locale: 'en',
      props: props('model.pinStageOverrides', true),
    });
    await wrapper.find('input').setValue(false);
    expect(wrapper.emitted('change')).toEqual([[false]]);
  });

  it('reads its state out loud for a screen reader', async () => {
    const wrapper = await mountStudio(ToggleControl, {
      locale: 'en',
      props: props('model.pinStageOverrides', false),
    });
    expect(wrapper.text()).toBe('Off');
  });
});

describe('SelectControl', () => {
  it('emits the option’s own value rather than the stringified one', async () => {
    const wrapper = await mountStudio(SelectControl, {
      locale: 'en',
      props: props('model.routingPolicy', 'balanced'),
    });
    // Options are addressed by index; index 0 is `cheapest`.
    await wrapper.find('select').setValue('0');
    expect(wrapper.emitted('change')).toEqual([['cheapest']]);
  });

  it('shows a placeholder when the current value is not one of the options', async () => {
    const wrapper = await mountStudio(SelectControl, {
      locale: 'en',
      props: props('model.routingPolicy', 'a-value-nobody-declared'),
    });
    expect(wrapper.find('option[disabled]').exists()).toBe(true);
    expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('');
  });

  it('localises option labels', async () => {
    const wrapper = await mountStudio(SelectControl, {
      locale: 'fa',
      props: props('model.routingPolicy', 'balanced'),
    });
    expect(wrapper.text()).toContain('متعادل');
  });
});

describe('MultiSelectControl', () => {
  it('renders a checkbox per declared option, not a select', async () => {
    const wrapper = await mountStudio(MultiSelectControl, {
      locale: 'en',
      props: props('delivery.formats', ['yt-1080p']),
    });
    const declared = descriptorFor('delivery.formats').options ?? [];
    expect(declared.length).toBeGreaterThan(1);
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(declared.length);
    expect(wrapper.find('select').exists()).toBe(false);
  });

  /**
   * The property that makes the value comparable.
   *
   * Emitting in click order would make `[a, b]` and `[b, a]` different values for the
   * same choice, so every reload would look like an unsaved change.
   */
  it('emits the option values in declaration order, whatever the click order', async () => {
    const declared = (descriptorFor('delivery.formats').options ?? []).map(
      (option) => option.value,
    );
    const [first, second, third] = declared;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();

    const wrapper = await mountStudio(MultiSelectControl, {
      locale: 'en',
      props: props('delivery.formats', [third, first]),
    });
    // Tick the second box while the draft holds the third and the first.
    await wrapper.findAll('input[type="checkbox"]')[1]?.setValue(true);

    expect(wrapper.emitted('change')).toEqual([[[first, second, third]]]);
  });

  it('removes an option when it is unticked', async () => {
    const declared = (descriptorFor('delivery.formats').options ?? []).map(
      (option) => option.value,
    );
    const [first, second] = declared;
    const wrapper = await mountStudio(MultiSelectControl, {
      locale: 'en',
      props: props('delivery.formats', [first, second]),
    });
    await wrapper.findAll('input[type="checkbox"]')[0]?.setValue(false);
    expect(wrapper.emitted('change')).toEqual([[[second]]]);
  });

  it('says so when the selection is below the declared minimum', async () => {
    const wrapper = await mountStudio(MultiSelectControl, {
      locale: 'en',
      props: props('delivery.formats', []),
    });
    expect(wrapper.text()).toContain('At least');
  });

  it('stops ticking more once the declared maximum is reached', async () => {
    const descriptor = descriptorFor('delivery.formats');
    const declared = (descriptor.options ?? []).map((option) => option.value);
    const wrapper = await mountStudio(MultiSelectControl, {
      locale: 'en',
      props: props('delivery.formats', [declared[0]], {
        descriptor: { ...descriptor, control: { kind: 'multi-select', maxSelected: 1 } },
      }),
    });
    const boxes = wrapper.findAll('input[type="checkbox"]');
    expect(boxes[0]?.attributes('disabled')).toBeUndefined();
    expect(boxes[1]?.attributes('disabled')).toBeDefined();
  });
});

describe('NumberControl', () => {
  it('keeps the input in ASCII and echoes Persian digits beside it', async () => {
    const wrapper = await mountStudio(NumberControl, {
      locale: 'fa',
      props: props('runtime.apiPort', 3000),
    });
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('3000');
    expect(wrapper.find('output').text()).toBe('۳٬۰۰۰');
  });

  it('does not echo in English, where the input already reads correctly', async () => {
    const wrapper = await mountStudio(NumberControl, {
      locale: 'en',
      props: props('runtime.apiPort', 3000),
    });
    expect(wrapper.find('output').exists()).toBe(false);
  });

  it('reads its bounds off the control, not off a separate constraints bag', async () => {
    const wrapper = await mountStudio(NumberControl, {
      locale: 'en',
      props: props('runtime.apiPort', 3000),
    });
    const input = wrapper.find('input');
    expect(input.attributes('min')).toBe('1');
    expect(input.attributes('max')).toBe('65535');
  });

  it('emits null for an empty field rather than zero', async () => {
    const wrapper = await mountStudio(NumberControl, {
      locale: 'en',
      props: props('runtime.apiPort', 3000),
    });
    await wrapper.find('input').setValue('');
    expect(wrapper.emitted('change')).toEqual([[null]]);
  });

  it('emits a number, never the typed string', async () => {
    const wrapper = await mountStudio(NumberControl, {
      locale: 'en',
      props: props('runtime.apiPort', 3000),
    });
    await wrapper.find('input').setValue('3100');
    expect(wrapper.emitted('change')).toEqual([[3100]]);
  });
});

describe('SliderControl', () => {
  it('takes its range from the control’s own required hints', async () => {
    const wrapper = await mountStudio(SliderControl, {
      locale: 'en',
      props: props('render.concurrency', 4),
    });
    const input = wrapper.find('input');
    expect(input.attributes('min')).toBe('1');
    expect(input.attributes('max')).toBe('16');
    expect(input.attributes('step')).toBe('1');
    // A step of 1 wants no fraction digits.
    expect(input.attributes('aria-valuetext')).toBe('4');
  });

  it('emits a number on input', async () => {
    const wrapper = await mountStudio(SliderControl, {
      locale: 'en',
      props: props('render.concurrency', 4),
    });
    await wrapper.find('input').setValue('9');
    expect(wrapper.emitted('change')).toEqual([[9]]);
  });
});

describe('TextControl', () => {
  it('renders a single-line field with the declared placeholder', async () => {
    const wrapper = await mountStudio(TextControl, {
      locale: 'en',
      props: props('runtime.workspaceDir', './workspace'),
    });
    const input = wrapper.find('input[type="text"]');
    expect(input.exists()).toBe(true);
    expect(input.attributes('placeholder')).toBe('./workspace');
    await input.setValue('./elsewhere');
    expect(wrapper.emitted('change')).toEqual([['./elsewhere']]);
  });

  it('renders a textarea when the declaration asks for one', async () => {
    const descriptor = descriptorFor('runtime.workspaceDir');
    const wrapper = await mountStudio(TextControl, {
      locale: 'en',
      props: props('runtime.workspaceDir', 'line one\nline two', {
        descriptor: { ...descriptor, control: { kind: 'text', multiline: true } },
      }),
    });
    expect(wrapper.find('textarea').exists()).toBe(true);
    await wrapper.find('textarea').setValue('changed');
    expect(wrapper.emitted('change')).toEqual([['changed']]);
  });

  it('renders an empty field for a value that is not a string yet', async () => {
    const wrapper = await mountStudio(TextControl, {
      locale: 'en',
      props: props('runtime.workspaceDir', undefined),
    });
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
  });
});

describe('UrlControl', () => {
  it('emits the typed string and keeps the field left-to-right', async () => {
    const wrapper = await mountStudio(UrlControl, {
      locale: 'fa',
      props: props('provider.ollama.host', 'http://127.0.0.1:11434'),
    });
    // A URL reads left-to-right even on a right-to-left page.
    expect(wrapper.find('input').attributes('dir')).toBe('ltr');
    await wrapper.find('input').setValue('http://elsewhere:11434');
    expect(wrapper.emitted('change')).toEqual([['http://elsewhere:11434']]);
  });
});

describe('MoneyControl', () => {
  /**
   * Nano-dollars in, dollars on screen, nano-dollars out.
   *
   * The storage unit must not leak into the form: someone typing `5` means five
   * dollars, and every place that decides for itself how many zeroes that is becomes a
   * place it can be wrong.
   */
  it('shows integer nano-dollars as dollars and emits nano-dollars back', async () => {
    const wrapper = await mountStudio(MoneyControl, {
      locale: 'en',
      props: props('budget.perRunNanoUsd', 2_500_000_000),
    });
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('2.5');
    expect(wrapper.find('output').text()).toBe('$2.50');

    await wrapper.find('input').setValue('7.25');
    expect(wrapper.emitted('change')).toEqual([[7_250_000_000]]);
  });

  it('converts the declared step and floor into dollars too', async () => {
    const wrapper = await mountStudio(MoneyControl, {
      locale: 'en',
      props: props('budget.perRunNanoUsd', 2_500_000_000),
    });
    const input = wrapper.find('input');
    // 10_000_000 nano-dollars is one cent.
    expect(input.attributes('step')).toBe('0.01');
    expect(input.attributes('min')).toBe('0');
  });

  it('localises only the digits, never the currency', async () => {
    const wrapper = await mountStudio(MoneyControl, {
      locale: 'fa',
      props: props('budget.perRunNanoUsd', 2_500_000_000),
    });
    expect(wrapper.find('output').text()).toMatch(/[۰-۹]/);
  });

  it('emits null when cleared, and says the ceiling is gone', async () => {
    const wrapper = await mountStudio(MoneyControl, {
      locale: 'en',
      props: props('budget.perRunNanoUsd', 2_500_000_000),
    });
    await wrapper.find('input').setValue('');
    expect(wrapper.emitted('change')).toEqual([[null]]);

    const empty = await mountStudio(MoneyControl, {
      locale: 'en',
      props: props('budget.perRunNanoUsd', null),
    });
    expect((empty.find('input').element as HTMLInputElement).value).toBe('');
    expect(empty.text()).toContain('No ceiling');
  });
});

describe('SecretControl', () => {
  it('starts empty even when a secret is set on the server', async () => {
    const wrapper = await mountStudio(SecretControl, {
      locale: 'en',
      props: secretProps('provider.openrouter.apiKey', true),
    });
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
    expect(wrapper.text()).toContain('Set');
    expect(wrapper.find('input').attributes('type')).toBe('password');
  });

  it('reports an absent secret as absent', async () => {
    const wrapper = await mountStudio(SecretControl, {
      locale: 'en',
      props: secretProps('provider.gemini.apiKey', false),
    });
    expect(wrapper.text()).toContain('Not set');
  });

  it('emits the replacement the user typed', async () => {
    const wrapper = await mountStudio(SecretControl, {
      locale: 'en',
      props: secretProps('provider.gemini.apiKey', false),
    });
    await wrapper.find('input').setValue('a-brand-new-key');
    expect(wrapper.emitted('change')).toEqual([['a-brand-new-key']]);
  });
});

describe('ModelPickerControl', () => {
  it('offers only models with the declared capability, grouped by provider', async () => {
    const wrapper = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('model.stage.story', 'ollama:qwen3.5:latest'),
    });
    // `model.stage.story` wants structured generation, so no image-only model belongs.
    expect(wrapper.text()).not.toContain('Gemini 3 Pro Image');
    expect(wrapper.text()).toContain('Qwen 3.5 (local)');
    expect(wrapper.findAll('optgroup').length).toBeGreaterThan(1);
  });

  it('offers only the declared providers', async () => {
    const wrapper = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('provider.ollama.textModel', 'qwen3.5:latest'),
    });
    const groups = wrapper.findAll('optgroup').map((node) => node.attributes('label'));
    expect(groups).toEqual(['ollama']);
  });

  it('shows the price summary beside each model', async () => {
    const wrapper = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('model.stage.produce', null),
    });
    // The paid image models carry their real per-image estimate.
    expect(wrapper.text()).toContain('/image');
  });

  /**
   * Two spellings, one control, and guessing wrong is silent.
   *
   * A per-stage slot stores `provider:model`; a provider's own role slot stores the
   * bare id, because it is already scoped to one provider. `ProviderModelId` is only a
   * bounded string, so a qualified reference stored in one would validate and then name
   * a model no adapter can find.
   */
  it('emits a qualified reference for a multi-provider slot', async () => {
    const wrapper = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('model.stage.story', null),
    });
    await wrapper.find('select').setValue('0');
    expect(String(wrapper.emitted('change')?.[0]?.[0])).toMatch(/^ollama:/);
  });

  it('emits a bare provider-native id for a single-provider slot', async () => {
    const wrapper = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('provider.ollama.textModel', 'qwen3.5:latest'),
    });
    await wrapper.find('select').setValue('1');
    const emitted = String(wrapper.emitted('change')?.[0]?.[0]);
    expect(emitted).toBe('gemma4:26b');
    expect(emitted).not.toContain('ollama:');
  });

  it('offers "let the router decide" only where null is a legal answer', async () => {
    const nullable = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('model.stage.story', null),
    });
    expect(nullable.text()).toContain('Let the router choose');
    expect((nullable.find('select').element as HTMLSelectElement).value).toBe('null');

    const required = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('provider.ollama.textModel', 'qwen3.5:latest'),
    });
    expect(required.text()).not.toContain('Let the router choose');
  });

  it('emits null when the router option is chosen', async () => {
    const wrapper = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('model.stage.story', 'ollama:qwen3.5:latest'),
    });
    await wrapper.find('select').setValue('null');
    expect(wrapper.emitted('change')).toEqual([[null]]);
  });

  it('marks a free model as free and shows the stored reference', async () => {
    const wrapper = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('model.stage.story', 'ollama:qwen3.5:latest'),
    });
    expect(wrapper.text()).toContain('Free');
    expect(wrapper.text()).toContain('ollama:qwen3.5:latest');
  });

  it('keeps a value the catalogue does not offer reachable through the custom field', async () => {
    const wrapper = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('provider.ollama.textModel', 'a-model-i-pulled-locally'),
    });
    const custom = wrapper.find('.rv-model__input');
    expect((custom.element as HTMLInputElement).value).toBe('a-model-i-pulled-locally');
    await custom.setValue('another:tag');
    expect(wrapper.emitted('change')).toEqual([['another:tag']]);
  });

  it('says so rather than showing an empty list when the catalogue offers nothing', async () => {
    // Google publishes image models; `KNOWN_MODELS` carries none under the `gemini`
    // provider, so this slot genuinely has no catalogue entry to offer.
    const wrapper = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('provider.gemini.imageModel', 'gemini-3.1-flash-lite-image'),
    });
    expect(wrapper.findAll('optgroup')).toHaveLength(0);
    expect(wrapper.text()).toContain('no model for this slot');
  });

  it('ignores a change that names nothing real', async () => {
    const wrapper = await mountStudio(ModelPickerControl, {
      locale: 'en',
      props: props('model.stage.story', 'ollama:qwen3.5:latest'),
    });
    const select = wrapper.find('select');
    const rogue = document.createElement('option');
    rogue.value = 'nonesuch';
    (select.element as HTMLSelectElement).append(rogue);
    (select.element as HTMLSelectElement).value = 'nonesuch';
    await select.trigger('change');
    expect(wrapper.emitted('change')).toBeUndefined();
  });
});

describe('JsonControl', () => {
  // Nothing in the registry declares a `json` control today, so the component is
  // exercised against a synthesised declaration - which is the honest way to keep a
  // renderer for a kind the union still allows.
  const jsonDescriptor = (): SettingDescriptorMeta => ({
    ...descriptorFor('runtime.workspaceDir'),
    control: { kind: 'json' },
  });

  it('pretty-prints the current value', async () => {
    const wrapper = await mountStudio(JsonControl, {
      locale: 'en',
      props: props('runtime.workspaceDir', ['yt-1080p', 'shorts-9x16'], {
        descriptor: jsonDescriptor(),
      }),
    });
    // `.value`, not `.text()`: a bound textarea holds its content as a DOM property.
    const field = wrapper.find('textarea').element as HTMLTextAreaElement;
    expect(field.value).toBe('[\n  "yt-1080p",\n  "shorts-9x16"\n]');
  });

  it('emits the parsed value once the text is valid JSON', async () => {
    const wrapper = await mountStudio(JsonControl, {
      locale: 'en',
      props: props('runtime.workspaceDir', ['yt-1080p'], { descriptor: jsonDescriptor() }),
    });
    await wrapper.find('textarea').setValue('["reels-9x16"]');
    expect(wrapper.emitted('change')).toEqual([[['reels-9x16']]]);
  });

  it('shows a parse error and emits nothing while the text is half-typed', async () => {
    const wrapper = await mountStudio(JsonControl, {
      locale: 'en',
      props: props('runtime.workspaceDir', ['yt-1080p'], { descriptor: jsonDescriptor() }),
    });
    await wrapper.find('textarea').setValue('["reels-9x16"');

    expect(wrapper.emitted('change')).toBeUndefined();
    expect(wrapper.find('.rv-json__error').text()).toContain('not valid JSON');
    expect(wrapper.find('textarea').attributes('aria-invalid')).toBe('true');
  });

  it('re-serialises when the value changes from outside, such as a discard', async () => {
    const wrapper = await mountStudio(JsonControl, {
      locale: 'en',
      props: props('runtime.workspaceDir', ['yt-1080p'], { descriptor: jsonDescriptor() }),
    });
    await wrapper.setProps({ draft: ['ig-1x1'] });
    await wrapper.vm.$nextTick();
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(
      '[\n  "ig-1x1"\n]',
    );
  });

  it('leaves the text alone when the incoming value is what the text already means', async () => {
    const wrapper = await mountStudio(JsonControl, {
      locale: 'en',
      props: props('runtime.workspaceDir', ['yt-1080p'], { descriptor: jsonDescriptor() }),
    });
    await wrapper.find('textarea').setValue('["yt-1080p"]');
    await wrapper.setProps({ draft: ['yt-1080p'] });
    await wrapper.vm.$nextTick();
    // Not reformatted under the user's cursor.
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('["yt-1080p"]');
  });
});

describe('every control marks itself invalid and points at its help text', () => {
  const cases = [
    [ToggleControl, 'model.pinStageOverrides', true],
    [SelectControl, 'model.routingPolicy', 'balanced'],
    [MultiSelectControl, 'delivery.formats', ['yt-1080p']],
    [NumberControl, 'runtime.apiPort', 3000],
    [SliderControl, 'render.concurrency', 4],
    [TextControl, 'runtime.workspaceDir', './workspace'],
    [UrlControl, 'provider.ollama.host', 'http://127.0.0.1:11434'],
    [MoneyControl, 'budget.perRunNanoUsd', 2_500_000_000],
    [SecretControl, 'provider.gemini.apiKey', ''],
    [ModelPickerControl, 'model.stage.story', 'ollama:qwen3.5:latest'],
  ] as const;

  for (const [component, key, draft] of cases) {
    it(`does so for ${key}`, async () => {
      const wrapper = await mountStudio(component, {
        locale: 'en',
        props: { ...props(key, draft), invalid: true },
      });
      const field = wrapper.find('#control-under-test');
      expect(field.exists()).toBe(true);
      expect(field.attributes('aria-invalid')).toBe('true');
      expect(field.attributes('aria-describedby')).toContain('control-help');
    });
  }
});

describe('a read-only row still shows its value', () => {
  /**
   * Disabled where the platform offers nothing else, `readonly` where it does.
   *
   * Hiding a machine-scope row would break 7b's "every option is configurable from the
   * UI" in the least detectable way; what a reader needs is the value plus the name of
   * the `.env` variable that holds it, which the row supplies.
   */
  const cases = [
    [UrlControl, 'provider.ollama.host', 'http://127.0.0.1:11434', 'readonly'],
    [TextControl, 'runtime.workspaceDir', './workspace', 'readonly'],
    [NumberControl, 'runtime.apiPort', 3000, 'readonly'],
    [SecretControl, 'provider.gemini.apiKey', '', 'readonly'],
    [SelectControl, 'runtime.logLevel', 'debug', 'disabled'],
    [SliderControl, 'runtime.queueConcurrency', 4, 'disabled'],
    [ToggleControl, 'image.comfyui.enabled', true, 'disabled'],
  ] as const;

  for (const [component, key, draft, attribute] of cases) {
    it(`blocks editing ${key} with ${attribute}`, async () => {
      const wrapper = await mountStudio(component, {
        locale: 'en',
        props: { ...props(key, draft), readonly: true },
      });
      const field = wrapper.find('#control-under-test');
      expect(field.attributes(attribute)).toBeDefined();
    });
  }
});
