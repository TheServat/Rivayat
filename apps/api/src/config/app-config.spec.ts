/**
 * Configuration is the one thing that must fail at boot, loudly, or not at all.
 *
 * A server that starts with a broken configuration and fails on the first request has
 * moved the error from the operator's terminal to a user's screen, and moved the
 * diagnosis from "the message names the key" to "read the stack". These tests hold that
 * line: every bad key is reported, by name, in one message.
 */

import { describe, expect, it } from 'vitest';

import { loadConfig, routerConfigFrom, SECRET_ENV_KEYS, type AppConfig } from './app-config';

/** The minimum a valid environment needs. Everything else has a default. */
const MINIMAL: Record<string, string> = { NODE_ENV: 'test' };

/** Parses, or fails the test with the message an operator would have seen. */
function must(env: Record<string, string>): AppConfig {
  const parsed = loadConfig(env);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

describe('loadConfig', () => {
  it('accepts an environment that sets nothing but NODE_ENV', () => {
    const config = must(MINIMAL);
    expect(config.env).toBe('test');
    expect(config.http.port).toBe(3000);
    expect(config.http.globalPrefix).toBe('api');
  });

  it('treats a blank REDIS_URL as no Redis and selects the in-process queue', () => {
    expect(must({ ...MINIMAL, REDIS_URL: '' }).queue.driver).toBe('in-process');
    expect(must({ ...MINIMAL, REDIS_URL: '   ' }).queue.driver).toBe('in-process');
    // Absent, not merely blank - the two must agree.
    expect(must(MINIMAL).queue.driver).toBe('in-process');
  });

  it('selects BullMQ when REDIS_URL has a value', () => {
    const config = must({ ...MINIMAL, REDIS_URL: 'redis://127.0.0.1:6379' });
    expect(config.queue.driver).toBe('bullmq');
    expect(config.queue.redisUrl).toBe('redis://127.0.0.1:6379');
  });

  it('treats a blank numeric key as absent rather than as zero', () => {
    // `Number('')` is 0, so a naive parse turns `RV_API_PORT=` into port 0 - a port the
    // OS interprets as "pick one", which is the worst possible silent behaviour.
    expect(must({ ...MINIMAL, RV_API_PORT: '' }).http.port).toBe(3000);
    expect(must({ ...MINIMAL, RV_QUEUE_CONCURRENCY: '' }).queue.concurrency).toBe(4);
  });

  it('converts dollar ceilings to integer nano-dollars', () => {
    const config = must({
      ...MINIMAL,
      RV_BUDGET_USD_PER_RUN: '5.00',
      RV_BUDGET_USD_PER_DAY: '25',
      RV_CONFIRM_SPEND_ABOVE_USD: '0.000000001',
    });
    expect(config.budget.perRunNanoUsd).toBe(5_000_000_000);
    expect(config.budget.perDayNanoUsd).toBe(25_000_000_000);
    // One nano-dollar survives the conversion; a micro-dollar unit would round it away.
    expect(config.budget.confirmAboveNanoUsd).toBe(1);
  });

  it('leaves an unset ceiling as null, which means "no ceiling at this scope"', () => {
    const config = must(MINIMAL);
    expect(config.budget.perRunNanoUsd).toBeNull();
    expect(config.budget.perProjectNanoUsd).toBeNull();
    expect(config.budget.onExceed).toBe('abort');
  });

  it('reports every bad key at once, each by name', () => {
    const parsed = loadConfig({
      NODE_ENV: 'staging',
      RV_API_PORT: 'three thousand',
      OLLAMA_HOST: 'not-a-url',
      RV_BUDGET_USD_PER_RUN: '-1',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    const message = parsed.error.message;
    for (const key of ['NODE_ENV', 'RV_API_PORT', 'OLLAMA_HOST', 'RV_BUDGET_USD_PER_RUN']) {
      expect(message, `expected "${key}" to be named`).toContain(key);
    }
    expect(parsed.error.kind).toBe('validation');
  });

  it('says why a budget was rejected, not just that it was', () => {
    const parsed = loadConfig({ ...MINIMAL, RV_BUDGET_USD_PER_RUN: '-1' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain('cannot be negative');
  });

  it('parses the boolean spellings an operator actually writes', () => {
    for (const truthy of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(must({ ...MINIMAL, RV_COMFYUI_ENABLED: truthy }).providers.comfyui.enabled).toBe(true);
    }
    for (const falsy of ['false', '0', 'no', 'off', '']) {
      expect(must({ ...MINIMAL, RV_COMFYUI_ENABLED: falsy }).providers.comfyui.enabled).toBe(false);
    }
  });

  it('reports a provider as available only when it is actually configured', () => {
    const none = must(MINIMAL).providers.available;
    expect(none).toEqual({ ollama: false, gemini: false, openrouter: false, comfyui: false });

    const some = must({
      ...MINIMAL,
      OLLAMA_HOST: 'http://127.0.0.1:11434',
      GEMINI_API_KEY: 'k',
      RV_COMFYUI_ENABLED: 'true',
      COMFYUI_HOST: 'http://127.0.0.1:8288',
    }).providers.available;
    expect(some).toEqual({ ollama: true, gemini: true, openrouter: false, comfyui: true });
  });

  it('does not call ComfyUI available when it is enabled with no host', () => {
    const config = must({ ...MINIMAL, RV_COMFYUI_ENABLED: 'true', COMFYUI_HOST: '' });
    expect(config.providers.available.comfyui).toBe(false);
  });

  it('names every secret key it knows how to redact', () => {
    expect(SECRET_ENV_KEYS).toContain('GEMINI_API_KEY');
    expect(SECRET_ENV_KEYS).toContain('OPENROUTER_API_KEY');
    expect(SECRET_ENV_KEYS).toContain('COMFYUI_AUTH_TOKEN');
    expect(SECRET_ENV_KEYS).toContain('HF_TOKEN');
  });
});

describe('routerConfigFrom', () => {
  it('prefers the free lane when no paid provider is configured', () => {
    expect(routerConfigFrom(must(MINIMAL)).defaultPolicy).toBe('cheapest');
  });

  it('balances once a paid provider exists', () => {
    const config = must({ ...MINIMAL, GEMINI_API_KEY: 'k' });
    expect(routerConfigFrom(config).defaultPolicy).toBe('balanced');
  });

  it('declares no rules and no pins - those belong to the layers above .env', () => {
    const router = routerConfigFrom(must(MINIMAL));
    expect(router.rules).toEqual([]);
    expect(router.stageOverrides).toEqual({});
    expect(router.taskOverrides).toEqual({});
    expect(router.failover.failoverOn).toContain('rate-limit');
  });
});
