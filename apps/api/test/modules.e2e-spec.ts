/**
 * The rest of the surface: one request per remaining route.
 *
 * Thin by design. `http.e2e-spec.ts` proves the error envelope and the resource
 * lifecycle; this proves that every module is mounted, that its schemas reject what
 * they should, and that the routes behind a scaffolded engine answer 501 rather than
 * 404 - which is the difference between "we have not built it" and "you got the URL
 * wrong", and the only one a client integrating against this can act on.
 */

import type { AssetSpec } from '@rv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootHarness, type Harness } from './harness';

const STYLE_CHECKSUM = 'a'.repeat(64);
const ABSENT = {
  asset: 'ast_01J0000000000000000000000Z',
  episode: 'ep_01J0000000000000000000000Z',
  series: 'ser_01J0000000000000000000000Z',
  style: 'sty_01J0000000000000000000000Z',
};

const SPEC: AssetSpec = {
  semanticKey: 'flora/oak-tree/mature',
  archetype: 'tree',
  subjectClass: 'foliage',
  label: 'Mature oak',
  description: 'A gnarled old oak with a split trunk.',
  tags: [],
  canvas: { width: 1024, height: 1024 },
  nominalHeight: 512,
  parts: [
    {
      name: 'trunk',
      role: 'root',
      description: 'A split trunk',
      zOrder: 0,
      deformable: false,
      optional: false,
    },
  ],
  variants: [],
  references: [],
  quality: 'preview',
  requireAlpha: true,
};

interface ErrorBody {
  error: { kind: string; code: string; context: Record<string, unknown> };
}

