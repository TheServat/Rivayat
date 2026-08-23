/**
 * Layered resolution and provenance.
 *
 * The behaviour under test is not "the last layer wins" - that is one line of code. It
 * is that the resolver can *explain* its answer, because architecture 7b makes "why is
 * this model being used" a question the UI has to be able to answer once four layers
 * exist.
 */

import { SETTINGS_REGISTRY, settingFor } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import { layer, orderedLayers } from './layers';
import { diff, resolve, resolveAll, resolveUnknown, visibleSettings } from './resolve';

describe('resolution order', () => {
  it('falls back to the built-in default when no layer says anything', () => {
    const resolved = resolve('model.qualityTier', []);

    expect(resolved.value).toBe('draft');
    expect(resolved.origin).toBe('default');
    expect(resolved.shadowed).toEqual([]);
  });

  it('lets the machine layer beat the default', () => {
    const resolved = resolve('render.concurrency', [layer('machine', { 'render.concurrency': 8 })]);

    expect(resolved.value).toBe(8);
    expect(resolved.origin).toBe('machine');
  });

  it('lets each layer beat the one before it, all the way up', () => {
    const stack = [
      layer('machine', { 'render.concurrency': 2 }),
      layer('global', { 'render.concurrency': 3 }),
      layer('project', { 'render.concurrency': 4 }),
      layer('run', { 'render.concurrency': 5 }),
    ];

    const resolved = resolve('render.concurrency', stack);

    expect(resolved.value).toBe(5);
    expect(resolved.origin).toBe('run');
    expect(resolved.shadowed).toEqual(['machine', 'global', 'project']);
  });

  it('skips a missing middle layer without disturbing the ones around it', () => {
    // The realistic stack: `.env` on the machine, an override on the run, and nothing
    // global or project-level at all.
    const resolved = resolve('render.concurrency', [
      layer('machine', { 'render.concurrency': 2 }),
      layer('run', { 'render.concurrency': 9 }),
    ]);

    expect(resolved.value).toBe(9);
    expect(resolved.origin).toBe('run');
    expect(resolved.shadowed).toEqual(['machine']);
  });

  it('resolves to the lower layer when the higher one is silent about this key', () => {
    const resolved = resolve('render.concurrency', [
      layer('machine', { 'render.concurrency': 2 }),
      layer('run', { 'model.qualityTier': 'final' }),
    ]);

    expect(resolved.value).toBe(2);
    expect(resolved.origin).toBe('machine');
  });

  it('does not depend on the order the layers were fetched in', () => {
    // A stack is assembled from independent reads; "the run layer came back first" must
    // not change which value wins.
    const forwards = resolve('render.concurrency', [
      layer('machine', { 'render.concurrency': 2 }),
      layer('project', { 'render.concurrency': 4 }),
    ]);
    const backwards = resolve('render.concurrency', [
      layer('project', { 'render.concurrency': 4 }),
      layer('machine', { 'render.concurrency': 2 }),
    ]);

    expect(backwards).toEqual(forwards);
    expect(orderedLayers([layer('run'), layer('machine')]).map((l) => l.scope)).toEqual([
      'machine',
      'run',
    ]);
  });

  it('treats an explicitly stored null as an answer, not as silence', () => {
    // `budget.perRunNanoUsd: null` means "no ceiling", which is a different statement
    // from "this layer says nothing about the ceiling".
    const resolved = resolve('budget.perRunNanoUsd', [
      layer('machine', { 'budget.perRunNanoUsd': 5_000_000_000 }),
      layer('project', { 'budget.perRunNanoUsd': null }),
    ]);

    expect(resolved.value).toBeNull();
    expect(resolved.origin).toBe('project');
  });

  it('coerces through the schema rather than storing what it was handed', () => {
    // What the resolver returns must be what the schema produced, or the value that is
    // used is not the value that was checked.
    const resolved = resolve('provider.ollama.host', [
      layer('machine', { 'provider.ollama.host': 'http://127.0.0.1:11434' }),
    ]);

    expect(resolved.value).toBe('http://127.0.0.1:11434');
  });
});

describe('a stored value the schema no longer accepts', () => {
  it('is skipped, and the layer below it wins', () => {
    // The project layer is a database row an older version wrote. A settings screen
    // that refuses to open because of one bad row cannot be used to fix that row.
    const resolved = resolve('render.concurrency', [
      layer('machine', { 'render.concurrency': 2 }),
      layer('project', { 'render.concurrency': 999 }),
    ]);

    expect(resolved.value).toBe(2);
    expect(resolved.origin).toBe('machine');
  });

  it('is reported, so the UI can say which layer is storing rubbish', () => {
    const resolved = resolve('render.concurrency', [
      layer('project', { 'render.concurrency': 'lots' }),
    ]);

    expect(resolved.origin).toBe('default');
    expect(resolved.ignored).toHaveLength(1);
    expect(resolved.ignored[0]?.scope).toBe('project');
    expect(resolved.ignored[0]?.message.length).toBeGreaterThan(0);
  });

  it('reports the path inside a structured value, not just the key', () => {
    const resolved = resolve('delivery.formats', [
      layer('project', { 'delivery.formats': ['yt-1080p', 'not-a-format'] }),
    ]);

    // A form editing the list needs to highlight the second entry, not the whole field.
    expect(resolved.ignored[0]?.issuePaths).toEqual(['1']);
  });
});

