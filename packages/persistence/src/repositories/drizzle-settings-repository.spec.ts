/**
 * The settings store, against a real migrated SQLite.
 *
 * Not a mock: the composite primary key is where "one global layer" is actually
 * enforced, and a fake cannot fail a primary key. The round trip through `resolve` at
 * the bottom is the real assertion - a value that survives storage but resolves to
 * something else has not survived storage.
 */

import { type IsoInstant, settingFor } from '@rv/contracts';
import { applyPatch, resolve, resolveAll } from '@rv/settings';
import { unwrap } from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTestDatabase } from '../__fixtures__/workspace';
import type { DatabaseHandle } from '../database/database';
import { DrizzleSettingsRepository } from './drizzle-settings-repository';

const NOW = '2026-08-23T00:00:00.000Z' as IsoInstant;
const LATER = '2026-08-24T00:00:00.000Z' as IsoInstant;
const PROJECT = 'prj_00000000000000000000000P1';
const RUN = 'run_00000000000000000000000R1';

let handle: DatabaseHandle;
let repository: DrizzleSettingsRepository;

beforeEach(() => {
  handle = openTestDatabase();
  repository = new DrizzleSettingsRepository(handle);
});

afterEach(() => {
  handle.close();
});

describe('round trip', () => {
  it('stores and reads back every shape a setting can hold', async () => {
    // A boolean, an integer, a string, an array and an explicit null - the five things
    // the JSON column has to survive without the descriptor's help.
    const values = {
      'model.pinStageOverrides': false,
      'render.concurrency': 6,
      'render.backend': 'napi-canvas',
      'delivery.formats': ['ig-1x1', 'tiktok-9x16'],
      'budget.perProjectNanoUsd': null,
    };

    unwrap(await repository.save({ scope: 'project', scopeId: PROJECT }, values, NOW));
    const layer = unwrap(await repository.loadLayer({ scope: 'project', scopeId: PROJECT }));

    expect(layer.values).toEqual(values);
    expect(layer.scope).toBe('project');
    expect(layer.scopeId).toBe(PROJECT);
  });

  it('resolves a stored value to the same thing that was written', async () => {
    const patch = unwrap(
      applyPatch({
        scope: 'project',
        scopeId: PROJECT,
        values: { 'model.stage.story': 'gemini:gemini-3-flash' },
      }),
    );

    unwrap(await repository.save({ scope: 'project', scopeId: PROJECT }, patch.values, NOW));
    const layer = unwrap(await repository.loadLayer({ scope: 'project', scopeId: PROJECT }));

    const resolved = resolve('model.stage.story', [layer]);

    expect(resolved.value).toBe('gemini:gemini-3-flash');
    expect(resolved.origin).toBe('project');
  });

  it('reads an empty layer for a scope nothing has been written at', async () => {
    const layer = unwrap(await repository.loadLayer({ scope: 'run', scopeId: RUN }));

    expect(layer.values).toEqual({});
    // Everything therefore falls back to the built-in defaults.
    expect(resolve('model.qualityTier', [layer]).origin).toBe('default');
  });

  it('keeps the overrides of one project out of another', async () => {
    unwrap(
      await repository.save({ scope: 'project', scopeId: PROJECT }, { 'image.lane': 'colab' }, NOW),
    );

    const other = unwrap(
      await repository.loadLayer({ scope: 'project', scopeId: 'prj_00000000000000000000000P2' }),
    );

    expect(other.values).toEqual({});
  });
});

describe('the global layer', () => {
  it('has exactly one instance, addressed with no id', async () => {
    unwrap(
      await repository.save({ scope: 'global', scopeId: null }, { 'interface.locale': 'en' }, NOW),
    );
    unwrap(
      await repository.save(
        { scope: 'global', scopeId: null },
        { 'interface.locale': 'fa' },
        LATER,
      ),
    );

    const stored = unwrap(await repository.list({ scope: 'global', scopeId: null }));

    // A nullable `scope_id` would let these be two rows, because NULL is not equal to
    // itself in a SQLite primary key.
    expect(stored).toHaveLength(1);
    expect(stored[0]?.value).toBe('fa');
    expect(stored[0]?.scopeId).toBeNull();
    expect(stored[0]?.updatedAt).toBe(LATER);
  });
});

