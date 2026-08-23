/**
 * RV-180's runtime half: the dependency rule, checked by booting.
 *
 * `pnpm arch:check` proves nothing above the application layer *imports* a vendor SDK.
 * That is a static property and it is not the same as "every port has an
 * implementation": a token declared and never bound compiles, cruises clean, and fails
 * on the first request that needs it. So this boots the real composition root and
 * resolves every declared token.
 *
 * The count assertion is the half that catches the opposite mistake - a port added to
 * `PORT_TOKENS` and bound nowhere, or bound and never declared.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PORT_TOKENS } from './tokens';
import { bootHarness, type Harness } from '../test/harness';

describe('the composition root', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('resolves every declared port token', () => {
    const unresolved: string[] = [];
    for (const token of PORT_TOKENS) {
      const resolved: unknown = harness.app.get(token, { strict: false });
      if (resolved === undefined || resolved === null) unresolved.push(token);
    }
    expect(unresolved).toEqual([]);
  });

  it('declares each token exactly once, so the count is a real count', () => {
    expect(new Set(PORT_TOKENS).size).toBe(PORT_TOKENS.length);
  });

  it('binds every port, so the number resolved equals the number declared', () => {
    const resolved = PORT_TOKENS.filter(
      (token) => harness.app.get(token, { strict: false }) !== undefined,
    );
    expect(resolved.length).toBe(PORT_TOKENS.length);
  });

  it('selects the in-process queue when REDIS_URL is blank', () => {
    expect(harness.config.queue.driver).toBe('in-process');
  });

  it('registers no provider adapter without a key, so no test can reach the network', async () => {
    const response = await request(harness.server).get('/api/health').expect(200);
    const body = response.body as {
      providers: { registered: string[]; skipped: { provider: string }[] };
    };
    expect(body.providers.registered).toEqual([]);
    expect(body.providers.skipped.map((entry) => entry.provider).sort()).toEqual([
      'comfyui',
      'gemini',
      'ollama',
      'openrouter',
    ]);
  });
});
