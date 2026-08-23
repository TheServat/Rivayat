/**
 * Writing settings.
 *
 * The property that matters most here is that a rejection names **every** bad field. A
 * form that can only be told about one mistake at a time turns three typos into three
 * round trips, and the third is where the user gives up.
 */

import { describe, expect, it } from 'vitest';

import { applyPatch } from './patch';

function issuesOf(result: ReturnType<typeof applyPatch>): readonly { key: string; code: string }[] {
  if (result.ok) throw new Error('expected the patch to be rejected');
  return result.error.issues.map((issue) => ({ key: issue.key, code: issue.code }));
}

describe('a valid patch', () => {
  it('is accepted and returns a layer ready to store', () => {
    const result = applyPatch({
      scope: 'project',
      scopeId: 'prj_1',
      values: { 'render.backend': 'napi-canvas', 'model.qualityTier': 'final' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scope).toBe('project');
    expect(result.value.scopeId).toBe('prj_1');
    expect(result.value.values).toEqual({
      'render.backend': 'napi-canvas',
      'model.qualityTier': 'final',
    });
  });

  it('returns the parsed value, not the raw one', () => {
    // What gets stored has to be what was checked, or the coercion is happening twice
    // with two different answers.
    const result = applyPatch({
      scope: 'machine',
      scopeId: null,
      values: { 'provider.openrouter.appName': '  Rivayat  ' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `NonEmptyString` trims.
    expect(result.value.values['provider.openrouter.appName']).toBe('Rivayat');
  });

  it('accepts an empty patch as a no-op layer', () => {
    const result = applyPatch({ scope: 'run', scopeId: 'run_1', values: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.values).toEqual({});
  });
});

describe('a rejected patch', () => {
  it('names every bad field rather than the first', () => {
    const result = applyPatch({
      scope: 'project',
      scopeId: 'prj_1',
      values: {
        'render.concurrency': 999, // out of range
        'model.qualityTier': 'perfect', // not a tier
        'nonsense.key': true, // undeclared
        'provider.gemini.apiKey': 'sk-real', // a secret, above the machine layer
        'runtime.apiPort': 8080, // machine-scope only
        'render.backend': 'auto', // fine
      },
    });

    expect(issuesOf(result)).toEqual([
      { key: 'render.concurrency', code: 'invalid-value' },
      { key: 'model.qualityTier', code: 'invalid-value' },
      { key: 'nonsense.key', code: 'unknown-key' },
      { key: 'provider.gemini.apiKey', code: 'secret-scope' },
      { key: 'runtime.apiPort', code: 'scope-violation' },
    ]);
  });

  it('applies nothing at all, not the half that parsed', () => {
    // A patch is one form submission. Applying half of it leaves the machine in a state
    // the user never chose and the re-rendered form does not show.
    const result = applyPatch({
      scope: 'project',
      scopeId: null,
      values: { 'render.backend': 'auto', 'render.concurrency': -3 },
    });

    expect(result.ok).toBe(false);
  });

  it('says which scopes a setting can be written at', () => {
    const result = applyPatch({
      scope: 'run',
      scopeId: 'run_1',
      values: { 'image.lane': 'colab' },
    });

    if (result.ok) throw new Error('expected a scope violation');
    expect(result.error.issues[0]?.message).toContain('machine, global, project');
  });

  it('reports the path inside a structured value', () => {
    const result = applyPatch({
      scope: 'project',
      scopeId: null,
      values: { 'delivery.formats': ['yt-1080p', 'vimeo'] },
    });

    if (result.ok) throw new Error('expected a validation failure');
    expect(result.error.issues[0]?.paths).toEqual(['1']);
  });

  it('carries the failing keys in the error context for the log', () => {
    const result = applyPatch({
      scope: 'run',
      scopeId: null,
      values: { 'nope.one': 1, 'nope.two': 2 },
    });

    if (result.ok) throw new Error('expected a rejection');
    expect(result.error.context.keys).toEqual(['nope.one', 'nope.two']);
    expect(result.error.kind).toBe('validation');
    expect(result.error.retryable).toBe(false);
  });

  it('pluralises its own message honestly', () => {
    const one = applyPatch({ scope: 'run', scopeId: null, values: { 'nope.one': 1 } });
    const two = applyPatch({
      scope: 'run',
      scopeId: null,
      values: { 'nope.one': 1, 'nope.two': 2 },
    });

    if (one.ok || two.ok) throw new Error('expected rejections');
    expect(one.error.message).toContain('1 invalid entry');
    expect(two.error.message).toContain('2 invalid entries');
  });
});

describe('scope enforcement', () => {
  it('refuses a secret at project scope', () => {
    expect(
      issuesOf(
        applyPatch({
          scope: 'project',
          scopeId: 'prj_1',
          values: { 'image.comfyui.authToken': 'tok' },
        }),
      ),
    ).toEqual([{ key: 'image.comfyui.authToken', code: 'secret-scope' }]);
  });

  it('refuses a secret at run scope', () => {
    expect(
      issuesOf(
        applyPatch({
          scope: 'run',
          scopeId: 'run_1',
          values: { 'provider.huggingface.token': 'hf_x' },
        }),
      ),
    ).toEqual([{ key: 'provider.huggingface.token', code: 'secret-scope' }]);
  });

  it('refuses a secret at global scope too, which is a database row like any other', () => {
    expect(
      issuesOf(
        applyPatch({
          scope: 'global',
          scopeId: null,
          values: { 'provider.gemini.apiKey': 'sk' },
        }),
      ),
    ).toEqual([{ key: 'provider.gemini.apiKey', code: 'secret-scope' }]);
  });

  it('accepts a secret on the machine layer', () => {
    const result = applyPatch({
      scope: 'machine',
      scopeId: null,
      values: { 'provider.gemini.apiKey': 'sk-live' },
    });

    expect(result.ok).toBe(true);
  });

  it('lets the machine layer seed a project-scope setting', () => {
    // `.env` must be able to seed anything it names; scope is a floor, not a pin.
    const result = applyPatch({
      scope: 'machine',
      scopeId: null,
      values: { 'render.backend': 'pixi-playwright' },
    });

    expect(result.ok).toBe(true);
  });

  it('lets a run override a run-scope setting', () => {
    const result = applyPatch({
      scope: 'run',
      scopeId: 'run_1',
      values: { 'model.stage.story': 'openrouter:z-ai/glm-5.2:free' },
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a malformed model reference rather than storing a bare model id', () => {
    // A bare id is ambiguous once the same slug is reachable through two providers, and
    // a cost ledger that cannot tell them apart cannot be audited.
    expect(
      issuesOf(
        applyPatch({
          scope: 'run',
          scopeId: 'run_1',
          values: { 'model.stage.story': 'glm-5.2' },
        }),
      ),
    ).toEqual([{ key: 'model.stage.story', code: 'invalid-value' }]);
  });
});
