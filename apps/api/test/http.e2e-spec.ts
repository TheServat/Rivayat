/**
 * The HTTP contract, over a real application.
 *
 * `app-error.filter.spec.ts` proves the mapping table row by row against a fake host.
 * This proves the same thing survives the whole stack - the pipe, the interceptor, the
 * filter, express's JSON serialisation - for the statuses a client can actually reach,
 * and that the resource routes do what they say.
 */

import { SETTINGS_REGISTRY } from '@rv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SettingsSnapshot } from '../src/modules/settings/settings.contracts';

import { ABSENT_PROJECT_ID, CREATE_PROJECT, CREATE_SERIES } from './fixtures';
import { bootHarness, type Harness } from './harness';

interface ErrorBody {
  error: {
    code: string;
    kind: string;
    message: string;
    retryable: boolean;
    context: Record<string, unknown>;
    status: number;
    issues?: { path: string; message: string; code: string }[];
  };
}

describe('the HTTP surface', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('health', () => {
    it('answers with the database, the queue driver and the implemented stages', async () => {
      const response = await request(harness.server).get('/api/health').expect(200);
      const body = response.body as {
        status: string;
        database: { location: string; reachable: boolean };
        queue: { driver: string };
        pipeline: {
          implementedStages: string[];
          stubbedStages: string[];
          registeredStages: string[];
        };
      };

      expect(body.status).toBe('ok');
      expect(body.database).toMatchObject({ location: ':memory:', reachable: true });
      expect(body.queue.driver).toBe('in-process');

      // The assertion this replaces was `implementedStages` having length 12, which was
      // true of the *registry* and false of the build: nine of those handlers returned
      // 501. It is the line that put "All twelve stages report as implemented" into
      // docs/05-remaining-work.md. The list is spelled out rather than counted for the
      // same reason: a stage that starts reporting itself implemented has to change this
      // line, which is where somebody reads it.
      // Twelve of twelve, and the count is *earned* rather than restated: every handler
      // in the registry now declares `implemented: true` because it drives a real engine.
      // The list is spelled out rather than counted so that a stage which stops being
      // implemented - a deployment with no Skia binding, an engine pulled out - has to
      // change this line, which is where somebody reads it.
      expect([...body.pipeline.implementedStages].sort()).toEqual([
        'cast',
        'choreograph',
        'deliver',
        'intake',
        'preview',
        'produce',
        'render',
        'resolve',
        'sequence',
        'story',
        'style',
        'world',
      ]);

      // The partition still has to hold. `stubbedStages` being empty is the claim; the
      // line below is what stops it from being empty because the two lists disagree.
      expect(body.pipeline.registeredStages).toHaveLength(12);
      expect(body.pipeline.stubbedStages).toHaveLength(0);
      expect([...body.pipeline.implementedStages, ...body.pipeline.stubbedStages].sort()).toEqual(
        [...body.pipeline.registeredStages].sort(),
      );
    });

    it('fails a stage whose payload is missing with a diagnosis, rather than hanging', async () => {
      // What this used to assert - "a stubbed stage refuses with the package that owes
      // it" - has no subject left: every stage is implemented, `stubbedStages` is empty,
      // and a test that picked a stage at random to prove a stub would be asserting
      // nothing. The *behaviour* it was protecting is still the one that matters and is
      // still reachable: a run that asks for a stage and gives it nothing to work with
      // must settle as `failed` with a diagnosis, not sit in the queue.
      const project = await request(harness.server)
        .post('/api/projects')
        .send({ name: 'Payload check', description: 'A run that asks S6 for nothing.' })
        .expect(201);

      const started = await request(harness.server)
        .post('/api/runs')
        .send({
          projectId: (project.body as { id: string }).id,
          stages: ['produce'],
          seed: 1,
          payload: {},
        })
        .expect(202);

      const runId = (started.body as { id: string }).id;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const run = (await request(harness.server).get(`/api/runs/${runId}`).expect(200)).body as {
          status: string;
          errorCode: string | null;
        };
        if (run.status === 'failed') {
          // A validation failure, naming the payload - not an internal error, and not a
          // 501 about a package that is finished.
          expect(run.errorCode).toBe('VALIDATION_FAILED');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('the stage never settled');
    });
  });

  describe('validation', () => {
    it('rejects a malformed body with a field-level list, not just a message', async () => {
      const response = await request(harness.server)
        .post('/api/projects')
        .send({ name: '', description: 42 })
        .expect(400);

      const body = response.body as ErrorBody;
      expect(body.error.kind).toBe('validation');
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.status).toBe(400);

      const issues = body.error.issues ?? [];
      expect(issues.length).toBeGreaterThanOrEqual(2);
      // Both bad fields, not just the first: a client fixing a twelve-field payload one
      // 400 at a time is a client we made twelve round trips for.
      expect(issues.map((issue) => issue.path).sort()).toEqual(['description', 'name']);
      for (const issue of issues) {
        expect(typeof issue.message).toBe('string');
        expect(typeof issue.code).toBe('string');
      }
    });

    it('rejects a body that is missing a required field', async () => {
      const response = await request(harness.server)
        .post('/api/projects')
        .send({ name: 'no description' })
        .expect(400);
      const body = response.body as ErrorBody;
      expect((body.error.issues ?? []).map((issue) => issue.path)).toContain('description');
    });

    it('rejects a malformed path parameter before the handler runs', async () => {
      const response = await request(harness.server).get('/api/projects/not-an-id').expect(400);
      expect((response.body as ErrorBody).error.kind).toBe('validation');
    });

    it('rejects a run whose stages are out of pipeline order', async () => {
      const response = await request(harness.server)
        .post('/api/runs')
        .send({
          projectId: ABSENT_PROJECT_ID,
          stages: ['render', 'intake'],
          seed: 1,
        })
        .expect(400);

      const issues = (response.body as ErrorBody).error.issues ?? [];
      expect(issues.some((issue) => issue.path === 'stages')).toBe(true);
    });

    it('never leaks a stack trace in an error body', async () => {
      const response = await request(harness.server).post('/api/projects').send({}).expect(400);
      expect(JSON.stringify(response.body)).not.toContain('at Object.');
      expect(response.body).not.toHaveProperty('stack');
      expect(response.body).not.toHaveProperty('error.stack');
    });
  });

  describe('error kinds a client can reach', () => {
    it('404 for a well-formed id that refers to nothing', async () => {
      const response = await request(harness.server)
        .get(`/api/projects/${ABSENT_PROJECT_ID}`)
        .expect(404);

      const body = response.body as ErrorBody;
      expect(body.error.kind).toBe('not-found');
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.context).toMatchObject({ resource: 'project', id: ABSENT_PROJECT_ID });
    });

    it('404 when a series is created under a project that does not exist', async () => {
      // The parent is checked explicitly rather than left to a foreign key, because
      // `runs.project_id` and `episodes.series_id` are bare columns in
      // `@rv/persistence` with no referent - nothing below the controller would catch
      // the orphan.
      const response = await request(harness.server)
        .post(`/api/projects/${ABSENT_PROJECT_ID}/series`)
        .send(CREATE_SERIES)
        .expect(404);
      expect((response.body as ErrorBody).error.kind).toBe('not-found');
    });

    it('501 for a route whose engine package is still a scaffold, naming the package', async () => {
      // `@rv/narrative-memory` is the scaffold this asserts against now; S1 style used to
      // be the example and its package is finished. The taxonomy is the point rather than
      // the route: `unsupported` maps to 501, while `internal` would map to 500 and invite
      // a retry of something that cannot work until the package is written.
      const response = await request(harness.server)
        .get('/api/narrative/episodes/ep_01J0000000000000000000000Z/continuity')
        .expect(501);

      const body = response.body as ErrorBody;
      expect(body.error.kind).toBe('unsupported');
      expect(body.error.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(body.error.context).toMatchObject({ provider: '@rv/narrative-memory' });
      expect(body.error.retryable).toBe(false);
    });

    it('400 with every bad field named, not just the first', async () => {
      const response = await request(harness.server)
        .put('/api/settings/global')
        .send({
          scope: { projectId: null, runId: null },
          set: [
            { key: 'model.qualityTier', value: 'luxurious' },
            { key: 'render.concurrency', value: 9999 },
          ],
          clear: [],
        })
        .expect(400);
      const issues = (response.body as ErrorBody).error.issues ?? [];
      // Both, in one answer: a settings form has to mark every bad field at once, and a
      // validator that stopped at the first turns three mistakes into three round trips.
      expect(issues.map((issue) => issue.path)).toEqual([
        'model.qualityTier',
        'render.concurrency',
      ]);
    });

    it('404 with the same envelope for a route that does not exist at all', async () => {
      const response = await request(harness.server).get('/api/nope').expect(404);
      const body = response.body as ErrorBody;
      expect(body.error.kind).toBe('not-found');
      expect(body.error.status).toBe(404);
    });
  });

  describe('projects and series', () => {
    it('creates, reads, lists and patches a project', async () => {
      const created = await request(harness.server)
        .post('/api/projects')
        .send(CREATE_PROJECT)
        .expect(201);

      const project = created.body as { id: string; name: string; budgetNanoUsd: number | null };
      expect(project.id).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(project.budgetNanoUsd).toBeNull();

      const fetched = await request(harness.server).get(`/api/projects/${project.id}`).expect(200);
      expect((fetched.body as { name: string }).name).toBe(CREATE_PROJECT.name);

      const listed = await request(harness.server).get('/api/projects').expect(200);
      const summaries = (listed.body as { projects: { id: string; locale: string }[] }).projects;
      expect(summaries.some((entry) => entry.id === project.id)).toBe(true);
      // The read model, not the aggregate: a list row carries the spend and the episode
      // count the list screen shows, and not the full description it does not.
      expect(summaries.at(0)).toMatchObject({
        locale: 'fa',
        styleLocked: false,
        episodeCount: 0,
        spentNanoUsd: 0,
      });

      const patched = await request(harness.server)
        .patch(`/api/projects/${project.id}`)
        .send({ name: 'Renamed' })
        .expect(200);
      const after = patched.body as { name: string; description: string };
      expect(after.name).toBe('Renamed');
      // A patch that mentioned one field must not blank the others.
      expect(after.description).toBe(CREATE_PROJECT.description);
    });

    it('creates a series under a project and lists it back', async () => {
      const project = (
        await request(harness.server).post('/api/projects').send(CREATE_PROJECT).expect(201)
      ).body as { id: string };

      const series = (
        await request(harness.server)
          .post(`/api/projects/${project.id}/series`)
          .send(CREATE_SERIES)
          .expect(201)
      ).body as { id: string; projectId: string; hasBible: boolean };

      expect(series.projectId).toBe(project.id);
      expect(series.hasBible).toBe(false);

      const listed = await request(harness.server)
        .get(`/api/projects/${project.id}/series`)
        .expect(200);
      expect(listed.body).toHaveLength(1);

      const episodes = await request(harness.server)
        .get(`/api/series/${series.id}/episodes`)
        .expect(200);
      // A series with no bible has no episodes, and that is an empty list rather than
      // an error - "not planned yet" is a state, not a failure.
      expect(episodes.body).toEqual([]);
    });
  });

  describe('render formats', () => {
    it('serves the verified platform specs without an engine', async () => {
      const response = await request(harness.server).get('/api/render/formats').expect(200);
      const formats = response.body as { id: string; platform: string }[];
      expect(formats.map((format) => format.id)).toContain('shorts-9x16');
      expect(formats.length).toBeGreaterThanOrEqual(7);
    });
  });

  describe('settings', () => {
    /**
     * The response the studio refused before this endpoint served the registry.
     *
     * Parsed with the API's own schema rather than poked at field by field: the studio
     * validates the payload at its boundary and rejects anything that does not fit, so
     * the only assertion worth making here is the one the studio itself makes.
     */
    it('serves the whole registry, resolved, in the shape the studio parses', async () => {
      const response = await request(harness.server).get('/api/settings').expect(200);
      const snapshot = SettingsSnapshot.parse(response.body);

      expect(snapshot.descriptors).toHaveLength(SETTINGS_REGISTRY.length);
      expect(snapshot.values).toHaveLength(SETTINGS_REGISTRY.length);
      expect(snapshot.target).toBe('global');
      // Every value carries the layer it came from - the whole reason the resolver
      // returns a record rather than a value (architecture 7b).
      expect(snapshot.values.every((value) => value.origin.length > 0)).toBe(true);
      // The catalogue is live, so `model-picker` is not a free-text box.
      expect(snapshot.models.length).toBeGreaterThan(0);
    });

    it('reports a secret as present-or-absent and never as a value', async () => {
      const response = await request(harness.server).get('/api/settings').expect(200);
      const snapshot = SettingsSnapshot.parse(response.body);

      const secrets = snapshot.values.flatMap((value) => (value.secret ? [value] : []));
      expect(secrets.length).toBeGreaterThan(0);
      // The harness boots with every credential blank, so every secret is "not set" -
      // and none of them may carry a `value` property at all. `strictObject` on the
      // secret branch is what makes that a parse failure rather than a review comment.
      expect(secrets.every((value) => !value.set)).toBe(true);

      const serialised = JSON.stringify(snapshot);
      expect(serialised).not.toContain('"value":"sk-');
      expect(serialised).not.toContain('authToken":"');
    });

    it('writes a layer and answers with the moved provenance', async () => {
      const before = SettingsSnapshot.parse(
        (await request(harness.server).get('/api/settings').expect(200)).body,
      );
      expect(originOf(before, 'model.qualityTier')).toBe('default');

      const after = SettingsSnapshot.parse(
        (
          await request(harness.server)
            .put('/api/settings/global')
            .send({
              scope: { projectId: null, runId: null },
              set: [{ key: 'model.qualityTier', value: 'final' }],
              clear: [],
            })
            .expect(200)
        ).body,
      );
      expect(originOf(after, 'model.qualityTier')).toBe('global');

      // And it survives a fresh read, which is the half a write that only echoes back
      // its own argument would pass.
      const reread = SettingsSnapshot.parse(
        (await request(harness.server).get('/api/settings').expect(200)).body,
      );
      expect(originOf(reread, 'model.qualityTier')).toBe('global');

      const cleared = SettingsSnapshot.parse(
        (
          await request(harness.server)
            .put('/api/settings/global')
            .send({
              scope: { projectId: null, runId: null },
              set: [],
              clear: ['model.qualityTier'],
            })
            .expect(200)
        ).body,
      );
      // Clearing an override is a different request from storing `null`, and this is
      // the difference: the value falls back to the layer below.
      expect(originOf(cleared, 'model.qualityTier')).toBe('default');
    });

    it('refuses a secret at a scope the descriptor forbids', async () => {
      const response = await request(harness.server)
        .put('/api/settings/global')
        .send({
          scope: { projectId: null, runId: null },
          set: [{ key: 'provider.gemini.apiKey', value: 'sk-nope' }],
          clear: [],
        })
        .expect(400);
      expect((response.body as ErrorBody).error.issues?.at(0)?.code).toBe('secret-scope');
    });
  });
});

/** Which layer a key resolved from, for the provenance assertions above. */
function originOf(snapshot: SettingsSnapshot, key: string): string | undefined {
  return snapshot.values.find((value) => value.key === key)?.origin;
}
