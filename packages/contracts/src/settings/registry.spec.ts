/**
 * The registry's own invariants.
 *
 * Most of these are not tests of behaviour - they are the checks that make the registry
 * safe to generate a UI from. A declaration whose default fails its own schema, an
 * option list that disagrees with the schema behind it, or a `dependsOn` pointing at a
 * key that no longer exists all produce a settings screen that looks fine and is wrong,
 * which is precisely the drift architecture 7b exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { KNOWN_MODELS, PipelineStageKey } from '../provider/capability';
import { FORMAT_PRESETS } from '../render/format';
import {
  type AnySettingDescriptor,
  SettingDescriptorMeta,
  SettingGroup,
  closedChoiceValues,
  defaultIsValid,
  isWritableAt,
} from './descriptor';
import {
  SETTINGS,
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  isSettingKey,
  settingFor,
  settingsInGroup,
} from './registry';

/**
 * The values a schema accepts, when it is an enum or an array of one.
 *
 * Reaching into the schema is exactly what the UI must never do - which is why the
 * descriptor carries an explicit `control` - but a *test* is the one place it is
 * legitimate: this is how the two are held to agree.
 */
function acceptedEnumValues(schema: z.ZodType<unknown>): readonly unknown[] | null {
  if (schema instanceof z.ZodEnum) return schema.options;
  if (schema instanceof z.ZodArray) {
    const element: unknown = schema.element;
    if (element instanceof z.ZodEnum) return element.options;
  }
  return null;
}

