/**
 * The Story and Characters screens' routes, over a booted application and no network.
 *
 * The harness registers no provider keys, so every model call fails before a socket is
 * opened. That is exactly the right shape for this suite: the routes that *read* - the
 * outline, the graph, the epistemic view, the state grid - are the ones the two screens
 * are blocked on, and they must work with no provider at all. The routes that *spend*
 * are asserted to refuse in the taxonomy rather than to hang.
 *
 * The distinction the studio's gateways are written around is asserted directly: a 404
 * for a *route* and a 404 for a *thing* are different answers, and a screen that treated
 * the second as the first would quietly report "no data" for a feature nobody wrote.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { bootHarness, type Harness } from './harness';

interface Created {
  readonly id: string;
}

describe('the story surface', () => {
  let harness: Harness;
  let projectId: string;
  let seriesId: string;

  beforeAll(async () => {
    harness = await bootHarness();

    const project = await request(harness.server)
      .post('/api/projects')
      .send({ name: 'The Keeper', description: 'A walled garden and a forbidden well.' })
      .expect(201);
    projectId = (project.body as Created).id;

    const series = await request(harness.server)
      .post(`/api/projects/${projectId}/series`)
      .send({
        title: 'The Keeper of the Well',
        premise: 'A woman has guarded a well for forty years and will not say why.',
      })
      .expect(201);
    seriesId = (series.body as Created).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  // ── the outline ───────────────────────────────────────────────────────────

  it('answers an empty tree for a series nobody has outlined, not a 404', async () => {
    const response = await request(harness.server)
      .get(`/api/series/${seriesId}/outline`)
      .expect(200);

    // The Story screen's empty state is an invitation to build one. A not-found here is
    // indistinguishable, to a client, from a route that does not exist.
    expect(response.body).toMatchObject({ seriesId, nodes: [] });
  });

  it('404s the outline of a series that does not exist', async () => {
    await request(harness.server)
      .get('/api/series/ser_01JQZK3M7X8YB4N2VTC6WPHRDZ/outline')
      .expect(404);
  });

  it('plants the series root from the premise, for free, with no provider configured', async () => {
    const response = await request(harness.server)
      .post(`/api/series/${seriesId}/outline/expand`)
      .send({ level: 'series' })
      .expect(201);

    const body = response.body as { level: string; spentNanoUsd: number; nodes: unknown[] };
    expect(body.level).toBe('series');
    expect(body.spentNanoUsd).toBe(0);
    expect(body.nodes).toHaveLength(1);
  });

  it('refuses a level whose parents do not exist, and says which level to build', async () => {
    const response = await request(harness.server)
      .post(`/api/series/${seriesId}/outline/expand`)
      .send({ level: 'episode' })
      .expect(409);

    expect(
      (response.body as { error: { context: Record<string, unknown> } }).error.context,
    ).toMatchObject({ reason: 'outline-level-skip', parentLevel: 'season' });
  });

  it('has no route that descends more than one level', async () => {
    // The body is one field and there is no `depth`, no `to` and no `/outline/build`.
    // A route that could name a target depth would move the DOC bypass into the
    // transport, where the engine's guard cannot see it.
    await request(harness.server)
      .post(`/api/series/${seriesId}/outline/expand`)
      .send({ level: 'episode', depth: 'beat' })
      .expect(400);

    await request(harness.server).post(`/api/series/${seriesId}/outline/build`).expect(404);
  });

  it('refuses an expansion that needs a model, in the taxonomy, rather than hanging', async () => {
    const response = await request(harness.server)
      .post(`/api/series/${seriesId}/outline/expand`)
      .send({ level: 'season' });

    // No provider keys in the harness, so the router can serve nothing. 501 with the
    // capability named, not a timeout.
    expect(response.status).toBe(501);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      'UNSUPPORTED_CAPABILITY',
    );
  });

  it('edits the series root, keeps the previous version, and 404s an unknown node', async () => {
    const edited = await request(harness.server)
      .patch(`/api/story/nodes/${seriesId}`)
      .send({
        title: 'The Well Keeper',
        summary: 'A rewritten premise, typed by the author, long enough to be prose.',
        children: 'keep',
      })
      .expect(200);

    const node = edited.body as { title: string; roleId: string | null; history: unknown[] };
    expect(node.title).toBe('The Well Keeper');
    // An authored node has no role: the six named roles are model personas, and
    // attributing a human's sentence to one of them corrupts the ledger.
    expect(node.roleId).toBeNull();
    expect(node.history).toHaveLength(1);

    await request(harness.server)
      .patch('/api/story/nodes/does-not-exist')
      .send({ title: 'x', summary: 'y', children: 'keep' })
      .expect(404);
  });

  // ── the series card ───────────────────────────────────────────────────────

  it('lets the author correct the premise the Story screen shows', async () => {
    const patched = await request(harness.server)
      .patch(`/api/series/${seriesId}`)
      .send({ premise: 'A woman guards a well, and the summer is the driest in forty years.' })
      .expect(200);

    expect((patched.body as { premise: string }).premise).toContain('driest in forty years');

    const reread = await request(harness.server).get(`/api/series/${seriesId}`).expect(200);
    expect((reread.body as { premise: string }).premise).toContain('driest in forty years');
  });

  it('refuses a patch that changes nothing', async () => {
    await request(harness.server).patch(`/api/series/${seriesId}`).send({}).expect(400);
  });

  // ── the graph ─────────────────────────────────────────────────────────────

  it('answers an empty snapshot for a series with no world model', async () => {
    const response = await request(harness.server).get(`/api/series/${seriesId}/graph`).expect(200);

    expect(response.body).toMatchObject({
      seriesId,
      entities: [],
      relations: [],
      storyMarks: [],
      revisions: [],
    });
  });

  it('404s a viewer the series does not hold', async () => {
    await request(harness.server)
      .get(`/api/series/${seriesId}/entities/ent_01JQZK3M7X8YB4N2VTC6WPHRDZ/view`)
      .expect(404);
  });

  it('rejects a malformed standpoint rather than standing somewhere arbitrary', async () => {
    await request(harness.server)
      .get(`/api/series/${seriesId}/entities/ent_01JQZK3M7X8YB4N2VTC6WPHRDZ/view?asOf=yesterday`)
      .expect(400);
  });

  // ── the state grid ────────────────────────────────────────────────────────

  it('answers an empty grid for a character S3 has not reached', async () => {
    const response = await request(harness.server)
      .get(`/api/series/${seriesId}/entities/ent_01JQZK3M7X8YB4N2VTC6WPHRDY/states`)
      .expect(200);

    expect(response.body).toMatchObject({ identityFloor: 0.82, cells: [] });
  });

  it('404s a cell that does not exist, and refuses a variant key that could not exist', async () => {
    await request(harness.server)
      .patch(`/api/series/${seriesId}/entities/ent_01JQZK3M7X8YB4N2VTC6WPHRDY/states/nope`)
      .send({ prompt: 'A different prompt, typed by an art director.' })
      .expect(404);

    // Not a `Slug`, so it is half of a dedup key nothing could ever have been generated
    // under. Refused here rather than 404ed later.
    await request(harness.server)
      .patch(`/api/series/${seriesId}/entities/ent_01JQZK3M7X8YB4N2VTC6WPHRDY/states/Not A Slug`)
      .send({ prompt: 'A different prompt, typed by an art director.' })
      .expect(400);
  });

  // ── the health report stays honest ────────────────────────────────────────

  it('reports the three stages as implemented, and the report stays total', async () => {
    const health = await request(harness.server).get('/api/health').expect(200);
    const pipeline = (
      health.body as {
        pipeline: {
          implementedStages: string[];
          stubbedStages: string[];
          registeredStages: string[];
        };
      }
    ).pipeline;

    expect(pipeline.implementedStages).toEqual(expect.arrayContaining(['story', 'cast', 'world']));
    // And not in both lists, which is the failure `StageHandler.implemented` exists to
    // prevent: "all twelve stages report as implemented" went into a document other
    // agents worked from, about a build where nine of them returned 501.
    expect(pipeline.stubbedStages).not.toEqual(expect.arrayContaining(['story', 'cast', 'world']));
    expect([...pipeline.implementedStages, ...pipeline.stubbedStages].sort()).toEqual(
      [...pipeline.registeredStages].sort(),
    );
  });
});