describe('resolveAll', () => {
  it('resolves every declared setting exactly once', () => {
    const all = resolveAll([]);

    expect(all.size).toBe(SETTINGS_REGISTRY.length);
    for (const descriptor of SETTINGS_REGISTRY) {
      expect(all.get(descriptor.key)?.value).toEqual(descriptor.default);
      expect(all.get(descriptor.key)?.origin).toBe('default');
    }
  });

  it('carries provenance for each key independently', () => {
    const all = resolveAll([
      layer('machine', { 'render.concurrency': 6 }),
      layer('run', { 'model.qualityTier': 'final' }),
    ]);

    expect(all.get('render.concurrency')?.origin).toBe('machine');
    expect(all.get('model.qualityTier')?.origin).toBe('run');
    expect(all.get('interface.locale')?.origin).toBe('default');
  });
});

describe('resolveUnknown', () => {
  it('resolves a key that arrived as a string', () => {
    expect(resolveUnknown('interface.locale', [])?.value).toBe('fa');
  });

  it('returns null for a key the registry does not declare', () => {
    expect(resolveUnknown('interface.localle', [])).toBeNull();
  });
});

describe('conditional visibility over resolved values', () => {
  it('hides the ComfyUI token while the lane is local', () => {
    const visible = visibleSettings(resolveAll([]));
    const keys = visible.map((entry) => entry.key);

    // Default lane is `local-comfyui` with `remote: false`, so the token is ignored -
    // and a field that is ignored must not be a field that gets filled in and trusted.
    expect(keys).toContain('image.comfyui.host');
    expect(keys).not.toContain('image.comfyui.authToken');
  });

  it('reveals it once the host is declared remote', () => {
    const visible = visibleSettings(
      resolveAll([layer('machine', { 'image.comfyui.remote': true })]),
    );

    expect(visible.map((entry) => entry.key)).toContain('image.comfyui.authToken');
  });

  it('returns nothing for a resolved map that carries nothing', () => {
    // Defensive: `resolveAll` always fills every key, so this is only reachable through
    // a hand-built map. Asserted so the fallback is a decision, not an accident.
    expect(visibleSettings(new Map())).toEqual([]);
  });

  it('hides the whole ComfyUI block on the cloud lane', () => {
    const visible = visibleSettings(resolveAll([layer('project', { 'image.lane': 'cloud-api' })]));
    const keys = visible.map((entry) => entry.key);

    expect(keys).not.toContain('image.comfyui.host');
    expect(keys).not.toContain('image.comfyui.workflowDir');
    expect(keys).toContain('image.lane');
  });
});

describe('diff', () => {
  it('reports only the keys the layer actually sets', () => {
    const stack = [
      layer('machine', { 'render.concurrency': 2 }),
      layer('project', { 'render.backend': 'napi-canvas' }, 'prj_1'),
    ];

    const overrides = diff(stack, 'project');

    expect(overrides.map((entry) => entry.key)).toEqual(['render.backend']);
  });

  it('says what the value would have been without the layer', () => {
    const stack = [
      layer('machine', { 'render.concurrency': 2 }),
      layer('project', { 'render.concurrency': 8 }),
    ];

    const [override] = diff(stack, 'project');

    expect(override?.value).toBe(8);
    expect(override?.inherited).toBe(2);
    expect(override?.inheritedFrom).toBe('machine');
    expect(override?.effective).toBe(true);
  });

  it('falls back to the built-in default when nothing below the layer sets the key', () => {
    const [override] = diff([layer('project', { 'model.qualityTier': 'final' })], 'project');

    expect(override?.inherited).toBe(settingFor('model.qualityTier').default);
    expect(override?.inheritedFrom).toBe('default');
  });

  it('marks an override that a more specific layer has shadowed', () => {
    // "I changed it and nothing happened" must be distinguishable from "the change did
    // not save".
    const stack = [
      layer('project', { 'model.qualityTier': 'preview' }),
      layer('run', { 'model.qualityTier': 'final' }),
    ];

    const [override] = diff(stack, 'project');

    expect(override?.value).toBe('preview');
    expect(override?.effective).toBe(false);
  });

  it('reports nothing for a layer that stores only values the schema rejects', () => {
    // Storing rubbish is not overriding anything; `ResolvedSetting.ignored` covers it.
    expect(diff([layer('project', { 'render.concurrency': -1 })], 'project')).toEqual([]);
  });

  it('reports nothing for a layer that is not in the stack', () => {
    expect(diff([layer('machine', { 'render.concurrency': 2 })], 'run')).toEqual([]);
  });

  it('takes the later of two layers at the same scope, key by key', () => {
    // Two layers of one scope is what a caller supplies deliberately - a workspace
    // default merged with a project's own file - and the later one has to win per key,
    // not wholesale.
    const overrides = diff(
      [
        layer('project', { 'render.concurrency': 3, 'image.lane': 'colab' }),
        layer('project', { 'render.concurrency': 11 }),
      ],
      'project',
    );

    expect(overrides).toEqual([
      expect.objectContaining({ key: 'image.lane', value: 'colab' }),
      expect.objectContaining({ key: 'render.concurrency', value: 11 }),
    ]);
  });

  it('ignores keys the layer does not declare, even where a sibling layer does', () => {
    const stack = [
      layer('global', { 'interface.locale': 'en' }),
      layer('project', { 'render.backend': 'auto' }),
    ];

    expect(diff(stack, 'global').map((entry) => entry.key)).toEqual(['interface.locale']);
  });
});
