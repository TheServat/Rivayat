import { describe, expect, it } from 'vitest';
import { type z } from 'zod';

import { SETTINGS_REGISTRY, SettingScope, toDescriptorMeta } from './index';
import {
  SettingEnvWarning,
  SettingIgnoredValue,
  SettingJsonValue,
  SettingModelChoice,
  SettingValue,
  SettingsPatch,
  SettingsScopeRef,
  SettingsSnapshot,
  WritableSettingsScope,
  isWritableScope,
} from './wire';

const ulid = (tail: string): string => `01J9ZQ3K5M7N9P1R3T5V7X${tail}`;

const PROJECT_ID = `prj_${ulid('0001')}`;
const RUN_ID = `run_${ulid('0002')}`;

function failurePaths<T>(result: z.ZodSafeParseResult<T>): string[] {
  if (result.success) throw new Error('expected the parse to fail, but it succeeded');
  return result.error.issues.map((issue) => issue.path.join('.'));
}

function provenance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { key: 'image.lane', origin: 'global', shadowed: [], ignored: [], ...overrides };
}

/** A descriptor as it travels: the serialisable half of a real registry entry. */
function wireDescriptor(): unknown {
  const [first] = SETTINGS_REGISTRY;
  if (first === undefined) throw new Error('the registry is empty');
  return toDescriptorMeta(first);
}

describe('SettingsScopeRef', () => {
  it('reads an omitted scope as the global view rather than as an unknown one', () => {
    expect(SettingsScopeRef.parse({})).toEqual({ projectId: null, runId: null });
  });

  it('carries the project and run a value was resolved for', () => {
    expect(SettingsScopeRef.parse({ projectId: PROJECT_ID, runId: RUN_ID })).toEqual({
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });
  });

  it('refuses a run id in the project slot', () => {
    expect(failurePaths(SettingsScopeRef.safeParse({ projectId: RUN_ID }))).toEqual(['projectId']);
  });
});

describe('SettingValue', () => {
  it('carries the receipt that answers "why is this value being used"', () => {
    const parsed = SettingValue.parse({
      ...provenance({ origin: 'project', shadowed: ['global'] }),
      secret: false,
      value: 'colab',
    });

    expect(parsed).toEqual({
      key: 'image.lane',
      origin: 'project',
      shadowed: ['global'],
      ignored: [],
      secret: false,
      value: 'colab',
    });
  });

  it('refuses a secret that carries a value, in both directions', () => {
    // The whole point of the union: a secret's value is not a thing that can be
    // spelled, so a payload carrying one fails at the boundary rather than relying on
    // a redaction step upstream having remembered to run.
    const withValue = SettingValue.safeParse({
      ...provenance({ key: 'provider.gemini.apiKey' }),
      secret: true,
      set: true,
      value: 'sk-live-abcdef',
    });

    expect(withValue.success).toBe(false);
  });

  it('lets a secret report only whether one is set', () => {
    const parsed = SettingValue.parse({
      ...provenance({ key: 'provider.gemini.apiKey', origin: 'machine' }),
      secret: true,
      set: false,
    });

    expect(parsed).toEqual({
      key: 'provider.gemini.apiKey',
      origin: 'machine',
      shadowed: [],
      ignored: [],
      secret: true,
      set: false,
    });
  });

  it('refuses a non-secret with no value, which is a dropped field rather than a state', () => {
    expect(SettingValue.safeParse({ ...provenance(), secret: false }).success).toBe(false);
  });

  it('reports a layer whose stored value the resolver refused, rather than hiding it', () => {
    const ignored = {
      scope: 'project',
      issuePaths: ['lane'],
      message: 'not one of the declared lanes',
    };
    const parsed = SettingValue.parse({
      ...provenance({ ignored: [ignored] }),
      secret: false,
      value: 'local-comfyui',
    });

    expect(SettingIgnoredValue.parse(ignored)).toEqual(ignored);
    expect(parsed.ignored).toEqual([ignored]);
  });

  it('accepts every JSON shape a setting can hold, because the descriptor types it, not this', () => {
    for (const value of [null, 3, true, 'text', [1, 2], { nested: { deep: true } }]) {
      expect(SettingJsonValue.parse(value)).toEqual(value);
      expect(SettingValue.parse({ ...provenance(), secret: false, value }).secret).toBe(false);
    }
  });
});

