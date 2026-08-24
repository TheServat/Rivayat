/**
 * S6 Produce and the asset surface, over the real application, at $0.
 *
 * Every assertion here is about a property the wiring can silently lose, and none of
 * them are about the chain itself - `@rv/asset-engine` owns that and tests it against
 * real diffusion output.
 *
 * 1. **Resolve first, spend second.** An unapproved batch returns the estimate having
 *    made **zero** provider calls. Asserted on the *call count* of a fake image port,
 *    not on the reported cost: a test that only checked the number would pass on an
 *    implementation that paid for the call and then reported zero.
 * 2. **No asset is generated twice.** Producing the same specs again registers nothing
 *    and calls nobody - the second run's plan is all cache hits. The deliberate second
 *    take goes through `POST /assets/:id/regenerate`, and today that route refuses
 *    before spending, for a reason two packages own between them; the test that says so
 *    is written to fail when the reason goes away.
 * 3. **The screens have data.** `GET /assets`, `GET /assets/demand/plan`,
 *    `GET /assets/:id/versions/:vid/produce` and `GET /blobs/:hash` all answer with
 *    something the studio can render, including the bytes behind a content hash.
 */

import type { AssetSpec, StyleBible } from '@rv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PRODUCE_LANES } from '../src/modules/module-tokens';
import { bootHarness, type Harness } from './harness';
import { CountingImagePort, countingLanes } from './produce-fixtures';

/**
 * One prop, one part, 128px.
 *
 * A prop rather than a character because that is the subject class the local
 * parts-sheet lane routes (research §3: SD 1.5 collapses a character sheet into a
 * costume turnaround), and one part because the fake generator draws one blob - the
 * splitter finding what the spec planned is the interesting agreement.
 */
const SPEC: AssetSpec = {
  semanticKey: 'prop/wick-key/brass',
  archetype: 'rigid-prop',
  subjectClass: 'prop',
  label: 'Brass wick key',
  description: 'A small worn brass wick key, one solid piece, seen flat from the side.',
  tags: [],
  canvas: { width: 128, height: 128 },
  nominalHeight: 64,
  parts: [
    {
      name: 'body',
      role: 'root',
      description: 'The whole key',
      zOrder: 0,
      deformable: false,
      optional: false,
    },
  ],
  variants: [],
  references: [],
  quality: 'draft',
  requireAlpha: true,
};

interface RunSummaryBody {
  readonly id: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly stages: { readonly stage: string; readonly artifacts: string[] }[];
}

async function settle(harness: Harness, runId: string): Promise<RunSummaryBody> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const run = (await request(harness.server).get(`/api/runs/${runId}`).expect(200))
      .body as RunSummaryBody;
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the produce run never settled');
}

