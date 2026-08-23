/**
 * A run, end to end, with no Redis and no network.
 *
 * "The app runs with no infrastructure" is the stated local-first constraint, and the
 * only way to hold it is to make the suite that proves everything else run that way
 * too: `REDIS_URL` is blank in the harness, so every test in this file executes on the
 * in-process queue. If the in-process driver breaks, this file goes red, not a separate
 * test nobody runs.
 *
 * The run used throughout is `[intake, resolve]` - the two stages that have engine-free
 * implementations. It exercises the whole machine: enqueue, execute, checkpoint, chain
 * to the next stage, complete the run, close the stream.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunSummary } from '../src/application/resources';
import { ABSENT_RUN_ID, CREATE_PROJECT, IDEA_BRIEF } from './fixtures';
import { bootHarness, type Harness } from './harness';

/** Polls the run resource until it is terminal, or gives up loudly. */
async function settle(harness: Harness, runId: string, timeoutMs = 8000): Promise<RunSummary> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const response = await request(harness.server).get(`/api/runs/${runId}`).expect(200);
    const run = response.body as RunSummary;
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      return run;
    }
    if (performance.now() > deadline) {
      throw new Error(`run ${runId} never settled; last status ${run.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createProject(harness: Harness): Promise<string> {
  const created = await request(harness.server)
    .post('/api/projects')
    .send(CREATE_PROJECT)
    .expect(201);
  return (created.body as { id: string }).id;
}

describe('the pipeline, in process', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('runs a job to completion with REDIS_URL empty', async () => {
    expect(harness.config.queue.driver).toBe('in-process');
    const projectId = await createProject(harness);

    const started = await request(harness.server)
      .post('/api/runs')
      .send({
        projectId,
        stages: ['intake'],
        seed: 7,
        payload: { brief: IDEA_BRIEF },
      })
      .expect(202);

    const queued = started.body as RunSummary;
    expect(queued.status).toMatch(/queued|running|succeeded/);
    expect(queued.seed).toBe(7);

    const finished = await settle(harness, queued.id);
    expect(finished.status).toBe('succeeded');
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.currentStage).toBeNull();
    expect(finished.stages).toHaveLength(1);
    expect(finished.stages[0]).toMatchObject({ stage: 'intake', status: 'succeeded' });
    expect(finished.stages[0]?.artifacts).toEqual(['brief:idea']);
  });

  it('chains one stage to the next and records each', async () => {
    const projectId = await createProject(harness);

    const started = await request(harness.server)
      .post('/api/runs')
      .send({
        projectId,
        stages: ['intake', 'resolve'],
        seed: 7,
        payload: { brief: IDEA_BRIEF },
      })
      .expect(202);

    const finished = await settle(harness, (started.body as RunSummary).id);

    // S5 cannot run without a style bible and specs, and says so rather than pretending
    // to succeed on nothing. The run therefore fails *at resolve*, with S0 recorded as
    // done - which is exactly the checkpoint a resumed run would read.
    expect(finished.status).toBe('failed');
    expect(finished.errorCode).toBe('UNSUPPORTED_CAPABILITY');
    expect(finished.stages.map((stage) => stage.stage)).toEqual(['intake', 'resolve']);
    expect(finished.stages.find((stage) => stage.stage === 'intake')?.status).toBe('succeeded');
    expect(finished.stages.find((stage) => stage.stage === 'resolve')?.status).toBe('failed');
  });

  it('fails a run whose brief does not validate, before any stage after intake', async () => {
    const projectId = await createProject(harness);

    const started = await request(harness.server)
      .post('/api/runs')
      .send({
        projectId,
        stages: ['intake', 'resolve'],
        seed: 7,
        payload: { brief: { kind: 'idea' } },
      })
      .expect(202);

    const finished = await settle(harness, (started.body as RunSummary).id);
    expect(finished.status).toBe('failed');
    expect(finished.errorCode).toBe('VALIDATION_FAILED');
    // `resolve` never ran: a stage list is a sequence, not a set.
    expect(finished.stages.map((stage) => stage.stage)).toEqual(['intake']);
  });

  it('reports a stage whose engine is a scaffold rather than hanging', async () => {
    const projectId = await createProject(harness);

    const started = await request(harness.server)
      .post('/api/runs')
      .send({ projectId, stages: ['story'], seed: 1, payload: {} })
      .expect(202);

    const finished = await settle(harness, (started.body as RunSummary).id);
    expect(finished.status).toBe('failed');
    expect(finished.errorCode).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('serves an empty ledger for a run that spent nothing, rather than a 404', async () => {
    const projectId = await createProject(harness);
    const started = await request(harness.server)
      .post('/api/runs')
      .send({ projectId, stages: ['intake'], seed: 1, payload: { brief: IDEA_BRIEF } })
      .expect(202);
    const runId = (started.body as RunSummary).id;
    await settle(harness, runId);

    const ledger = await request(harness.server).get(`/api/runs/${runId}/ledger`).expect(200);
    const body = ledger.body as {
      projectId: string;
      records: unknown[];
      summary: { total: { costNanoUsd: number } };
    };

    expect(body.projectId).toBe(projectId);
    expect(body.records).toEqual([]);
    // CI recording zero cost is an assertion, not a coincidence: no adapter is
    // registered, so nothing could have been spent.
    expect(body.summary.total.costNanoUsd).toBe(0);
  });

  it('lists a project’s runs', async () => {
    const projectId = await createProject(harness);
    await request(harness.server)
      .post('/api/runs')
      .send({ projectId, stages: ['intake'], seed: 1, payload: { brief: IDEA_BRIEF } })
      .expect(202);

    const listed = await request(harness.server).get(`/api/projects/${projectId}/runs`).expect(200);
    expect((listed.body as RunSummary[]).length).toBe(1);
  });

  it('404s a run that does not exist', async () => {
    await request(harness.server).get(`/api/runs/${ABSENT_RUN_ID}`).expect(404);
    await request(harness.server).get(`/api/runs/${ABSENT_RUN_ID}/ledger`).expect(404);
    await request(harness.server).post(`/api/runs/${ABSENT_RUN_ID}/cancel`).expect(404);
  });

  it('refuses to cancel a run that has already finished', async () => {
    const projectId = await createProject(harness);
    const started = await request(harness.server)
      .post('/api/runs')
      .send({ projectId, stages: ['intake'], seed: 1, payload: { brief: IDEA_BRIEF } })
      .expect(202);
    const runId = (started.body as RunSummary).id;
    await settle(harness, runId);

    const response = await request(harness.server).post(`/api/runs/${runId}/cancel`).expect(409);
    const body = response.body as { error: { kind: string } };
    expect(body.error.kind).toBe('conflict');
  });
});
