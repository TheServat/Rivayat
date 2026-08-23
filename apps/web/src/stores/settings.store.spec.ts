import type { ProjectId, RunId } from '@rv/contracts';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { setStudioApi, StudioApi } from '../api/client';
import { ApiError } from '../api/errors';
import { FixtureTransport } from '../api/fixtures/fixture-transport';
import { SETTINGS_REGISTRY, isWritableAt } from '../api/schemas/settings';

import { useSettingsStore } from './settings.store';

const PROJECT: ProjectId = 'prj_01JQZK3M7X8YB4N2VTC6WPHRDE';
const RUN: RunId = 'run_01JQZM5P9R7S2T4V6W8X0Y1Z3A';

/** The non-secret half of a resolved value, so a test can read `value` without casting. */
function plainValue(store: ReturnType<typeof useSettingsStore>, key: string): unknown {
  const resolved = store.valueOf(key);
  return resolved !== undefined && !resolved.secret ? resolved.value : undefined;
}

describe('resolution and provenance', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setStudioApi(new StudioApi(new FixtureTransport()));
  });

  it('serves every setting the registry declares, in registry order', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    expect(settings.descriptors.map((descriptor) => descriptor.key)).toEqual(
      SETTINGS_REGISTRY.map((descriptor) => descriptor.key),
    );
  });

  it('resolves a value from the highest layer that sets it', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    // The fixture's global layer sets the quality tier.
    expect(settings.valueOf('model.qualityTier')?.origin).toBe('global');
    expect(plainValue(settings, 'model.qualityTier')).toBe('preview');

    // Nothing in this view's stack sets the routing policy, so the built-in default
    // answers - and says so.
    expect(settings.valueOf('model.routingPolicy')?.origin).toBe('default');
    expect(plainValue(settings, 'model.routingPolicy')).toBe('balanced');
  });

  it('names the layers that held a value and lost', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    // `.env` sets a daily ceiling and the global layer overrides it. "I changed it and
    // nothing happened" is indistinguishable from "it did not save" without this.
    const daily = settings.valueOf('budget.perDayNanoUsd');
    expect(daily?.origin).toBe('global');
    expect(daily?.shadowed).toEqual(['machine']);
  });

  it('reports a stored value the schema refused instead of hiding the fallback', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    const backend = settings.valueOf('render.backend');
    expect(backend?.ignored.map((entry) => entry.scope)).toEqual(['global']);
    // Skipped, not fatal: the screen still opens, on the value below.
    expect(backend?.origin).toBe('default');
    expect(plainValue(settings, 'render.backend')).toBe('auto');
    expect(settings.status).toBe('ready');
  });

  it('never receives a secret’s value, only whether one is present', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    const present = settings.valueOf('provider.openrouter.apiKey');
    expect(present).toMatchObject({ secret: true, set: true });
    expect(present).not.toHaveProperty('value');

    // Blank in `.env`, exactly as `.env.example` ships it. Not "set".
    expect(settings.valueOf('provider.gemini.apiKey')).toMatchObject({ secret: true, set: false });

    // And there is nothing for a control to render, so the draft is empty.
    expect(settings.draftOf('provider.openrouter.apiKey')).toBeUndefined();
  });

  it('surfaces the environment warnings the API reports', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    expect(settings.warnings.length).toBeGreaterThan(0);
    expect(settings.warnings[0]?.reason).toBe('unknown');
  });

  it('widens the stack and the write target when the scope narrows', async () => {
    const settings = useSettingsStore();
    settings.scope = { projectId: PROJECT, runId: RUN };
    await settings.load('fa');

    expect(settings.target).toBe('run');
    expect(settings.valueOf('model.qualityTier')).toMatchObject({
      origin: 'run',
      shadowed: ['global'],
    });
    expect(settings.valueOf('image.lane')?.origin).toBe('project');
  });
});

