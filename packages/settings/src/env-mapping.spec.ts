/**
 * The test that keeps three surfaces from drifting.
 *
 * `.env.example` is the machine layer as an operator meets it, the registry is the
 * machine layer as the code reads it, and the settings screen is generated from the
 * registry. If those two lists ever disagree, one of two things is true and both are
 * bad: a variable in the file does nothing, or a setting the code reads has no
 * documented way to be set.
 *
 * Both directions are asserted, and only the `RV_` namespace is policed - `OLLAMA_HOST`,
 * `GEMINI_API_KEY`, `COMFYUI_HOST`, `HF_TOKEN` and `REDIS_URL` are third-party
 * conventions we share a process with and did not name, so their presence in the file
 * is not ours to require.
 *
 * A failure here is a real drift, never a stale test. Fix the file or fix the registry.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  REGISTERED_ENV_VARS,
  REGISTERED_RV_ENV_VARS,
  RV_ENV_PREFIX,
  loadMachineLayer,
} from './env';

const ENV_EXAMPLE = fileURLToPath(new URL('../../../.env.example', import.meta.url));

/**
 * Assignments in `.env.example`, ignoring comments.
 *
 * The file documents the Colab lane inside a comment block that repeats real variable
 * names (`#     RV_COMFYUI_REMOTE=false`), so a parser that did not strip comments would
 * see them twice and, worse, would see example names that are not live settings.
 */
function declaredVariables(): readonly string[] {
  const contents = readFileSync(ENV_EXAMPLE, 'utf8');
  const names: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/** `.env.example` parsed into a `process.env`-shaped object. */
function exampleEnv(): Record<string, string> {
  const contents = readFileSync(ENV_EXAMPLE, 'utf8');
  const env: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (match?.[1] !== undefined) env[match[1]] = match[2] ?? '';
  }
  return env;
}

const declaredRvVars = (): readonly string[] =>
  declaredVariables().filter((name) => name.startsWith(RV_ENV_PREFIX));

describe('.env.example and the settings registry describe the same machine layer', () => {
  it('finds the file where it is expected to be', () => {
    expect(declaredVariables().length).toBeGreaterThan(0);
  });

  it('declares every RV_ variable the registry reads', () => {
    const declared = new Set(declaredRvVars());
    const missing = REGISTERED_RV_ENV_VARS.filter((name) => !declared.has(name));

    // A setting the code reads with no line in `.env.example` is a setting nobody knows
    // exists.
    expect(missing).toEqual([]);
  });

  it('has a registry entry for every RV_ variable it declares', () => {
    const claimed = new Set(REGISTERED_RV_ENV_VARS);
    const orphaned = declaredRvVars().filter((name) => !claimed.has(name));

    // A line in the file that nothing reads is a knob that does nothing, which is the
    // failure mode architecture 7b names first.
    expect(orphaned).toEqual([]);
  });

  it('declares each variable exactly once', () => {
    const declared = declaredVariables();

    expect(new Set(declared).size).toBe(declared.length);
  });

  it('warns about nothing when loaded as the machine layer', () => {
    // The end-to-end form of both assertions above: the shipped example file must load
    // clean, with no unknown variable and no unparseable value.
    const { warnings } = loadMachineLayer(exampleEnv());

    expect(warnings).toEqual([]);
  });

  it('produces the documented values when loaded', () => {
    const { layer } = loadMachineLayer(exampleEnv());

    expect(layer.values['runtime.apiPort']).toBe(3000);
    expect(layer.values['budget.perRunNanoUsd']).toBe(5_000_000_000);
    expect(layer.values['budget.perDayNanoUsd']).toBe(25_000_000_000);
    expect(layer.values['image.comfyui.remote']).toBe(false);
    expect(layer.values['provider.ollama.host']).toBe('http://127.0.0.1:11434');
  });

  it('leaves every blank credential unset rather than empty', () => {
    const { layer } = loadMachineLayer(exampleEnv());

    for (const key of [
      'provider.gemini.apiKey',
      'provider.openrouter.apiKey',
      'provider.huggingface.token',
      'image.comfyui.authToken',
      'runtime.redisUrl',
    ]) {
      expect(Object.hasOwn(layer.values, key)).toBe(false);
    }
  });

  it('names the non-RV variables it shares with third-party tooling', () => {
    // Not required to be in the file - but if one is dropped from the registry, the
    // adapter that reads it loses its configuration surface silently.
    const declared = new Set(declaredVariables());
    const shared = REGISTERED_ENV_VARS.filter((name) => !name.startsWith(RV_ENV_PREFIX));

    expect(shared.filter((name) => !declared.has(name))).toEqual([]);
  });
});