describe('the remaining modules', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('assets', () => {
    it('resolves demand against the real registry, and spends nothing doing it', async () => {
      const response = await request(harness.server)
        .post('/api/assets/resolve')
        .send({
          specs: [SPEC],
          styleBibleId: ABSENT.style,
          styleChecksum: STYLE_CHECKSUM,
        })
        .expect(201);

      const plan = response.body as {
        hitCount: number;
        missCount: number;
        totalEstimatedNanoUsd: number;
        requiresConfirmation: boolean;
        resolutions: { outcome: string; key: string }[];
      };

      expect(plan.hitCount).toBe(0);
      expect(plan.missCount).toBe(1);
      expect(plan.resolutions[0]?.outcome).toBe('miss');
      // The dedup key is a sha256 of the four components; a plan that could not name it
      // could not be reconciled against what was later generated.
      expect(plan.resolutions[0]?.key).toMatch(/^[0-9a-f]{64}$/);
      // Any spend at all needs a yes, which is the safe default for image generation.
      expect(plan.requiresConfirmation).toBe(true);
      expect(plan.totalEstimatedNanoUsd).toBeGreaterThan(0);
    });

    it('collapses two requests for the same asset into one line', async () => {
      const response = await request(harness.server)
        .post('/api/assets/resolve')
        .send({
          specs: [SPEC, SPEC],
          styleBibleId: ABSENT.style,
          styleChecksum: STYLE_CHECKSUM,
        })
        .expect(201);

      // Two shots asking for the same oak tree are one generation. A plan that listed
      // it twice would quote twice the money for one file.
      expect((response.body as { missCount: number }).missCount).toBe(1);
    });

    it('honours a budget by blocking the specs that would cross it', async () => {
      const response = await request(harness.server)
        .post('/api/assets/resolve')
        .send({
          specs: [SPEC],
          styleBibleId: ABSENT.style,
          styleChecksum: STYLE_CHECKSUM,
          budgetNanoUsd: 1,
        })
        .expect(201);

      const plan = response.body as {
        missCount: number;
        resolutions: { outcome: string }[];
      };
      expect(plan.missCount).toBe(0);
      expect(plan.resolutions[0]?.outcome).toBe('blocked-by-budget');
    });

    it('keys a variant separately from the base asset', async () => {
      const base = await request(harness.server)
        .post('/api/assets/resolve')
        .send({ specs: [SPEC], styleBibleId: ABSENT.style, styleChecksum: STYLE_CHECKSUM })
        .expect(201);

      const winter = await request(harness.server)
        .post('/api/assets/resolve')
        .send({
          specs: [SPEC],
          styleBibleId: ABSENT.style,
          styleChecksum: STYLE_CHECKSUM,
          variantKey: 'winter',
          confirmationThresholdNanoUsd: 1_000_000_000,
        })
        .expect(201);

      const keyOf = (response: { body: unknown }): string =>
        (response.body as { resolutions: { key: string }[] }).resolutions[0]?.key ?? '';

      // `variantKey` is one of the four components of the dedup key. If it did not
      // move the key, a winter oak would silently serve the summer one.
      expect(keyOf(winter)).not.toBe(keyOf(base));
      // Under the confirmation threshold, so no human gate is needed for this plan.
      expect((winter.body as { requiresConfirmation: boolean }).requiresConfirmation).toBe(false);
    });

    it('rejects a resolve with no specs', async () => {
      await request(harness.server)
        .post('/api/assets/resolve')
        .send({ specs: [], styleBibleId: ABSENT.style, styleChecksum: STYLE_CHECKSUM })
        .expect(400);
    });

    it('rejects a style checksum that is not a sha256', async () => {
      await request(harness.server)
        .post('/api/assets/resolve')
        .send({ specs: [SPEC], styleBibleId: ABSENT.style, styleChecksum: 'nope' })
        .expect(400);
    });

    it('reports semantic search as unavailable when no embedding model is configured', async () => {
      const response = await request(harness.server)
        .post('/api/assets/search')
        .send({ query: 'a gnarled old tree' })
        .expect(501);

      // Not a 500: "no embedding provider is configured" is a configuration fact, and
      // the router says so before touching the network.
      expect((response.body as ErrorBody).error.kind).toBe('unsupported');
    });

    it('rejects an empty search query', async () => {
      await request(harness.server).post('/api/assets/search').send({ query: '' }).expect(400);
    });

    it('accepts a similarity floor and a limit on the search', async () => {
      // Still 501 - there is no embedding model - but the optional arguments have to
      // reach the use-case, and the only way to see that is to send them.
      await request(harness.server)
        .post('/api/assets/search')
        .send({ query: 'a gnarled old tree', limit: 3, minSimilarity: 0.8 })
        .expect(501);
    });

    it('404s an asset that does not exist', async () => {
      const response = await request(harness.server).get(`/api/assets/${ABSENT.asset}`).expect(404);
      expect((response.body as ErrorBody).error.context).toMatchObject({ resource: 'asset' });
    });
  });

  describe('episodes and series', () => {
    it('404s an episode that does not exist', async () => {
      await request(harness.server).get(`/api/episodes/${ABSENT.episode}`).expect(404);
    });

    it('404s a series that does not exist', async () => {
      await request(harness.server).get(`/api/series/${ABSENT.series}`).expect(404);
    });

    it('rejects a malformed series id', async () => {
      await request(harness.server).get('/api/series/nope').expect(400);
      await request(harness.server).get('/api/series/nope/episodes').expect(400);
    });
  });

  describe('style', () => {
    it('serves a gallery a client can render, not a list of names', async () => {
      const response = await request(harness.server).get('/api/style/presets').expect(200);
      const body = response.body as {
        presets: {
          id: string;
          name: { fa: string };
          draft: { visual: unknown; motion: unknown };
        }[];
      };

      expect(body.presets.length).toBeGreaterThan(1);
      // The whole point of the shape: a card carries the blocks the gallery *renders*.
      // A list of slugs would force a client to guess or to mint a bible per tile.
      for (const preset of body.presets) {
        expect(preset.name.fa.length).toBeGreaterThan(0);
        expect(preset.draft.visual).toBeTypeOf('object');
        expect(preset.draft.motion).toBeTypeOf('object');
      }
    });

    it('materialises a preset unlocked, then locks it once and refuses the second lock', async () => {
      const created = await request(harness.server)
        .post('/api/style/from-preset')
        .send({ preset: 'paper-cutout' })
        .expect(201);
      const bible = created.body as { id: string; checksum: string; lockedAt: string | null };

      // Unlocked on purpose: locking is a decision a human makes after seeing a probe
      // sheet, and a factory that produced locked documents would let a style reach the
      // image models before anyone had looked at it.
      expect(bible.lockedAt).toBeNull();
      expect(bible.checksum).toMatch(/^[0-9a-f]{64}$/);

      const locked = await request(harness.server)
        .post(`/api/style/${bible.id}/lock`)
        .send({})
        .expect(201);
      const frozen = locked.body as { checksum: string; lockedAt: string | null };
      expect(frozen.lockedAt).not.toBeNull();
      // The checksum is content-derived, so locking an unedited bible cannot move it -
      // which is what makes a probe sheet's checksum a promise the lock keeps.
      expect(frozen.checksum).toBe(bible.checksum);

      // A second lock is a fork, and the domain says so rather than silently re-locking.
      await request(harness.server).post(`/api/style/${bible.id}/lock`).send({}).expect(409);
    });

    it('probes an unlocked candidate rather than demanding a lock first', async () => {
      const created = await request(harness.server)
        .post('/api/style/from-preset')
        .send({ preset: 'paper-cutout' })
        .expect(201);
      const id = (created.body as { id: string }).id;

      // The harness registers no image adapter, so the free lane is unwired. The refusal
      // that matters is *which* one: "no adapter is wired to the free lane" proves the
      // probe got past the lock guard on an unlocked bible, which is the whole product
      // decision. A 400 about the style not being locked would mean it did not.
      const probed = await request(harness.server)
        .post(`/api/style/${id}/probe`)
        .send({ lane: 'free' })
        .expect(400);
      const message = (probed.body as { error: { message: string } }).error.message;
      expect(message).toContain('lane');
      expect(message).not.toContain('not locked');
    });

    it('404s a probe of a style bible that does not exist', async () => {
      await request(harness.server)
        .post(`/api/style/${ABSENT.style}/probe`)
        .send({ lane: 'free' })
        .expect(404);
    });

    it('rejects a preset name that is not a slug before reaching the engine', async () => {
      await request(harness.server)
        .post('/api/style/from-preset')
        .send({ preset: 'Ink Comic' })
        .expect(400);
    });

    it('rejects a derive request with no reference images', async () => {
      await request(harness.server)
        .post('/api/style/derive')
        .send({ brief: {}, referenceHashes: [] })
        .expect(400);
    });
  });

  describe('narrative', () => {
    it('rejects a scene that does not validate before reaching the graph', async () => {
      await request(harness.server)
        .post(`/api/narrative/series/${ABSENT.series}/scenes`)
        .send({ nonsense: true })
        .expect(400);
    });

    it('rejects a retrieval request that does not validate', async () => {
      await request(harness.server).post('/api/narrative/retrieve').send({}).expect(400);
    });
  });

  describe('render', () => {
    it('rejects a render request with no animation IR', async () => {
      await request(harness.server)
        .post('/api/render')
        .send({ formats: ['yt-1080p'], outputDir: './out' })
        .expect(400);
    });

    it('rejects an unknown delivery format', async () => {
      await request(harness.server)
        .post('/api/render')
        .send({ ir: {}, formats: ['vhs-4x3'], outputDir: './out' })
        .expect(400);
    });
  });

  describe('settings', () => {
    it('rejects a malformed projectId on the read', async () => {
      await request(harness.server).get('/api/settings?projectId=nope').expect(400);
    });

    it('rejects a malformed runId on the read', async () => {
      await request(harness.server).get('/api/settings?runId=nope').expect(400);
    });

    it('refuses to write the machine layer at all', async () => {
      // `.env` is not a row. The repository refuses to store a machine layer, so the
      // route never offers the word rather than accepting it and failing later.
      await request(harness.server)
        .put('/api/settings/machine')
        .send({ scope: { projectId: null, runId: null }, set: [], clear: [] })
        .expect(400);
    });

    it('rejects a patch that names a key the registry does not declare', async () => {
      const response = await request(harness.server)
        .put('/api/settings/global')
        .send({
          scope: { projectId: null, runId: null },
          set: [{ key: 'made.up', value: 1 }],
          clear: [],
        })
        .expect(400);
      const body = response.body as { error: { issues?: { path: string; code: string }[] } };
      expect(body.error.issues?.at(0)).toMatchObject({ path: 'made.up', code: 'unknown-key' });
    });
  });
});