describe('what this view may write', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setStudioApi(new StudioApi(new FixtureTransport()));
  });

  it('marks machine-scope settings read-only without hiding them', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    // Architecture 7b wants every option *visible*; `.env` is simply not writable
    // through an API. A row that named its variable and stayed on screen is the honest
    // rendering, and a row that vanished would be the drift 7b exists to prevent.
    const machineOnly = SETTINGS_REGISTRY.filter(
      (descriptor) => !isWritableAt(descriptor, 'global'),
    );
    expect(machineOnly.length).toBeGreaterThan(0);
    for (const descriptor of machineOnly) {
      expect(settings.isEditable(descriptor.key), descriptor.key).toBe(false);
      expect(settings.valueOf(descriptor.key), descriptor.key).toBeDefined();
    }

    const rendered = settings.panels.flatMap((panel) =>
      panel.descriptors.map((descriptor) => descriptor.key),
    );
    expect(rendered).toContain('runtime.apiPort');
  });

  it('refuses an edit to a row this layer cannot write', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    settings.setValue('runtime.apiPort', 4000);
    settings.clearOverride('runtime.apiPort');
    expect(settings.dirtyCount).toBe(0);
  });

  it('offers to clear an override only where this layer holds one', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    // Set globally, which is this view's layer.
    expect(settings.canClear('model.qualityTier')).toBe(true);
    // Set in `.env` only: writable here, but there is no global override to remove.
    expect(settings.canClear('render.concurrency')).toBe(false);
    // Not writable here at all.
    expect(settings.canClear('runtime.apiPort')).toBe(false);
    // The global layer holds a value the schema refused - still an override.
    expect(settings.canClear('render.backend')).toBe(true);
  });

  it('will not offer to clear an override twice', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');
    settings.clearOverride('model.qualityTier');
    expect(settings.canClear('model.qualityTier')).toBe(false);
  });
});

describe('editing and saving', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setStudioApi(new StudioApi(new FixtureTransport()));
  });

  it('writes an edit at the layer the snapshot named', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    settings.setValue('image.lane', 'cloud-api');
    expect(settings.drafts.get('image.lane')).toEqual({ kind: 'set', value: 'cloud-api' });

    await settings.save();
    expect(settings.valueOf('image.lane')?.origin).toBe('global');
    expect(plainValue(settings, 'image.lane')).toBe('cloud-api');
    expect(settings.dirtyCount).toBe(0);
  });

  it('clearing an override falls back to the layer underneath, not to the default', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');
    expect(plainValue(settings, 'budget.perDayNanoUsd')).toBe(40_000_000_000);

    settings.clearOverride('budget.perDayNanoUsd');
    expect(settings.dirtyCount).toBe(1);

    await settings.save();
    // `.env` still holds one - which is the whole point of showing four layers.
    expect(settings.valueOf('budget.perDayNanoUsd')?.origin).toBe('machine');
    expect(plainValue(settings, 'budget.perDayNanoUsd')).toBe(25_000_000_000);
  });

  it('does not count a no-op edit as a change', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');
    settings.setValue('model.qualityTier', 'preview');
    expect(settings.dirtyCount).toBe(0);
  });

  it('refuses to save while a draft fails the descriptor’s own schema', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    settings.setValue('render.concurrency', 999);
    expect(settings.validate('render.concurrency')).not.toBeNull();
    expect(settings.invalidKeys).toEqual(['render.concurrency']);
    await expect(settings.save()).resolves.toBe(false);
    // The bad value never left the form.
    expect(plainValue(settings, 'render.concurrency')).toBe(6);
  });

  it('discarding restores the server’s answer exactly', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    settings.setValue('model.qualityTier', 'final');
    settings.clearOverride('budget.perDayNanoUsd');
    expect(settings.dirtyCount).toBe(2);

    settings.discardAll();
    expect(settings.dirtyCount).toBe(0);
    expect(settings.draftOf('model.qualityTier')).toBe('preview');
    expect(settings.valueOf('budget.perDayNanoUsd')?.origin).toBe('global');
  });

  it('keeps the drafts when a save fails, so nothing the user typed is lost', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');
    settings.setValue('model.qualityTier', 'final');

    setStudioApi(
      new StudioApi({
        kind: 'http',
        send: () => Promise.reject(new Error('gateway timeout')),
        eventSourceUrl: () => null,
      }),
    );

    await expect(settings.save()).resolves.toBe(false);
    expect(settings.error?.code).toBe('settings-save-failed');
    expect(settings.dirtyCount).toBe(1);
    expect(settings.saving).toBe(false);
  });

  /**
   * The server names the fields it refused, and the form marks them.
   *
   * This is what `ApiError.issues` exists for. A rejected patch that reported only "two
   * invalid entries" would leave the user hunting through sixty rows for the two the
   * server had already identified.
   */
  it('marks the rows the server rejected, and clears them on the next edit', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');
    settings.setValue('model.qualityTier', 'final');

    setStudioApi(
      new StudioApi({
        kind: 'http',
        send: () =>
          Promise.reject(
            new ApiError({
              failure: 'api',
              code: 'settings.patch-rejected',
              kind: 'validation',
              status: 400,
              message: 'rejected',
              issues: [
                { path: 'model.qualityTier', message: 'this tier is disabled', code: 'custom' },
              ],
            }),
          ),
        eventSourceUrl: () => null,
      }),
    );

    await expect(settings.save()).resolves.toBe(false);
    expect(settings.validate('model.qualityTier')).toBe('this tier is disabled');
    expect(settings.invalidKeys).toEqual(['model.qualityTier']);

    settings.setValue('model.qualityTier', 'draft');
    expect(settings.validate('model.qualityTier')).toBeNull();
  });

  it('does nothing when asked to save with no pending changes', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');
    await expect(settings.save()).resolves.toBe(false);
  });

  it('ignores an edit to a key the registry does not declare', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');
    settings.setValue('not.aRealSetting', 1);
    settings.clearOverride('not.aRealSetting');
    expect(settings.dirtyCount).toBe(0);
    expect(settings.canClear('not.aRealSetting')).toBe(false);
    expect(settings.validate('not.aRealSetting')).toBeNull();
    expect(settings.draftOf('not.aRealSetting')).toBeUndefined();
  });
});