describe('S6 produce and the asset surface', () => {
  let harness: Harness;
  let images: CountingImagePort;
  let projectId: string;
  let style: StyleBible;

  beforeAll(async () => {
    images = new CountingImagePort();
    harness = await bootHarness({
      override: (builder) =>
        builder.overrideProvider(PRODUCE_LANES).useValue(countingLanes(images)),
    });

    const project = await request(harness.server)
      .post('/api/projects')
      .send({ name: 'Produce', description: 'One prop, produced twice.' })
      .expect(201);
    projectId = (project.body as { id: string }).id;

    // Choose, then lock. The probe is skipped here on purpose - there is no image lane
    // wired to the *style* engine in this harness - and `modules.e2e-spec.ts` covers the
    // probe path separately.
    const created = await request(harness.server)
      .post('/api/style/from-preset')
      .send({ preset: 'paper-cutout' })
      .expect(201);
    const locked = await request(harness.server)
      .post(`/api/style/${(created.body as { id: string }).id}/lock`)
      .send({})
      .expect(201);
    style = locked.body as StyleBible;
  });

  afterAll(async () => {
    await harness.close();
  });

  async function produce(approved: boolean): Promise<RunSummaryBody> {
    const started = await request(harness.server)
      .post('/api/runs')
      .send({
        projectId,
        stages: ['produce'],
        seed: 11,
        payload: {
          produce: {
            specs: [SPEC],
            styleBibleId: style.id,
            approved,
            concurrency: 1,
            bake: { clips: ['idle'], frames: 4 },
          },
        },
      })
      .expect(202);
    return settle(harness, (started.body as { id: string }).id);
  }

  it('returns the estimate and makes no provider call when the batch is not approved', async () => {
    const before = images.calls;
    const run = await produce(false);

    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('VALIDATION_FAILED');
    // The whole of non-negotiable #3 on this stage: the number exists and nothing was
    // spent producing it.
    expect(images.calls).toBe(before);
  });

  it('produces, registers and lists an asset once it is approved', async () => {
    const run = await produce(true);
    expect(run.status).toBe('succeeded');
    expect(images.calls).toBe(1);

    const produceStage = run.stages.find((stage) => stage.stage === 'produce');
    expect(produceStage?.artifacts.some((artifact) => artifact.startsWith('asset-version:'))).toBe(
      true,
    );

    const listed = await request(harness.server).get('/api/assets').expect(200);
    const page = listed.body as {
      assets: {
        id: string;
        key: string;
        keyParts: { styleChecksum: string; specHash: string };
        currentVersionId: string;
        partCount: number;
        versionCount: number;
      }[];
      total: number;
      incomplete: unknown[];
    };

    expect(page.total).toBe(1);
    const entry = page.assets[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    // The four components of the dedup key, as stored. They are the only thing you can
    // diff when a cache miss happens that should not have.
    expect(entry.keyParts.styleChecksum).toBe(style.checksum);
    expect(entry.keyParts.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.partCount).toBeGreaterThan(0);
    expect(entry.versionCount).toBe(1);
    expect(page.incomplete).toEqual([]);
  });

  it('serves the bytes behind a part hash, sniffing the media type from the bytes', async () => {
    const listed = await request(harness.server).get('/api/assets').expect(200);
    const assetId = (listed.body as { assets: { id: string }[] }).assets[0]?.id;
    expect(assetId).toBeDefined();
    if (assetId === undefined) return;

    const asset = await request(harness.server).get(`/api/assets/${assetId}`).expect(200);
    const hash = (asset.body as { versions: { parts: { imageHash: string }[] }[] }).versions[0]
      ?.parts[0]?.imageHash;
    expect(hash).toBeDefined();
    if (hash === undefined) return;

    const blob = await request(harness.server).get(`/api/blobs/${hash}`).expect(200);
    // Sniffed rather than declared: the store addresses bytes and records nothing about
    // them, and the bytes cannot be wrong about what they are.
    expect(blob.headers['content-type']).toContain('image/png');
    expect(blob.headers['cache-control']).toContain('immutable');
  });

  it('404s a hash that is not in the store, rather than 500ing', async () => {
    await request(harness.server)
      .get(`/api/blobs/${'0'.repeat(64)}`)
      .expect(404);
  });

  it('spends nothing on a second run over the same specs', async () => {
    const before = images.calls;
    const run = await produce(true);

    expect(run.status).toBe('succeeded');
    // The dedup key resolved to a registered version, so the plan had nothing to do and
    // the port was never reached. This is non-negotiable #2, measured.
    expect(images.calls).toBe(before);
    const stage = run.stages.find((entry) => entry.stage === 'produce');
    expect(stage?.artifacts.some((artifact) => artifact.startsWith('asset-reused:'))).toBe(true);
  });

  it('prices the recorded demand at zero once the library holds it', async () => {
    const planned = await request(harness.server).get('/api/assets/demand/plan').expect(200);
    const plan = planned.body as {
      hitCount: number;
      missCount: number;
      totalEstimatedNanoUsd: number;
    };

    // The number non-negotiable #2 exists to produce, on the screen it shows up on.
    expect(plan.hitCount).toBe(1);
    expect(plan.missCount).toBe(0);
    expect(plan.totalEstimatedNanoUsd).toBe(0);
  });

  it('answers the two-segment plan route rather than parsing `demand` as an asset id', async () => {
    // The bug this guards: `@Get(':id')` matches any single segment, so `/assets/plan`
    // came back 400 about a malformed AssetId and the screen blamed the server.
    await request(harness.server).get('/api/assets/plan').expect(400);
    await request(harness.server).get('/api/assets/demand/plan').expect(200);
  });

  it('reports where a take stopped, step by step', async () => {
    const listed = await request(harness.server).get('/api/assets').expect(200);
    const entry = (listed.body as { assets: { id: string; currentVersionId: string }[] }).assets[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const report = await request(harness.server)
      .get(`/api/assets/${entry.id}/versions/${entry.currentVersionId}/produce`)
      .expect(200);
    const body = report.body as {
      steps: { step: string; outcome: string }[];
      failedStep?: string;
      versionId?: string;
    };

    expect(body.versionId).toBe(entry.currentVersionId);
    expect(body.steps).toHaveLength(8);
    expect(body.steps.map((step) => step.step)).toEqual([
      'generate',
      'matte',
      'split',
      'score',
      'rig',
      'clips',
      'bake',
      'register',
    ]);
    // `score` was never reached - no vision model is wired - and `not-reached` is a real
    // state rather than a synonym for failure.
    expect(body.steps.find((step) => step.step === 'score')?.outcome).toBe('not-reached');
    expect(body.steps.find((step) => step.step === 'register')?.outcome).toBe('ran');
    expect(body.failedStep).toBeUndefined();
  });

  /**
   * The state of regeneration today, asserted rather than described.
   *
   * The route, the intent handling and the append are all wired and correct - what stops
   * a second take is two upstream facts meeting: clip ids are content-derived (so an
   * unchanged spec derives the same ids) and `clips.id` is a per-version primary key. See
   * `clipCollision` in `regenerate-asset.use-case.ts`.
   *
   * This test is written so that it **fails when the constraint is fixed**, which is the
   * point: the day `clips` is keyed `(version_id, id)`, whoever does it is sent here and
   * the assertion becomes the happy path that is written out beneath it.
   */
  it('refuses a second take that would collide on a content-addressed clip id, spending nothing', async () => {
    const listed = await request(harness.server).get('/api/assets').expect(200);
    const entry = (listed.body as { assets: { id: string; currentVersionId: string }[] }).assets[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const before = images.calls;
    const refused = await request(harness.server)
      .post(`/api/assets/${entry.id}/regenerate`)
      .send({ reason: 'new-take', keepPrevious: true, projectId })
      .expect(409);

    const body = refused.body as {
      error: { kind: string; context: { collidingVersionId?: string } };
    };
    // A conflict, not a 500 carrying a SQL string: the caller can act on "this asset
    // already has clips with these ids", and cannot act on a constraint name.
    expect(body.error.kind).toBe('conflict');
    expect(body.error.context.collidingVersionId).toBe(entry.currentVersionId);

    // Refused *before* the image was generated. The guard is worth nothing if it costs a
    // generation to reach.
    expect(images.calls).toBe(before);

    // And the previous version is untouched, which is the invariant the whole route
    // exists to protect.
    const asset = await request(harness.server).get(`/api/assets/${entry.id}`).expect(200);
    expect((asset.body as { versions: unknown[] }).versions).toHaveLength(1);
  });

  it('refuses a regeneration whose asset does not exist', async () => {
    await request(harness.server)
      .post('/api/assets/ast_01J0000000000000000000000Z/regenerate')
      .send({ reason: 'new-take', keepPrevious: true, projectId })
      .expect(404);
  });

  it('refuses a regeneration that tries to be destructive', async () => {
    const listed = await request(harness.server).get('/api/assets').expect(200);
    const entry = (listed.body as { assets: { id: string }[] }).assets[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    // `keepPrevious` is `z.literal(true)` in the contract precisely so that an attempt to
    // turn regeneration into an overwrite is a visible diff rather than a silent one.
    await request(harness.server)
      .post(`/api/assets/${entry.id}/regenerate`)
      .send({ reason: 'new-take', keepPrevious: false, projectId })
      .expect(400);
  });
});
