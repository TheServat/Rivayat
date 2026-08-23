/**
 * Secrets, and the one-way door.
 *
 * The interesting test here is the sweeping one: fill every secret in the registry with
 * a distinctive value, resolve the lot, redact it, serialise the result, and assert that
 * not one of those strings appears anywhere in the output. A per-field assertion would
 * pass while a secret leaked through a field nobody thought to check, which is the only
 * way a secret ever leaks.
 */

import { SETTINGS_REGISTRY } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import { layer } from './layers';
import { redactForClient, redactSetting } from './redact';
import { resolve, resolveAll } from './resolve';

/** A value per secret setting, each unmistakable in a haystack. */
function secretMachineLayer(): ReturnType<typeof layer> {
  const values: Record<string, unknown> = {};
  let index = 0;
  for (const descriptor of SETTINGS_REGISTRY) {
    if (!descriptor.secret) continue;
    index += 1;
    values[descriptor.key] = `CANARY-${String(index)}-${descriptor.key}`;
  }
  return layer('machine', values);
}

function canaries(): readonly string[] {
  const stored = secretMachineLayer().values;
  return Object.values(stored).map((value) => String(value));
}

describe('a redacted payload', () => {
  it('contains no secret value anywhere, including nested', () => {
    const payload = redactForClient(resolveAll([secretMachineLayer()]));
    const serialised = JSON.stringify(payload);

    expect(canaries().length).toBeGreaterThan(0);
    for (const canary of canaries()) {
      expect(serialised).not.toContain(canary);
    }
  });

  it('still reports every secret as present', () => {
    const payload = redactForClient(resolveAll([secretMachineLayer()]));
    const secrets = payload.filter((entry) => entry.secret);

    expect(secrets.length).toBe(SETTINGS_REGISTRY.filter((d) => d.secret).length);
    for (const entry of secrets) {
      expect(entry.set).toBe(true);
    }
  });

  it('reports an unset secret as not set', () => {
    const payload = redactForClient(resolveAll([]));
    const geminiKey = payload.find((entry) => entry.key === 'provider.gemini.apiKey');

    expect(geminiKey?.secret).toBe(true);
    expect(geminiKey?.secret === true && geminiKey.set).toBe(false);
  });

  it('treats a blank credential as not set', () => {
    // Every credential in `.env.example` ships as `KEY=`. Reporting that as "set" tells
    // the operator the lane is configured when the next call will fail unauthenticated.
    const payload = redactForClient(
      resolveAll([layer('machine', { 'provider.gemini.apiKey': '   ' })]),
    );
    const geminiKey = payload.find((entry) => entry.key === 'provider.gemini.apiKey');

    expect(geminiKey?.secret === true && geminiKey.set).toBe(false);
  });

  it('passes non-secret values through untouched', () => {
    const payload = redactForClient(resolveAll([layer('machine', { 'render.concurrency': 7 })]));
    const concurrency = payload.find((entry) => entry.key === 'render.concurrency');

    expect(concurrency?.secret).toBe(false);
    expect(concurrency?.secret === false && concurrency.value).toBe(7);
  });

  it('carries provenance, which is not itself a secret', () => {
    // "Where did this come from" is safe to answer even for a credential, and it is the
    // answer an operator debugging a 401 actually needs.
    const payload = redactForClient(resolveAll([secretMachineLayer()]));
    const token = payload.find((entry) => entry.key === 'image.comfyui.authToken');

    expect(token?.origin).toBe('machine');
  });

  it('covers every declared setting, so the client never merges a partial payload', () => {
    expect(redactForClient(resolveAll([])).map((entry) => entry.key)).toEqual(
      SETTINGS_REGISTRY.map((descriptor) => descriptor.key),
    );
  });

  it('omits a key the resolved map does not carry rather than inventing one', () => {
    expect(redactForClient(new Map())).toEqual([]);
  });
});

describe('redactSetting', () => {
  it('redacts a single resolved secret', () => {
    const resolved = resolve('provider.openrouter.apiKey', [
      layer('machine', { 'provider.openrouter.apiKey': 'sk-or-real-key' }),
    ]);

    const redacted = redactSetting(resolved);

    expect(redacted).toEqual({
      key: 'provider.openrouter.apiKey',
      secret: true,
      origin: 'machine',
      set: true,
    });
  });

  it('keys off the descriptor, never off the key name or the value shape', () => {
    // A heuristic ("does the key contain `token`") is how the one secret named
    // `authorization` gets published - and how a non-secret named `siteUrl` gets hidden.
    const siteUrl = redactSetting(resolve('provider.openrouter.siteUrl', []));

    expect(siteUrl.secret).toBe(false);
  });

  it('reports a non-string secret as present without rendering it', () => {
    // Every secret in the registry is a string today. The fallback is here so that the
    // first one that is not still reports presence rather than leaking a value.
    const redacted = redactSetting({
      key: 'provider.gemini.apiKey',
      value: 12_345,
      origin: 'machine',
      shadowed: [],
      ignored: [],
    });

    expect(redacted).toEqual({
      key: 'provider.gemini.apiKey',
      secret: true,
      origin: 'machine',
      set: true,
    });
  });

  it('leaves a key with no descriptor unredacted rather than guessing', () => {
    // Only reachable through a hand-built `ResolvedSetting`; asserted so the fallback is
    // a decision rather than an accident.
    const redacted = redactSetting({
      key: 'not.declared',
      value: 'visible',
      origin: 'run',
      shadowed: [],
      ignored: [],
    });

    expect(redacted).toEqual({
      key: 'not.declared',
      secret: false,
      origin: 'run',
      value: 'visible',
    });
  });
});