describe('visibility and grouping', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setStudioApi(new StudioApi(new FixtureTransport()));
  });

  it('hides a setting whose dependency is unmet, from the draft rather than the save', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    const authToken = settings.descriptors.find((d) => d.key === 'image.comfyui.authToken');
    const workflowDir = settings.descriptors.find((d) => d.key === 'image.comfyui.workflowDir');
    expect(authToken).toBeDefined();
    expect(workflowDir).toBeDefined();
    if (authToken === undefined || workflowDir === undefined) return;

    // The token needs *both* conditions: a ComfyUI lane and a remote host. The fixture
    // sets `remote` in `.env`, and the lane defaults to local ComfyUI.
    expect(authToken.dependsOn).toHaveLength(2);
    expect(settings.isVisible(authToken)).toBe(true);
    expect(settings.isVisible(workflowDir)).toBe(true);

    // Switching lane hides both, before anything is saved.
    settings.setValue('image.lane', 'cloud-api');
    expect(settings.isVisible(authToken)).toBe(false);
    expect(settings.isVisible(workflowDir)).toBe(false);
  });

  it('keeps registry order inside a panel rather than sorting by key', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    const models = settings.panels.find((panel) => panel.group === 'models');
    const expected = SETTINGS_REGISTRY.filter((d) => d.group === 'models').map((d) => d.key);
    expect(models?.descriptors.map((d) => d.key)).toEqual(expected);
    // Pipeline order, not alphabetical: `intake` comes before `cast`.
    expect(expected.indexOf('model.stage.intake')).toBeLessThan(
      expected.indexOf('model.stage.cast'),
    );
  });

  it('groups descriptors into panels and filters them by the search query', async () => {
    const settings = useSettingsStore();
    await settings.load('fa');

    const groups = settings.panels.map((panel) => panel.group);
    expect(groups).toContain('budget');
    expect(groups).toContain('runtime');

    settings.query = 'budget.';
    expect(settings.panels.map((panel) => panel.group)).toEqual(['budget']);

    settings.query = 'nothing-matches-this';
    expect(settings.panels).toEqual([]);
  });

  it('surfaces a transport failure instead of leaving the screen blank', async () => {
    setStudioApi(
      new StudioApi({
        kind: 'http',
        send: () => Promise.reject(new Error('boom')),
        eventSourceUrl: () => null,
      }),
    );
    const settings = useSettingsStore();
    await settings.load('fa');

    expect(settings.status).toBe('error');
    expect(settings.error?.code).toBe('settings-load-failed');
  });
});
