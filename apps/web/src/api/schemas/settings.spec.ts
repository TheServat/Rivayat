import { describe, expect, it } from 'vitest';

import { MODEL_CHOICES, SETTING_DESCRIPTORS } from '../fixtures/settings.fixture';

import {
  SETTINGS_REGISTRY,
  SETTING_GROUPS,
  SettingDescriptorMeta,
  SettingValue,
  SettingsPatch,
  SettingsSnapshot,
  WritableSettingsScope,
  isWritableScope,
  settingsInGroup,
} from './settings';

/**
 * These assert the *envelope*, not the registry.
 *
 * `@rv/contracts` owns the declarations and has its own hundred-per-cent suite for
 * them; re-checking a descriptor's shape here would be testing someone else's code.
 * What is local, and therefore what is tested, is the document `GET /settings` answers
 * with and the patch it accepts - plus the two structural claims the studio makes about
 * the registry: that every group renders and that nothing is left out of a panel.
 */
describe('the panel list covers the registry', () => {
  it('names every group the registry declares, and no others', () => {
    const declared = new Set(SETTINGS_REGISTRY.map((descriptor) => descriptor.group));
    expect([...SETTING_GROUPS].toSorted()).toEqual([...declared].toSorted());
  });

  it('places every declared setting in exactly one panel', () => {
    // A setting that belongs to no panel is a setting nobody can reach, which is the
    // whole failure architecture 7b's generated form exists to prevent.
    const placed = SETTING_GROUPS.flatMap((group) => settingsInGroup(group));
    expect(placed).toHaveLength(SETTINGS_REGISTRY.length);
    expect(new Set(placed.map((descriptor) => descriptor.key)).size).toBe(SETTINGS_REGISTRY.length);
  });
});

describe('SettingDescriptorMeta on the wire', () => {
  it('accepts every descriptor the fixture serialises', () => {
    expect(SETTING_DESCRIPTORS).toHaveLength(SETTINGS_REGISTRY.length);
    for (const meta of SETTING_DESCRIPTORS) {
      expect(SettingDescriptorMeta.safeParse(meta).success, meta.key).toBe(true);
    }
  });

  it('refuses the live schema and the default, which must not cross the wire', () => {
    // A Zod schema is not JSON and a client that received one would start executing it.
    // The `strictObject` refusal is what makes the omission structural rather than a
    // habit at the call site.
    const [descriptor] = SETTINGS_REGISTRY;
    expect(descriptor).toBeDefined();
    expect(SettingDescriptorMeta.safeParse(descriptor).success).toBe(false);
  });

  it('carries the control as an object with its render hints, not a bare string', () => {
    const concurrency = SETTING_DESCRIPTORS.find(
      (meta) => meta.key === 'render.concurrency',
    )?.control;
    expect(concurrency).toEqual({ kind: 'slider', min: 1, max: 16, step: 1 });
  });
});

describe('SettingValue', () => {
  const provenance = { key: 'model.qualityTier', origin: 'global', shadowed: [], ignored: [] };

  it('carries a value for a non-secret', () => {
    const parsed = SettingValue.parse({ ...provenance, secret: false, value: 'final' });
    expect(parsed.secret === false && parsed.value).toBe('final');
  });

  it('has nowhere to put a secret’s value, so a payload carrying one is refused', () => {
    // The guarantee is structural: the secret branch has no `value` property at all, and
    // both branches are strict. This is the hinge of "the UI can report that a key is
    // present, never what it is" - a redaction step that could be forgotten is not.
    const leaked = {
      ...provenance,
      key: 'provider.gemini.apiKey',
      secret: true,
      set: true,
      value: 'sk-live',
    };
    expect(SettingValue.safeParse(leaked).success).toBe(false);
    expect(
      SettingValue.safeParse({
        ...provenance,
        key: 'provider.gemini.apiKey',
        secret: true,
        set: true,
      }).success,
    ).toBe(true);
  });

  it('reports the layers that lost and the layers that were refused', () => {
    const parsed = SettingValue.parse({
      key: 'render.backend',
      origin: 'machine',
      shadowed: ['machine'],
      ignored: [{ scope: 'global', issuePaths: [''], message: 'invalid option' }],
      secret: false,
      value: 'auto',
    });
    expect(parsed.shadowed).toEqual(['machine']);
    expect(parsed.ignored[0]?.scope).toBe('global');
  });
});

describe('SettingsSnapshot', () => {
  const snapshot = {
    scope: { projectId: null, runId: null },
    target: 'global',
    descriptors: [],
    values: [],
    models: [],
    warnings: [],
  };

  it('carries the layer the view writes to, so the client never derives it', () => {
    expect(SettingsSnapshot.parse(snapshot).target).toBe('global');
  });

  it('refuses a snapshot with no target rather than defaulting one', () => {
    const { target: _target, ...withoutTarget } = snapshot;
    expect(SettingsSnapshot.safeParse(withoutTarget).success).toBe(false);
  });

  it('accepts the fixture’s model catalogue', () => {
    const parsed = SettingsSnapshot.parse({ ...snapshot, models: MODEL_CHOICES });
    expect(parsed.models[0]?.ref).toMatch(/^[a-z-]+:/);
    expect(parsed.models.every((model) => typeof model.pricing === 'string')).toBe(true);
  });
});

describe('SettingsPatch', () => {
  it('keeps setting a value and clearing an override as separate operations', () => {
    // `null` is a legitimate setting value - `budget.perRunNanoUsd: null` means "no
    // ceiling" - so "clear" cannot be encoded as "set null".
    const parsed = SettingsPatch.parse({
      scope: { projectId: null, runId: null },
      set: [{ key: 'budget.perRunNanoUsd', value: null }],
      clear: ['model.qualityTier'],
    });
    expect(parsed.set[0]?.value).toBeNull();
    expect(parsed.clear[0]).toBe('model.qualityTier');
  });

  it('carries no per-entry layer: the layer is the request’s', () => {
    const withLayer = {
      scope: { projectId: null, runId: null },
      set: [{ key: 'model.qualityTier', layer: 'run', value: 'final' }],
    };
    expect(SettingsPatch.safeParse(withLayer).success).toBe(false);
  });

  it('refuses a key that is not a dotted setting path', () => {
    const bad = { scope: { projectId: null, runId: null }, clear: ['locale'] };
    expect(SettingsPatch.safeParse(bad).success).toBe(false);
  });
});

describe('WritableSettingsScope', () => {
  it('has no `machine` member, because `.env` is not writable through the API', () => {
    expect([...WritableSettingsScope.options]).toEqual(['global', 'project', 'run']);
    expect(isWritableScope('machine')).toBe(false);
    expect(isWritableScope('project')).toBe(true);
  });
});