describe('the registry is internally consistent', () => {
  it('gives every entry a key that matches the slot it is declared in', () => {
    const mismatched = Object.entries(SETTINGS)
      .filter(([slot, descriptor]) => slot !== descriptor.key)
      .map(([slot]) => slot);

    expect(mismatched).toEqual([]);
  });

  it('has no duplicate keys', () => {
    const keys = SETTINGS_REGISTRY.map((descriptor) => descriptor.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('exposes the same key list the descriptors carry', () => {
    expect([...SETTING_KEYS]).toEqual(SETTINGS_REGISTRY.map((descriptor) => descriptor.key));
  });

  it('declares something', () => {
    // A guard against the whole suite passing vacuously if the record were emptied.
    expect(SETTINGS_REGISTRY.length).toBeGreaterThan(40);
  });

  it('parses every declaration through the schema the API will validate it with', () => {
    const invalid = SETTINGS_REGISTRY.filter(
      (descriptor) => !SettingDescriptorMeta.safeParse(stripSchema(descriptor)).success,
    ).map((descriptor) => descriptor.key);

    expect(invalid).toEqual([]);
  });
});

describe('every default is honest', () => {
  it('validates against its own schema', () => {
    // A default that fails its own schema survives every path that never writes the
    // setting, and detonates the first time someone saves the form unchanged.
    const broken = SETTINGS_REGISTRY.filter((descriptor) => !defaultIsValid(descriptor)).map(
      (descriptor) => descriptor.key,
    );

    expect(broken).toEqual([]);
  });
});

describe('every closed choice agrees with its schema', () => {
  it('offers exactly the values the schema accepts, no more and no fewer', () => {
    const disagreeing: string[] = [];

    for (const descriptor of SETTINGS_REGISTRY) {
      const offered = closedChoiceValues(descriptor);
      if (offered === null) continue;

      const accepted = acceptedEnumValues(descriptor.schema);
      if (accepted === null || [...offered].sort().join() !== [...accepted].sort().join()) {
        disagreeing.push(descriptor.key);
      }
    }

    expect(disagreeing).toEqual([]);
  });

  it('leaves no closed control without options', () => {
    const empty = SETTINGS_REGISTRY.filter((descriptor) => {
      const offered = closedChoiceValues(descriptor);
      return offered !== null && offered.length === 0;
    }).map((descriptor) => descriptor.key);

    expect(empty).toEqual([]);
  });

  it('gives every option a Persian label', () => {
    const unlabelled = SETTINGS_REGISTRY.flatMap((descriptor) =>
      (descriptor.options ?? [])
        .filter((option) => option.label.fa.trim().length === 0)
        .map(() => descriptor.key),
    );

    expect(unlabelled).toEqual([]);
  });
});

describe('every dependency points somewhere', () => {
  it('names a key that exists', () => {
    const dangling = SETTINGS_REGISTRY.flatMap((descriptor) =>
      descriptor.dependsOn
        .filter((dependency) => !isSettingKey(dependency.key))
        .map((dependency) => `${descriptor.key} -> ${dependency.key}`),
    );

    expect(dangling).toEqual([]);
  });

  it('compares against values the referenced setting can actually hold', () => {
    // A condition on `image.lane === 'gpu'` renders the field it guards permanently
    // invisible, and nothing else in the system would ever say so.
    const impossible: string[] = [];

    for (const descriptor of SETTINGS_REGISTRY) {
      for (const dependency of descriptor.dependsOn) {
        if (!isSettingKey(dependency.key)) continue;
        const target = settingFor(dependency.key);
        for (const candidate of dependency.equals) {
          if (!target.schema.safeParse(candidate).success) {
            impossible.push(`${descriptor.key} -> ${dependency.key} = ${String(candidate)}`);
          }
        }
      }
    }

    expect(impossible).toEqual([]);
  });
});

describe('secrets', () => {
  it('are machine-scoped, always', () => {
    // Architecture 7b: secrets live only in the machine layer. Anything above it is a
    // database row that gets exported, diffed and rendered.
    const escaped = SETTINGS_REGISTRY.filter(
      (descriptor) => descriptor.secret && descriptor.scope !== 'machine',
    ).map((descriptor) => descriptor.key);

    expect(escaped).toEqual([]);
  });

  it('cannot be written at project or run scope', () => {
    const secrets = SETTINGS_REGISTRY.filter((descriptor) => descriptor.secret);

    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(isWritableAt(secret, 'project')).toBe(false);
      expect(isWritableAt(secret, 'run')).toBe(false);
      expect(isWritableAt(secret, 'machine')).toBe(true);
    }
  });

  it('are rendered by a write-only control', () => {
    const readable = SETTINGS_REGISTRY.filter(
      (descriptor) => descriptor.secret && descriptor.control.kind !== 'secret',
    ).map((descriptor) => descriptor.key);

    expect(readable).toEqual([]);
  });
});

describe('the machine layer binding', () => {
  it('gives every machine-scope setting an environment variable to read', () => {
    // A machine-scope setting with no env var can only ever hold its default, because
    // the machine layer is `.env` and nothing else writes it.
    const unreachable = SETTINGS_REGISTRY.filter(
      (descriptor) => descriptor.scope === 'machine' && descriptor.env === undefined,
    ).map((descriptor) => descriptor.key);

    expect(unreachable).toEqual([]);
  });

  it('never binds two settings to the same variable', () => {
    const names = SETTINGS_REGISTRY.flatMap((descriptor) =>
      descriptor.env === undefined ? [] : [descriptor.env.name],
    );

    expect(new Set(names).size).toBe(names.length);
  });

  it('reads money as dollars and stores it as nano-dollars', () => {
    // `.env` quotes budgets the way a human writes them; the ledger stores them the way
    // money has to be stored. Any other pairing loses nine orders of magnitude silently.
    const money = SETTINGS_REGISTRY.filter((descriptor) => descriptor.control.kind === 'money');

    expect(money.length).toBeGreaterThan(0);
    for (const descriptor of money) {
      if (descriptor.env !== undefined) expect(descriptor.env.format).toBe('usd-dollars');
    }
  });

  it('reads a toggle as a boolean', () => {
    const wrong = SETTINGS_REGISTRY.filter(
      (descriptor) =>
        descriptor.control.kind === 'toggle' &&
        descriptor.env !== undefined &&
        descriptor.env.format !== 'boolean',
    ).map((descriptor) => descriptor.key);

    expect(wrong).toEqual([]);
  });
});

describe('per-stage model selection', () => {
  it('offers a model slot for every pipeline stage', () => {
    // The owner's explicit requirement, generalised by architecture 5: Ollama, Gemini or
    // OpenRouter, chosen independently for each stage.
    const missing = PipelineStageKey.options.filter(
      (stage) => !isSettingKey(`model.stage.${stage}`),
    );

    expect(missing).toEqual([]);
  });

  it('declares no stage slot that is not a pipeline stage', () => {
    const stageKeys = SETTING_KEYS.filter((key) => key.startsWith('model.stage.'));

    expect(stageKeys).toHaveLength(PipelineStageKey.options.length);
  });

  it('defaults every stage to "let the router decide"', () => {
    for (const stage of PipelineStageKey.options) {
      expect(settingFor(`model.stage.${stage}`).default).toBeNull();
    }
  });

  it('lets each text stage be pinned to Ollama, Gemini or OpenRouter independently', () => {
    const control = settingFor('model.stage.story').control;

    expect(control.kind).toBe('model-picker');
    if (control.kind !== 'model-picker') throw new Error('unreachable');
    expect(control.providers).toEqual(['ollama', 'gemini', 'openrouter']);
    expect(control.nullable).toBe(true);
  });

  it('routes the image stage to the image providers instead', () => {
    const control = settingFor('model.stage.produce').control;

    if (control.kind !== 'model-picker') throw new Error('unreachable');
    // Ollama generates no images; ComfyUI is the free local lane and a provider like
    // any other.
    expect(control.providers).toEqual(['comfyui', 'gemini', 'openrouter']);
    expect(control.capability).toBe('image-generation');
  });

  it('offers only catalogue models that actually have the capability asked for', () => {
    const wrong: string[] = [];

    for (const descriptor of SETTINGS_REGISTRY) {
      if (descriptor.control.kind !== 'model-picker') continue;
      const { capability, providers } = descriptor.control;
      for (const option of descriptor.options ?? []) {
        const model = KNOWN_MODELS.find(
          (candidate) =>
            option.value === candidate.id ||
            option.value === `${candidate.provider}:${candidate.id}`,
        );
        if (
          model === undefined ||
          !model.capabilities.includes(capability) ||
          !providers.includes(model.provider)
        ) {
          wrong.push(`${descriptor.key}: ${String(option.value)}`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it('drops a model from every picker the moment it leaves the catalogue', () => {
    // The property that makes the picker maintenance-free. Asserted by construction:
    // every offered value resolves to a live catalogue entry.
    const offered = SETTINGS_REGISTRY.filter(
      (descriptor) => descriptor.control.kind === 'model-picker',
    ).flatMap((descriptor) => (descriptor.options ?? []).map((option) => String(option.value)));
    const catalogue = new Set(
      KNOWN_MODELS.flatMap((model) => [model.id, `${model.provider}:${model.id}`]),
    );

    expect(offered.filter((value) => !catalogue.has(value))).toEqual([]);
    expect(offered.length).toBeGreaterThan(0);
  });

  it('admits a model the seed catalogue has never heard of', () => {
    // `KNOWN_MODELS` is seed data: Ollama serves whatever the operator pulled, and the
    // OpenRouter catalogue is synced live. A closed picker would reject a real model.
    const pickers = SETTINGS_REGISTRY.filter(
      (descriptor) => descriptor.control.kind === 'model-picker',
    );

    expect(pickers.length).toBeGreaterThan(0);
    for (const picker of pickers) {
      if (picker.control.kind !== 'model-picker') continue;
      expect(picker.control.allowCustom).toBe(true);
    }
  });
});

describe('delivery formats', () => {
  it('offers exactly the verified platform presets', () => {
    const offered = settingFor('delivery.formats').options.map((option) => option.value);

    expect([...offered].sort()).toEqual(Object.keys(FORMAT_PRESETS).sort());
  });

  it('ships a default set that is a subset of the presets', () => {
    const shipped = settingFor('delivery.formats').default;

    expect(shipped.length).toBeGreaterThan(0);
    for (const format of shipped) expect(FORMAT_PRESETS[format]).toBeDefined();
  });
});

describe('grouping', () => {
  it('puts every declaration in exactly one panel, and leaves no panel empty', () => {
    const grouped = SettingGroup.options.flatMap((group) => settingsInGroup(group));

    expect(grouped).toHaveLength(SETTINGS_REGISTRY.length);
    for (const group of SettingGroup.options) {
      expect(settingsInGroup(group).length).toBeGreaterThan(0);
    }
  });
});

describe('key lookup', () => {
  it('resolves a known key to its descriptor', () => {
    expect(settingFor('image.lane').group).toBe('image');
  });

  it('recognises a key that exists and rejects one that does not', () => {
    expect(isSettingKey('image.lane')).toBe(true);
    expect(isSettingKey('image.laneish')).toBe(false);
    // Not a own-property check away from being wrong: `toString` is on the prototype.
    expect(isSettingKey('toString')).toBe(false);
  });
});

/** The half of a descriptor the meta schema describes. */
function stripSchema(descriptor: AnySettingDescriptor): Record<string, unknown> {
  const { schema: _schema, default: _default, ...meta } = descriptor;
  return meta;
}
