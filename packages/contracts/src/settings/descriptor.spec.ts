import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type AnySettingDescriptor,
  CLOSED_CHOICE_CONTROLS,
  SETTING_ORIGINS,
  SettingControl,
  SettingDependency,
  SettingDescriptorMeta,
  SettingKeyPath,
  SettingOption,
  SettingScope,
  closedChoiceValues,
  defaultIsValid,
  isVisible,
  isWritableAt,
  originRank,
  writableScopes,
} from './descriptor';

/** A descriptor built to order, so the edge cases the registry avoids can be tested. */
function descriptor(overrides: Partial<AnySettingDescriptor> = {}): AnySettingDescriptor {
  return {
    key: 'test.value',
    group: 'runtime',
    label: { fa: 'آزمایش', en: 'Test' },
    help: { fa: 'راهنما', en: 'Help' },
    scope: 'project',
    secret: false,
    requiresRestart: false,
    dependsOn: [],
    control: { kind: 'toggle' },
    schema: z.boolean(),
    default: true,
    ...overrides,
  };
}

describe('setting keys', () => {
  it('requires at least two dotted segments, so every key names a group and a leaf', () => {
    // A bare `locale` is unplaceable in a generated settings screen.
    expect(SettingKeyPath.safeParse('locale').success).toBe(false);
    expect(SettingKeyPath.safeParse('image.lane').success).toBe(true);
    expect(SettingKeyPath.safeParse('provider.ollama.textModel').success).toBe(true);
  });

  it('rejects shapes a resolver would have to guess at', () => {
    expect(SettingKeyPath.safeParse('Image.lane').success).toBe(false);
    expect(SettingKeyPath.safeParse('image..lane').success).toBe(false);
    expect(SettingKeyPath.safeParse('image.lane.').success).toBe(false);
    expect(SettingKeyPath.safeParse('image-lane').success).toBe(false);
  });
});

describe('the layer order', () => {
  it('runs default -> machine -> global -> project -> run, later winning', () => {
    // Architecture 7b names this order; everything in the resolver is a comparison
    // against it, so it is asserted as data rather than trusted as prose.
    expect(SETTING_ORIGINS).toEqual(['default', 'machine', 'global', 'project', 'run']);
    expect(originRank('default')).toBeLessThan(originRank('machine'));
    expect(originRank('machine')).toBeLessThan(originRank('global'));
    expect(originRank('global')).toBeLessThan(originRank('project'));
    expect(originRank('project')).toBeLessThan(originRank('run'));
  });
});

describe('where a setting may be written', () => {
  it('treats scope as a floor: a run-scope setting is writable at every layer', () => {
    const runScoped = descriptor({ scope: 'run' });

    expect(writableScopes(runScoped)).toEqual(['machine', 'global', 'project', 'run']);
  });

  it('confines a machine-scope setting to the machine layer', () => {
    const machineScoped = descriptor({ scope: 'machine' });

    expect(writableScopes(machineScoped)).toEqual(['machine']);
    expect(isWritableAt(machineScoped, 'project')).toBe(false);
  });

  it('lets a project-scope setting be seeded from the machine layer but not from a run', () => {
    // The machine layer is `.env`, which must be able to seed anything it names.
    const projectScoped = descriptor({ scope: 'project' });

    expect(isWritableAt(projectScoped, 'machine')).toBe(true);
    expect(isWritableAt(projectScoped, 'project')).toBe(true);
    expect(isWritableAt(projectScoped, 'run')).toBe(false);
  });

  it('confines a secret to the machine layer whatever its scope claims', () => {
    // A secret written at project scope is a database row that gets exported with the
    // project. No redaction downstream can put that back.
    const secret = descriptor({ scope: 'run', secret: true });

    expect(writableScopes(secret)).toEqual(['machine']);
    expect(isWritableAt(secret, 'global')).toBe(false);
    expect(isWritableAt(secret, 'run')).toBe(false);
  });
});

describe('conditional visibility', () => {
  it('shows a setting with no dependencies unconditionally', () => {
    expect(isVisible(descriptor(), () => undefined)).toBe(true);
  });

  it('shows a setting when every dependency matches one of its listed values', () => {
    const dependent = descriptor({
      dependsOn: [
        { key: 'image.lane', equals: ['local-comfyui', 'colab'] },
        { key: 'image.comfyui.remote', equals: [true] },
      ],
    });

    const values: Record<string, unknown> = {
      'image.lane': 'colab',
      'image.comfyui.remote': true,
    };

    expect(isVisible(dependent, (key) => values[key])).toBe(true);
  });

  it('hides it when any single dependency fails', () => {
    const dependent = descriptor({
      dependsOn: [
        { key: 'image.lane', equals: ['local-comfyui', 'colab'] },
        { key: 'image.comfyui.remote', equals: [true] },
      ],
    });

    const values: Record<string, unknown> = {
      'image.lane': 'colab',
      'image.comfyui.remote': false,
    };

    // The ComfyUI token is ignored on a local lane. Rendering it anyway is how a field
    // that does nothing gets filled in and trusted.
    expect(isVisible(dependent, (key) => values[key])).toBe(false);
  });

  it('hides it when the referenced setting has no value at all', () => {
    const dependent = descriptor({ dependsOn: [{ key: 'image.lane', equals: ['colab'] }] });

    expect(isVisible(dependent, () => undefined)).toBe(false);
  });
});

