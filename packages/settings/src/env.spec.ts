import { describe, expect, it } from 'vitest';

import {
  REGISTERED_ENV_VARS,
  REGISTERED_RV_ENV_VARS,
  envBindingFor,
  loadMachineLayer,
  unknownRvVars,
} from './env';
import { resolve } from './resolve';

describe('reading the machine layer', () => {
  it('reads a string verbatim', () => {
    const { layer } = loadMachineLayer({ RV_FFMPEG_PATH: '/opt/bin/ffmpeg' });

    expect(layer.values['render.ffmpegPath']).toBe('/opt/bin/ffmpeg');
    expect(layer.scope).toBe('machine');
  });

  it('reads an integer', () => {
    expect(loadMachineLayer({ RV_API_PORT: '4000' }).layer.values['runtime.apiPort']).toBe(4000);
  });

  it('reads a boolean in every spelling an operator plausibly uses', () => {
    for (const truthy of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(
        loadMachineLayer({ RV_COMFYUI_REMOTE: truthy }).layer.values['image.comfyui.remote'],
      ).toBe(true);
    }
    for (const falsy of ['false', 'FALSE', '0', 'no', 'off']) {
      expect(
        loadMachineLayer({ RV_COMFYUI_REMOTE: falsy }).layer.values['image.comfyui.remote'],
      ).toBe(false);
    }
  });

  it('reads a budget as dollars and stores it as integer nano-dollars', () => {
    // `.env` quotes money the way a human writes it; the ledger stores it the way money
    // has to be stored. Anything else loses nine orders of magnitude in silence.
    const { layer } = loadMachineLayer({
      RV_BUDGET_USD_PER_RUN: '5.00',
      RV_CONFIRM_SPEND_ABOVE_USD: '0.07',
    });

    expect(layer.values['budget.perRunNanoUsd']).toBe(5_000_000_000);
    // 0.07 * 1e9 is 70000000.00000001 in binary floating point; an un-rounded nano
    // amount is not an integer and fails `NanoUsdAmount`.
    expect(layer.values['budget.confirmAboveNanoUsd']).toBe(70_000_000);
  });

  it('trims surrounding whitespace before coercing', () => {
    expect(loadMachineLayer({ RV_API_PORT: '  4000  ' }).layer.values['runtime.apiPort']).toBe(
      4000,
    );
  });

  it('treats a blank variable as "not configured", not as an empty override', () => {
    // Every credential in `.env.example` ships as `KEY=`. Overriding the default with
    // an empty string would report the credential as present.
    const { layer } = loadMachineLayer({ GEMINI_API_KEY: '', REDIS_URL: '   ' });

    expect(Object.hasOwn(layer.values, 'provider.gemini.apiKey')).toBe(false);
    expect(Object.hasOwn(layer.values, 'runtime.redisUrl')).toBe(false);
  });

  it('reads variables that are not ours when the registry names them', () => {
    const { layer, warnings } = loadMachineLayer({ OLLAMA_HOST: 'http://gpu-box:11434' });

    expect(layer.values['provider.ollama.host']).toBe('http://gpu-box:11434');
    expect(warnings).toEqual([]);
  });

  it('leaves everything else at its default', () => {
    const { layer } = loadMachineLayer({ RV_API_PORT: '4000' });

    expect(resolve('runtime.apiPort', [layer]).value).toBe(4000);
    expect(resolve('runtime.apiPrefix', [layer]).origin).toBe('default');
  });
});

describe('warnings', () => {
  it('reports an RV_ variable no setting reads', () => {
    // The exact failure the registry exists to prevent: the operator writes
    // `RV_BUDGET_PER_RUN_USD`, nothing complains, and the guard runs on the default.
    const { warnings } = loadMachineLayer({ RV_BUDGET_PER_RUN_USD: '5.00' });

    expect(warnings).toEqual([
      {
        variable: 'RV_BUDGET_PER_RUN_USD',
        reason: 'unknown',
        message: expect.stringContaining('No setting reads this variable'),
      },
    ]);
  });

  it('says nothing about variables outside our namespace', () => {
    // `PATH`, `NODE_ENV` and `HOME` are not ours to police.
    const { warnings } = loadMachineLayer({ PATH: '/usr/bin', NODE_ENV: 'production', HOME: '/h' });

    expect(warnings).toEqual([]);
  });

  it('reports a variable that cannot be coerced, and keeps the default', () => {
    const { layer, warnings } = loadMachineLayer({ RV_API_PORT: 'eighty' });

    expect(Object.hasOwn(layer.values, 'runtime.apiPort')).toBe(false);
    expect(warnings[0]?.reason).toBe('unparseable');
    expect(warnings[0]?.message).toContain('a whole number');
  });

  it('refuses a number that is only nearly a number', () => {
    // `parseInt` reads "3abc" as 3 and "1e5" as 1. An env var that is nearly a number
    // is a mistake, not an approximation.
    expect(loadMachineLayer({ RV_API_PORT: '80abc' }).warnings[0]?.reason).toBe('unparseable');
    expect(loadMachineLayer({ RV_RENDER_CONCURRENCY: '1e2' }).warnings[0]?.reason).toBe(
      'unparseable',
    );
  });

  it('reports an unrecognised boolean word', () => {
    const { warnings } = loadMachineLayer({ RV_COMFYUI_ENABLED: 'maybe' });

    expect(warnings[0]?.message).toContain('true or false');
  });

  it('reports a malformed money amount', () => {
    const { warnings } = loadMachineLayer({ RV_BUDGET_USD_PER_DAY: '$25' });

    expect(warnings[0]?.message).toContain('an amount in dollars');
  });

  it('reports a value that coerces but then fails the setting schema', () => {
    // 70000 coerces to a number and is refused by the port range. The distinction
    // matters: the message has to come from the schema, not from the coercion.
    const { layer, warnings } = loadMachineLayer({ RV_API_PORT: '70000' });

    expect(Object.hasOwn(layer.values, 'runtime.apiPort')).toBe(false);
    expect(warnings[0]?.reason).toBe('unparseable');
    expect(warnings[0]?.message).toContain('Falling back to the default');
  });

  it('never throws, so a typo cannot stop the process that would let you fix it', () => {
    expect(() =>
      loadMachineLayer({ RV_API_PORT: 'nope', RV_MYSTERY: 'x', RV_COMFYUI_REMOTE: 'perhaps' }),
    ).not.toThrow();
  });

  it('sorts unknown variables, so the warning list is stable', () => {
    expect(unknownRvVars({ RV_ZED: '1', RV_ALPHA: '2' })).toEqual(['RV_ALPHA', 'RV_ZED']);
  });
});

describe('the declared bindings', () => {
  it('names the variable a key reads', () => {
    expect(envBindingFor('budget.perRunNanoUsd')).toEqual({
      name: 'RV_BUDGET_USD_PER_RUN',
      format: 'usd-dollars',
    });
  });

  it('returns null for a key with no binding', () => {
    expect(envBindingFor('budget.perProjectNanoUsd')).toBeNull();
  });

  it('returns null for a key that does not exist', () => {
    expect(envBindingFor('not.a.key')).toBeNull();
  });

  it('lists the RV_ namespace as a subset of everything it reads', () => {
    expect(REGISTERED_RV_ENV_VARS.length).toBeGreaterThan(0);
    expect(REGISTERED_ENV_VARS.length).toBeGreaterThan(REGISTERED_RV_ENV_VARS.length);
    for (const name of REGISTERED_RV_ENV_VARS) expect(name.startsWith('RV_')).toBe(true);
  });
});
