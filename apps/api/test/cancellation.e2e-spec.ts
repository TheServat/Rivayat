/**
 * `POST /api/runs/:id/cancel`, against a stage that is really working.
 *
 * Two properties, and they fail in different directions.
 *
 * **Distinguishable.** A cancelled run is a decision and a failed run is a defect. If
 * they collapse, the operator cannot tell "I stopped this" from "this broke" - and the
 * one query they actually run, "show me the failed runs", answers with both. The old
 * repository stored `cancelled` as `failed` in the indexed column and kept the truth in
 * `metadata.status`, so the index answered wrongly; `runs.state` now carries all six
 * states and this asserts on what a client can see.
 *
 * **Prompt.** A run that finishes its current stage before noticing was not cancelled,
 * it was delayed. The unit-level proof is in `pipeline-runner.spec.ts`, which measures
 * the gap in units of work; this is the same property over HTTP against the real S10
 * handler, where a unit of work is one frame and the stage has thousands of
 * milliseconds left to run when the cancel lands.
 *
 * No FFmpeg: the encode is the only part of a render that needs the binary, and a
 * cancelled render never reaches it. `$0`, because rendering is local compute and no
 * provider is configured.
 */

import { existsSync, readdirSync } from 'node:fs';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunSummary } from '../src/application/resources';
import { RenderStagePayload, renderKey } from '../src/render/render-stage.contracts';
import { renderLayout } from '../src/render/render-stage.handler';
import { RENDER_FRAMES, renderPayload } from './render-fixtures';
import { CREATE_PROJECT } from './fixtures';
import { bootHarness, type Harness } from './harness';

/** Roughly a frame at this fixture's size, measured in `render-fixtures.ts`. */
const MS_PER_FRAME = 19;