describe('a save is a merge', () => {
  it('leaves keys the patch did not mention alone', async () => {
    // The form that produced the patch only sends what changed. Replacing the layer
    // would silently delete every override the user did not happen to touch.
    const ref = { scope: 'project', scopeId: PROJECT } as const;
    unwrap(await repository.save(ref, { 'render.concurrency': 6, 'image.lane': 'colab' }, NOW));
    unwrap(await repository.save(ref, { 'render.concurrency': 12 }, LATER));

    const layer = unwrap(await repository.loadLayer(ref));

    expect(layer.values).toEqual({ 'render.concurrency': 12, 'image.lane': 'colab' });
  });

  it('accepts an empty patch without touching anything', async () => {
    const ref = { scope: 'project', scopeId: PROJECT } as const;
    unwrap(await repository.save(ref, { 'render.concurrency': 6 }, NOW));
    unwrap(await repository.save(ref, {}, LATER));

    expect(unwrap(await repository.loadLayer(ref)).values).toEqual({ 'render.concurrency': 6 });
  });
});

describe('clearing an override', () => {
  it('lets the key fall back to the layer below', async () => {
    const ref = { scope: 'project', scopeId: PROJECT } as const;
    unwrap(await repository.save(ref, { 'render.concurrency': 6, 'image.lane': 'colab' }, NOW));
    unwrap(await repository.clear(ref, ['render.concurrency']));

    const layer = unwrap(await repository.loadLayer(ref));

    expect(layer.values).toEqual({ 'image.lane': 'colab' });
    expect(resolve('render.concurrency', [layer]).value).toBe(
      settingFor('render.concurrency').default,
    );
  });

  it('is a no-op for a key that was never overridden', async () => {
    const ref = { scope: 'run', scopeId: RUN } as const;

    expect(unwrap(await repository.clear(ref, ['render.concurrency']))).toEqual({});
  });

  it('accepts an empty key list', async () => {
    expect(unwrap(await repository.clear({ scope: 'run', scopeId: RUN }, []))).toEqual({});
  });
});

describe('the stack', () => {
  it('reads global, project and run in one call, in resolution order', async () => {
    unwrap(
      await repository.save(
        { scope: 'global', scopeId: null },
        { 'model.qualityTier': 'preview' },
        NOW,
      ),
    );
    unwrap(
      await repository.save(
        { scope: 'project', scopeId: PROJECT },
        { 'model.qualityTier': 'final' },
        NOW,
      ),
    );
    unwrap(await repository.save({ scope: 'run', scopeId: RUN }, { 'render.concurrency': 1 }, NOW));

    const stack = unwrap(await repository.loadStack({ projectId: PROJECT, runId: RUN }));

    expect(stack.map((layer) => layer.scope)).toEqual(['global', 'project', 'run']);
    const resolved = resolveAll(stack);
    expect(resolved.get('model.qualityTier')?.value).toBe('final');
    expect(resolved.get('model.qualityTier')?.origin).toBe('project');
    expect(resolved.get('render.concurrency')?.origin).toBe('run');
  });

  it('omits the project and run layers when none is asked for', async () => {
    const stack = unwrap(await repository.loadStack({ projectId: null, runId: null }));

    expect(stack.map((layer) => layer.scope)).toEqual(['global']);
  });

  it('never includes the machine layer, which is .env and not a row', async () => {
    const stack = unwrap(await repository.loadStack({ projectId: PROJECT, runId: RUN }));

    expect(stack.map((layer) => layer.scope)).not.toContain('machine');
  });
});

describe('the machine layer is refused', () => {
  it('cannot be saved, because that would put a secret in an exportable row', async () => {
    const result = await repository.save(
      { scope: 'machine', scopeId: null },
      { 'provider.gemini.apiKey': 'sk-live' },
      NOW,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('cannot be cleared either, since nothing there was ever ours to remove', async () => {
    const result = await repository.clear({ scope: 'machine', scopeId: null }, ['x.y']);

    expect(result.ok).toBe(false);
  });

  it('stores nothing even when the refused save names many keys', async () => {
    await repository.save({ scope: 'machine', scopeId: null }, { 'render.concurrency': 4 }, NOW);

    expect(unwrap(await repository.list({ scope: 'machine', scopeId: null }))).toEqual([]);
  });
});

describe('failures reach the caller as a Result', () => {
  it('converts a driver error rather than throwing it', async () => {
    handle.close();

    const result = await repository.loadLayer({ scope: 'global', scopeId: null });

    // Nothing above the adapter boundary ever sees a better-sqlite3 exception.
    expect(result.ok).toBe(false);
  });
});

describe('listing', () => {
  it('reports the stored value and when it was written', async () => {
    unwrap(
      await repository.save({ scope: 'run', scopeId: RUN }, { 'model.qualityTier': 'draft' }, NOW),
    );

    const stored = unwrap(await repository.list({ scope: 'run', scopeId: RUN }));

    expect(stored).toEqual([
      { scope: 'run', scopeId: RUN, key: 'model.qualityTier', value: 'draft', updatedAt: NOW },
    ]);
  });
});