describe('defaults', () => {
  it('accepts a default that satisfies its own schema', () => {
    expect(defaultIsValid(descriptor())).toBe(true);
  });

  it('rejects one that does not, because that is a booby trap and not a typo', () => {
    // It survives every path that never writes the setting and detonates the first time
    // someone opens the form and saves it unchanged.
    expect(defaultIsValid(descriptor({ schema: z.string(), default: 3 }))).toBe(false);
  });
});

describe('closed choices', () => {
  it('names select and multi-select as the controls whose options must be exhaustive', () => {
    expect([...CLOSED_CHOICE_CONTROLS].sort()).toEqual(['multi-select', 'select']);
  });

  it('reports the option values of a closed control', () => {
    const select = descriptor({
      control: { kind: 'select' },
      options: [
        { value: 'a', label: { fa: 'الف' } },
        { value: 'b', label: { fa: 'ب' } },
      ],
      schema: z.enum(['a', 'b']),
      default: 'a',
    });

    expect(closedChoiceValues(select)).toEqual(['a', 'b']);
  });

  it('reports an empty list for a closed control that declares no options', () => {
    // Distinct from `null`: a select with nothing to select is a bug, and the registry
    // spec has to be able to see the difference.
    expect(closedChoiceValues(descriptor({ control: { kind: 'select' } }))).toEqual([]);
  });

  it('reports null for an open control, whose options are only a seed', () => {
    const picker = descriptor({
      control: {
        kind: 'model-picker',
        capability: 'text-generation',
        providers: ['ollama'],
        allowCustom: true,
      },
      options: [{ value: 'qwen3.5:latest', label: { fa: 'کوئن' } }],
      schema: z.string(),
      default: 'qwen3.5:latest',
    });

    expect(closedChoiceValues(picker)).toBeNull();
  });
});

describe('the serialisable half of a descriptor', () => {
  it('validates a well-formed declaration', () => {
    const parsed = SettingDescriptorMeta.safeParse({
      key: 'image.lane',
      group: 'image',
      label: { fa: 'لِین', en: 'Lane' },
      help: { fa: 'کجا', en: 'Where' },
      scope: 'project',
      secret: false,
      requiresRestart: false,
      dependsOn: [],
      control: { kind: 'select' },
      options: [{ value: 'colab', label: { fa: 'کولب' }, hint: 'free' }],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a declaration missing the Persian label', () => {
    // The UI is Persian-first, so an English-only label renders as a blank row.
    const parsed = SettingDescriptorMeta.safeParse({
      key: 'image.lane',
      group: 'image',
      label: { en: 'Lane' },
      help: { fa: 'کجا' },
      scope: 'project',
      secret: false,
      requiresRestart: false,
      dependsOn: [],
      control: { kind: 'toggle' },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown group, so a new panel cannot appear by accident', () => {
    const parsed = SettingDescriptorMeta.safeParse({
      key: 'image.lane',
      group: 'sundries',
      label: { fa: 'لِین' },
      help: { fa: 'کجا' },
      scope: 'project',
      secret: false,
      requiresRestart: false,
      dependsOn: [],
      control: { kind: 'toggle' },
    });

    expect(parsed.success).toBe(false);
  });
});

describe('render hints', () => {
  it('requires a slider to state both ends of its range', () => {
    // "A slider with no maximum" cannot be drawn, so the schema must not be able to
    // express it.
    expect(SettingControl.safeParse({ kind: 'slider', min: 1, step: 1 }).success).toBe(false);
    expect(SettingControl.safeParse({ kind: 'slider', min: 1, max: 16, step: 1 }).success).toBe(
      true,
    );
  });

  it('lets a number field leave its bounds open', () => {
    expect(SettingControl.safeParse({ kind: 'number' }).success).toBe(true);
  });

  it('requires a money control to state its increment in nano-dollars', () => {
    expect(SettingControl.safeParse({ kind: 'money' }).success).toBe(false);
    expect(SettingControl.safeParse({ kind: 'money', stepNanoUsd: 10_000_000 }).success).toBe(true);
  });

  it('requires a model picker to say which providers may fill the slot', () => {
    expect(
      SettingControl.safeParse({
        kind: 'model-picker',
        capability: 'text-generation',
        providers: [],
        allowCustom: true,
      }).success,
    ).toBe(false);
  });

  it('rejects a control kind no UI knows how to draw', () => {
    expect(SettingControl.safeParse({ kind: 'colour-wheel' }).success).toBe(false);
  });
});

describe('options and dependencies', () => {
  it('accepts a primitive option value and rejects a structured one', () => {
    expect(SettingOption.safeParse({ value: 'colab', label: { fa: 'کولب' } }).success).toBe(true);
    expect(SettingOption.safeParse({ value: 3, label: { fa: 'سه' } }).success).toBe(true);
    expect(SettingOption.safeParse({ value: ['a'], label: { fa: 'الف' } }).success).toBe(false);
  });

  it('requires a dependency to compare against at least one value', () => {
    // A condition with nothing to match can never be satisfied, so the field it guards
    // would be permanently invisible.
    expect(SettingDependency.safeParse({ key: 'image.lane', equals: [] }).success).toBe(false);
  });
});

describe('scopes', () => {
  it('offers exactly the four writable layers', () => {
    expect(SettingScope.options).toEqual(['machine', 'global', 'project', 'run']);
  });
});
