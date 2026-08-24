/**
 * The three things the Render screen could not do, over HTTP.
 *
 * Each is a capability the engine already had and nothing exposed, so each test is
 * really asking the same question: does the studio now have a *route* to it.
 *
 *  1. **Framing.** `POST /api/render/reframe` solves a crop per format from the
 *     composition alone. The gallery rendered seven cards over "framing not solved yet"
 *     because nothing served `buildReframePlans`, which costs microseconds.
 *  2. **Starting.** A composition is stored by content hash and a run names it, so a
 *     browser that has no `AnimationIR` and cannot build one can still begin a render.
 *  3. **Verdict.** `GET /api/runs/:id/delivery` reports what came out - probed, not
 *     asserted - because `render-master:<sha>` cannot tell a user their file is in spec.
 *
 * FFmpeg is needed only for the third: framing and storing touch no encoder.
 */

import { spawn } from 'node:child_process';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunSummary } from '../src/application/resources';
import type { CompositionSummary } from '../src/modules/compositions/compositions.contracts';
import type { RunDelivery } from '../src/render/delivery.contracts';
import type { ReframePlanSet } from '../src/render/reframe.contracts';
import { CREATE_PROJECT } from './fixtures';
import { RENDER_SIZE, heavyIr, renderPayload } from './render-fixtures';
import { bootHarness, type Harness } from './harness';

const FORMATS = ['yt-1080p', 'shorts-9x16', 'ig-4x5'] as const;

let ffmpegAvailable = false;