describe('cancelling a run that is really working', () => {
  let harness: Harness;
  let projectId: string;

  beforeAll(async () => {
    harness = await bootHarness();
    const created = await request(harness.server)
      .post('/api/projects')
      .send(CREATE_PROJECT)
      .expect(201);
    projectId = (created.body as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  function framesOf(variant: number): readonly string[] {
    const payload = RenderStagePayload.parse(renderPayload(variant));
    const layout = renderLayout(
      harness.config.paths.workspaceDir,
      renderKey(payload),
      payload.codec,
    );
    if (!existsSync(layout.frames)) return [];
    return readdirSync(layout.frames).filter((name) => name.endsWith('.rvf'));
  }

  async function startRender(variant: number): Promise<string> {
    const started = await request(harness.server)
      .post('/api/runs')
      .send({
        projectId,
        stages: ['render'],
        seed: 42,
        payload: { render: renderPayload(variant) },
      })
      .expect(202);
    return (started.body as RunSummary).id;
  }

  /** Resolves once the render has started drawing, so the cancel lands mid-stage. */
  async function waitForFrames(variant: number, count: number): Promise<number> {
    const deadline = performance.now() + 30_000;
    for (;;) {
      const present = framesOf(variant).length;
      if (present >= count) return present;
      if (performance.now() > deadline) return present;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('stops within a frame of the request, and records a cancellation rather than a failure', async () => {
    const variant = 11;
    const runId = await startRender(variant);

    const drawnAtCancel = await waitForFrames(variant, 10);
    expect(drawnAtCancel).toBeGreaterThanOrEqual(10);
    expect(drawnAtCancel).toBeLessThan(RENDER_FRAMES);

    const requestedAt = performance.now();
    const response = await request(harness.server).post(`/api/runs/${runId}/cancel`).expect(202);
    const cancelled = response.body as RunSummary;

    // Watch until the frame count stops moving, and record *when* it last moved -
    // not how long the test waited afterwards. A fixed sleep would report its own
    // duration and call it latency.
    let drawn = framesOf(variant).length;
    let lastGrewAt = performance.now();
    for (let quiet = 0; quiet < 40; quiet += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const now = framesOf(variant).length;
      if (now !== drawn) {
        drawn = now;
        lastGrewAt = performance.now();
        quiet = 0;
      }
    }

    const drawnAfter = drawn - drawnAtCancel;
    const noticedMs = Math.max(0, lastGrewAt - requestedAt);
    const wouldHaveTakenMs = (RENDER_FRAMES - drawnAtCancel) * MS_PER_FRAME;

    console.info(
      `HTTP cancel: last frame written ${noticedMs.toFixed(0)} ms after the request, ` +
        `${String(drawnAfter)} further frame(s); the stage had ` +
        `${String(RENDER_FRAMES - drawnAtCancel)} frames (~${String(wouldHaveTakenMs)} ms) ` +
        `left to run`,
    );

    // The whole claim: the signal is checked between frames, so the render stops
    // within a frame or two of the request rather than after the stage.
    expect(drawnAfter).toBeLessThanOrEqual(2);
    expect(noticedMs).toBeLessThan(wouldHaveTakenMs / 2);

    // Distinguishable, in the response and on re-read.
    expect(cancelled.status).toBe('cancelled');
    const reread = (await request(harness.server).get(`/api/runs/${runId}`).expect(200))
      .body as RunSummary;
    expect(reread.status).toBe('cancelled');
    expect(reread.status).not.toBe('failed');
    expect(reread.errorCode).toBe('CANCELLED');
    expect(reread.finishedAt).not.toBeNull();

    // And the stage that was interrupted says so too, rather than being recorded as a
    // failure or left absent.
    const stage = reread.stages.find((entry) => entry.stage === 'render');
    expect(stage?.status).toBe('cancelled');

    // Nothing was spent, and no artefact was produced: the encode never ran.
    expect(reread.spentNanoUsd).toBe(0);
    expect(stage?.artifacts).toEqual([]);

    const ledger = (await request(harness.server).get(`/api/runs/${runId}/ledger`).expect(200))
      .body as { records: unknown[]; summary: { total: { costNanoUsd: number } } };
    expect(ledger.records).toEqual([]);
    expect(ledger.summary.total.costNanoUsd).toBe(0);
  }, 120_000);

  it('refuses to resume a cancelled run, and a new run continues from its frames', async () => {
    const variant = 12;
    const runId = await startRender(variant);
    const drawnAtCancel = await waitForFrames(variant, 12);
    await request(harness.server).post(`/api/runs/${runId}/cancel`).expect(202);
    await new Promise((resolve) => setTimeout(resolve, 250));

    // `cancelled` is terminal - `PIPELINE_STATUS_TRANSITIONS` gives it no outgoing
    // edges, because re-running finished work is a new run and a replay that
    // overwrites the record cannot be compared against it.
    const refused = await request(harness.server).post(`/api/runs/${runId}/resume`).expect(409);
    expect((refused.body as { error: { kind: string } }).error.kind).toBe('conflict');

    // Nothing is lost by starting again, which is the substance of RV-187's "resumed
    // continues from the last checkpoint": the render checkpoint is keyed by the
    // *content* being rendered, so a new run finds the frames the cancelled one drew.
    const second = await startRender(variant);
    const drawnAfterRestart = await waitForFrames(variant, drawnAtCancel + 1);
    expect(drawnAfterRestart).toBeGreaterThan(drawnAtCancel);

    await request(harness.server).post(`/api/runs/${second}/cancel`).expect(202);
    await new Promise((resolve) => setTimeout(resolve, 250));

    // The second run drew *new* frames rather than starting from zero, which is only
    // possible if it read the first run's checkpoint.
    const stage = (
      (await request(harness.server).get(`/api/runs/${second}`).expect(200)).body as RunSummary
    ).stages.find((entry) => entry.stage === 'render');
    expect(stage?.status).toBe('cancelled');
  }, 180_000);

  it('refuses to cancel a run twice, and 404s one that does not exist', async () => {
    const variant = 13;
    const runId = await startRender(variant);
    await waitForFrames(variant, 2);
    await request(harness.server).post(`/api/runs/${runId}/cancel`).expect(202);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const again = await request(harness.server).post(`/api/runs/${runId}/cancel`).expect(409);
    expect((again.body as { error: { kind: string } }).error.kind).toBe('conflict');

    await request(harness.server)
      .post('/api/runs/run_01J0000000000000000000000Z/resume')
      .expect(404);
  });
});