describe('SettingsSnapshot', () => {
  const snapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    scope: { projectId: null, runId: null },
    target: 'global',
    descriptors: [wireDescriptor()],
    values: [{ ...provenance(), secret: false, value: 'local-comfyui' }],
    models: [],
    warnings: [],
    ...overrides,
  });

  it('carries a real registry declaration through the wire schema unchanged', () => {
    const parsed = SettingsSnapshot.parse(snapshot());

    expect(parsed.descriptors[0]).toEqual(wireDescriptor());
  });

  it('names the layer a write from this view lands on', () => {
    // Derived by the API from `scope`, sent rather than re-derived: every row's
    // read-only state depends on it and a client that computed it would be a second
    // place the rule lives.
    expect(SettingsSnapshot.parse(snapshot({ target: 'run' })).target).toBe('run');
  });

  it('surfaces an unreadable environment variable instead of only logging it', () => {
    const warning = { variable: 'RV_TYPO', reason: 'unknown', message: 'no setting reads this' };
    const parsed = SettingsSnapshot.parse(snapshot({ warnings: [warning] }));

    expect(SettingEnvWarning.parse(warning)).toEqual(warning);
    expect(parsed.warnings).toEqual([warning]);
  });

  it('carries the catalogue a model-picker chooses from', () => {
    const choice = {
      ref: 'ollama:qwen3.5:14b',
      provider: 'ollama',
      model: 'qwen3.5:14b',
      label: 'Qwen 3.5 14B',
      capabilities: ['text-generation'],
      free: true,
      pricing: 'free (local)',
    };
    const parsed = SettingsSnapshot.parse(snapshot({ models: [choice] }));

    expect(SettingModelChoice.parse(choice)).toEqual(choice);
    expect(parsed.models).toEqual([choice]);
  });

  it('refuses a model choice that claims no capability at all', () => {
    expect(
      failurePaths(
        SettingModelChoice.safeParse({
          ref: 'ollama:qwen3.5:14b',
          provider: 'ollama',
          model: 'qwen3.5:14b',
          label: 'Qwen 3.5 14B',
          capabilities: [],
          free: true,
          pricing: 'free (local)',
        }),
      ),
    ).toEqual(['capabilities']);
  });

  it('never emits a secret value anywhere in the serialised response, nested included', () => {
    // The guarantee is structural, so the assertion is too: walk the whole document
    // and prove the string is not in it, rather than checking the one field a reviewer
    // happened to think of.
    const parsed = SettingsSnapshot.parse(
      snapshot({
        values: [
          { ...provenance(), secret: false, value: 'local-comfyui' },
          {
            ...provenance({ key: 'provider.gemini.apiKey', origin: 'machine' }),
            secret: true,
            set: true,
          },
        ],
      }),
    );

    expect(JSON.stringify(parsed)).not.toContain('sk-live');
    expect(
      SettingsSnapshot.safeParse(
        snapshot({
          values: [
            {
              ...provenance({ key: 'provider.gemini.apiKey' }),
              secret: true,
              set: true,
              value: 'sk-live-abcdef',
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });
});

describe('SettingsPatch', () => {
  it('reads an empty submission as no edits rather than as a missing field', () => {
    expect(SettingsPatch.parse({ scope: {} })).toEqual({
      scope: { projectId: null, runId: null },
      set: [],
      clear: [],
    });
  });

  it('keeps "store null here" and "clear the override" as two different requests', () => {
    // `budget.perRunNanoUsd: null` means no ceiling, which is a value; clearing it
    // means fall back to the layer below. One list could not say both.
    const parsed = SettingsPatch.parse({
      scope: { projectId: PROJECT_ID },
      set: [{ key: 'budget.perRunNanoUsd', value: null }],
      clear: ['image.lane'],
    });

    expect(parsed.set).toEqual([{ key: 'budget.perRunNanoUsd', value: null }]);
    expect(parsed.clear).toEqual(['image.lane']);
  });

  it('refuses a key that is not a dotted setting path', () => {
    expect(failurePaths(SettingsPatch.safeParse({ scope: {}, clear: ['imagelane'] }))).toEqual([
      'clear.0',
    ]);
  });

  it('carries no per-entry layer, so one submission is all-or-nothing', () => {
    expect(
      SettingsPatch.safeParse({
        scope: {},
        set: [{ key: 'image.lane', value: 'colab', scope: 'run' }],
      }).success,
    ).toBe(false);
  });
});

describe('isWritableScope', () => {
  it('excludes the machine layer, which is the environment and not a row', () => {
    expect(isWritableScope('machine')).toBe(false);
  });

  it('admits every layer the repository can actually store', () => {
    const writable = SettingScope.options.filter(isWritableScope);

    expect(writable).toEqual(WritableSettingsScope.options);
  });
});