describe('the render surface', () => {
  let harness: Harness;
  let projectId: string;

  beforeAll(async () => {
    harness = await bootHarness();
    const created = await request(harness.server)
      .post('/api/projects')
      .send(CREATE_PROJECT)
      .expect(201);
    projectId = (created.body as { id: string }).id;

    const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    ffmpegAvailable = await new Promise<boolean>((resolve) => {
      probe.on('error', () => {
        resolve(false);
      });
      probe.on('close', (code) => {
        resolve(code === 0);
      });
    });
    if (!ffmpegAvailable) {
      console.warn('SKIPPING the delivery-manifest test: no runnable ffmpeg on PATH.');
    }
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  // ── framing ───────────────────────────────────────────────────────────────

  describe('POST /api/render/reframe', () => {
    it('solves a crop per format from the composition alone', async () => {
      const response = await request(harness.server)
        .post('/api/render/reframe')
        .send({ ir: heavyIr(21), formats: FORMATS })
        .expect(201);

      const body = response.body as ReframePlanSet;

      // One plan per format asked for, and nothing else - the screen renders a card per
      // entry and an extra one would be a card for a format nobody ships.
      expect(Object.keys(body.plans).sort()).toEqual([...FORMATS].sort());
      expect(body.derivedShots).toBe(true);

      for (const format of FORMATS) {
        const plan = body.plans[format];
        expect(plan, format).toBeDefined();
        if (plan === undefined) continue;

        expect(plan.format).toBe(format);
        expect(plan.shots.length).toBeGreaterThan(0);

        // The crop is what the overlay draws. It has to be inside the composition, or
        // the overlay draws a rectangle off the edge of the frame it is over.
        const crop = plan.shots[0]?.sourceCrop;
        expect(crop).toBeDefined();
        if (crop === undefined) continue;
        expect(crop.x).toBeGreaterThanOrEqual(0);
        expect(crop.y).toBeGreaterThanOrEqual(0);
        expect(crop.x + crop.width).toBeLessThanOrEqual(1.000001);
        expect(crop.y + crop.height).toBeLessThanOrEqual(1.000001);

        // The focus crosshair the screen draws is in target-frame fractions.
        const focus = plan.shots[0]?.focusPoint;
        expect(focus?.x).toBeGreaterThanOrEqual(0);
        expect(focus?.x).toBeLessThanOrEqual(1);
      }
    });

    it('crops a square composition differently for a tall format than for a wide one', async () => {
      // The property that makes the endpoint worth having: one composition, two shapes.
      // Identical crops would mean the solver was ignoring the profile.
      const response = await request(harness.server)
        .post('/api/render/reframe')
        .send({ ir: heavyIr(22), formats: ['yt-1080p', 'shorts-9x16'] })
        .expect(201);

      const body = response.body as ReframePlanSet;
      const wide = body.plans['yt-1080p']?.shots[0]?.sourceCrop;
      const tall = body.plans['shorts-9x16']?.shots[0]?.sourceCrop;

      expect(wide).toBeDefined();
      expect(tall).toBeDefined();
      if (wide === undefined || tall === undefined) return;

      // The source is square, so 16:9 keeps the width and 9:16 keeps the height.
      expect(wide.width / wide.height).toBeGreaterThan(tall.width / tall.height);
    });

    it('says when the shot list was supplied rather than derived', async () => {
      const response = await request(harness.server)
        .post('/api/render/reframe')
        .send({
          ir: heavyIr(23),
          formats: ['yt-1080p'],
          shots: [
            {
              shotId: 'sht_01J0000000000000000000000A',
              startMs: 0,
              durationMs: 3000,
              focusRegion: { x: 0.6, y: 0.1, width: 0.2, height: 0.2 },
            },
          ],
        })
        .expect(201);

      const body = response.body as ReframePlanSet;
      // A client that asked with shots must be able to tell that it was answered with
      // them: "the whole timeline as one shot" is a different claim.
      expect(body.derivedShots).toBe(false);
      expect(body.plans['yt-1080p']?.shots[0]?.shotId).toBe('sht_01J0000000000000000000000A');
    });

    it('refuses a body that names no format, rather than solving nothing', async () => {
      // 400 rather than 422: `STATUS_BY_ERROR_KIND` maps the whole `validation` kind to
      // 400 across this API. RV-184's acceptance line says 422, which is a real
      // divergence and one worth settling in one place rather than per route.
      const response = await request(harness.server)
        .post('/api/render/reframe')
        .send({ ir: heavyIr(24), formats: [] })
        .expect(400);

      const body = response.body as { error: { issues?: { path: string }[] } };
      expect(body.error.issues?.map((issue) => issue.path)).toContain('formats');
    });
  });

  // ── starting ──────────────────────────────────────────────────────────────

  describe('the composition library', () => {
    it('stores a composition by content, and stores it twice for the same id', async () => {
      const first = await request(harness.server)
        .post('/api/compositions')
        .send({ ir: heavyIr(31), label: 'episode one' })
        .expect(200);
      const summary = first.body as CompositionSummary;

      expect(summary.id).toMatch(/^[0-9a-f]{64}$/);
      expect(summary.label).toBe('episode one');
      expect(summary.sceneSpace).toEqual({ ...RENDER_SIZE });
      expect(summary.nodeCount).toBeGreaterThan(0);

      // Idempotent, which is what makes "render this again" safe: the second store
      // finds the first, so the second run finds the first run's frames.
      const again = await request(harness.server)
        .post('/api/compositions')
        .send({ ir: heavyIr(31), label: 'a different label' })
        .expect(200);
      expect((again.body as CompositionSummary).id).toBe(summary.id);
      expect((again.body as CompositionSummary).label).toBe('episode one');

      const listed = await request(harness.server).get('/api/compositions').expect(200);
      const ids = (listed.body as { compositions: CompositionSummary[] }).compositions.map(
        (entry) => entry.id,
      );
      expect(ids).toContain(summary.id);

      const whole = await request(harness.server)
        .get(`/api/compositions/${summary.id}`)
        .expect(200);
      expect((whole.body as { ir: { nodes: unknown[] } }).ir.nodes.length).toBe(summary.nodeCount);
    });

    it('404s a composition nobody stored', async () => {
      await request(harness.server)
        .get(`/api/compositions/${'f'.repeat(64)}`)
        .expect(404);
    });

    it('starts a run from a stored composition, with no IR on the wire', async () => {
      const stored = await request(harness.server)
        .post('/api/compositions')
        .send({ ir: heavyIr(32) })
        .expect(200);
      const compositionId = (stored.body as CompositionSummary).id;

      // The whole point: the run body is a few hundred bytes and names the composition.
      const started = await request(harness.server)
        .post('/api/runs')
        .send({
          projectId,
          stages: ['render'],
          seed: 5,
          payload: { render: { compositionId, size: { ...RENDER_SIZE }, backend: 'napi-canvas' } },
        })
        .expect(202);

      const runId = (started.body as RunSummary).id;
      // Let it get going, then stop it: this test is about the reference resolving, and
      // the encode is covered elsewhere.
      await new Promise((resolve) => setTimeout(resolve, 700));
      await request(harness.server).post(`/api/runs/${runId}/cancel`).expect(202);

      const run = (await request(harness.server).get(`/api/runs/${runId}`).expect(200))
        .body as RunSummary;
      // Cancelled rather than failed: it resolved the composition and was drawing.
      expect(run.status).toBe('cancelled');
    }, 60_000);

    it('fails a run whose composition reference names nothing, with the id in the message', async () => {
      const started = await request(harness.server)
        .post('/api/runs')
        .send({
          projectId,
          stages: ['render'],
          seed: 5,
          payload: { render: { compositionId: 'a'.repeat(64) } },
        })
        .expect(202);

      const runId = (started.body as RunSummary).id;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const run = (await request(harness.server).get(`/api/runs/${runId}`).expect(200))
          .body as RunSummary;
        if (run.status === 'failed') {
          expect(run.errorCode).toBe('VALIDATION_FAILED');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('the run never settled');
    }, 60_000);

    it('refuses a render that names its composition twice, or not at all', async () => {
      const both = await request(harness.server)
        .post('/api/runs')
        .send({
          projectId,
          stages: ['render'],
          seed: 5,
          payload: { render: { ir: heavyIr(33), compositionId: 'a'.repeat(64) } },
        })
        .expect(202);

      // Two sources for one fact is a payload whose meaning depends on resolution
      // order, so the stage refuses rather than choosing.
      const runId = (both.body as RunSummary).id;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const run = (await request(harness.server).get(`/api/runs/${runId}`).expect(200))
          .body as RunSummary;
        if (run.status === 'failed') {
          expect(run.errorCode).toBe('VALIDATION_FAILED');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('the run never settled');
    }, 60_000);
  });

  // ── verdict ───────────────────────────────────────────────────────────────

  describe('GET /api/runs/:id/delivery', () => {
    it('404s a run that has rendered nothing, and says why', async () => {
      const started = await request(harness.server)
        .post('/api/runs')
        .send({ projectId, stages: ['story'], seed: 1, payload: {} })
        .expect(202);
      const runId = (started.body as RunSummary).id;

      const response = await request(harness.server).get(`/api/runs/${runId}/delivery`).expect(404);
      // "This run has no files" and "this run does not exist" are different answers.
      const body = response.body as { error: { context?: { reason?: string } } };
      expect(body.error.context?.reason).toContain('render');
    }, 60_000);

    it('reports the master it produced, measured rather than asserted', async () => {
      if (!ffmpegAvailable) return;

      const started = await request(harness.server)
        .post('/api/runs')
        .send({
          projectId,
          stages: ['render'],
          seed: 9,
          payload: { render: { ...renderPayload(41), keepFrames: false } },
        })
        .expect(202);
      const runId = (started.body as RunSummary).id;

      let run: RunSummary | null = null;
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const current = (await request(harness.server).get(`/api/runs/${runId}`).expect(200))
          .body as RunSummary;
        if (current.status === 'succeeded' || current.status === 'failed') {
          run = current;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(run?.status).toBe('succeeded');

      const delivery = (
        await request(harness.server).get(`/api/runs/${runId}/delivery`).expect(200)
      ).body as RunDelivery;

      expect(delivery.files).toHaveLength(1);
      const master = delivery.files[0];
      expect(master).toBeDefined();
      if (master === undefined) return;

      // Everything the screen needs and `render-master:<sha>` cannot carry.
      expect(master.kind).toBe('master');
      expect(master.codecName).toBe('h264');
      expect(master.size).toEqual({ ...RENDER_SIZE });
      expect(master.bytes).toBeGreaterThan(0);
      expect(master.durationMs).toBeGreaterThan(0);
      expect(master.fps).toBeGreaterThan(0);
      expect(master.path).not.toContain(':');
      expect(master.sha256).toMatch(/^[0-9a-f]{64}$/);

      // The hash is the same one the stage put on the run, so the two views agree.
      const stage = run?.stages.find((entry) => entry.stage === 'render');
      expect(stage?.artifacts).toContain(`render-master:${master.sha256}`);

      // `null`, not `true`: a master is not a platform deliverable, so no profile
      // applies. Claiming it passed would be worse than having no verdict.
      expect(master.inSpec).toBeNull();
      expect(master.format).toBeNull();
      expect(delivery.needsAttention).toBe(false);
    }, 180_000);
  });
});
