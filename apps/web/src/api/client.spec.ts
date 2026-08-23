import type { ProjectId, RunId } from '@rv/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createTransport, setStudioApi, StudioApi, useStudioApi } from './client';
import { ApiError } from './errors';
import { FixtureTransport } from './fixtures/fixture-transport';
import { SETTINGS_REGISTRY, type SettingValue, type SettingsSnapshot } from './schemas/settings';
import type { StudioTransport, TransportRequest } from './transport';

const PROJECT: ProjectId = 'prj_01JQZK3M7X8YB4N2VTC6WPHRDE';
const RUN: RunId = 'run_01JQZM5P9R7S2T4V6W8X0Y1Z3A';

/** Records what the client asked for, then answers with whatever the test supplies. */
function recorder(answer: (request: TransportRequest<unknown>) => unknown): {
  transport: StudioTransport;
  calls: { method: string; path: string; body?: unknown }[];
} {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const transport: StudioTransport = {
    kind: 'http',
    send: (request) => {
      calls.push({ method: request.method, path: request.path, body: request.body });
      return Promise.resolve(request.schema.parse(answer(request as TransportRequest<unknown>)));
    },
    eventSourceUrl: (path) => `http://api.test${path}`,
  };
  return { transport, calls };
}

const emptySnapshot = {
  scope: { projectId: null, runId: null },
  target: 'global',
  descriptors: [],
  values: [],
  models: [],
  warnings: [],
};

describe('StudioApi request shaping', () => {
  it('omits the query string entirely for the global scope', async () => {
    const { transport, calls } = recorder(() => emptySnapshot);
    await new StudioApi(transport).loadSettings({ projectId: null, runId: null });
    expect(calls[0]?.path).toBe('/settings');
  });

  it('carries the project and run in the query when the scope is narrower', async () => {
    const { transport, calls } = recorder(() => emptySnapshot);
    await new StudioApi(transport).loadSettings({ projectId: PROJECT, runId: RUN });
    expect(calls[0]?.path).toBe(`/settings?projectId=${PROJECT}&runId=${RUN}`);
  });

  /**
   * The layer is in the path, not in each entry.
   *
   * One submission is one all-or-nothing write against one layer; a patch that spread
   * itself across layers could be half-applied. `PUT /settings/:scope` is what makes
   * that structural rather than a convention the client is trusted to follow.
   */
  it('sends a patch as the body of a PUT against the named layer', async () => {
    const { transport, calls } = recorder(() => emptySnapshot);
    const patch = {
      scope: { projectId: null, runId: null },
      set: [{ key: 'model.qualityTier', value: 'final' }],
      clear: ['budget.perDayNanoUsd'],
    };
    await new StudioApi(transport).saveSettings('run', patch);

    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.path).toBe('/settings/run');
    expect(calls[0]?.body).toEqual(patch);
  });

  it('builds the run stream URL from the transport', () => {
    const { transport } = recorder(() => emptySnapshot);
    expect(new StudioApi(transport).runStreamUrl(RUN)).toBe(`http://api.test/runs/${RUN}/events`);
  });

  it('reports no stream when the transport has none', () => {
    expect(new StudioApi(new FixtureTransport()).runStreamUrl(RUN)).toBeNull();
  });
});

describe('transport selection', () => {
  it('talks HTTP by default, so a missing API is a visible failure', () => {
    expect(createTransport({}).kind).toBe('http');
  });

  it('serves fixtures only when asked explicitly', () => {
    expect(createTransport({ VITE_RV_TRANSPORT: 'fixture' }).kind).toBe('fixture');
  });

  it('shares one client across the application', () => {
    setStudioApi(undefined);
    expect(useStudioApi()).toBe(useStudioApi());
    setStudioApi(new StudioApi(new FixtureTransport()));
  });
});

describe('the fixture transport', () => {
  it('answers a route it does not have with a not-found rather than silence', async () => {
    const transport = new FixtureTransport();
    const failure = await transport
      .send({ method: 'GET', path: '/nope', schema: z.unknown() })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({ code: 'fixture-route-missing', kind: 'not-found' });
  });

  it('serves the whole registry, resolved, and validates it on the way out', async () => {
    const snapshot = await new StudioApi(new FixtureTransport()).loadSettings({
      projectId: null,
      runId: null,
    });
    expect(snapshot.descriptors).toHaveLength(SETTINGS_REGISTRY.length);
    expect(snapshot.values).toHaveLength(SETTINGS_REGISTRY.length);
    expect(snapshot.target).toBe('global');
  });

  /**
   * The stack follows the request, the way the API's does.
   *
   * A global view that showed a run override would make the screen a liar about the
   * layer it is editing - "set here" would be true of a layer the save never touches.
   */
  it('widens the stack and the write target as the scope narrows', async () => {
    const api = new StudioApi(new FixtureTransport());

    const global = await api.loadSettings({ projectId: null, runId: null });
    expect(global.target).toBe('global');
    expect(valueOf(global, 'model.qualityTier')).toMatchObject({ origin: 'global' });

    const scoped = await api.loadSettings({ projectId: PROJECT, runId: RUN });
    expect(scoped.target).toBe('run');
    expect(valueOf(scoped, 'model.qualityTier')).toMatchObject({
      origin: 'run',
      shadowed: ['global'],
    });
    expect(valueOf(scoped, 'image.lane')).toMatchObject({ origin: 'project' });
  });

  it('refuses a patch its own registry rejects, naming every bad field', async () => {
    const failure = await new StudioApi(new FixtureTransport())
      .saveSettings('global', {
        scope: { projectId: null, runId: null },
        set: [
          { key: 'render.concurrency', value: 999 },
          { key: 'provider.gemini.apiKey', value: 'nope' },
        ],
        clear: [],
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).issues.map((issue) => issue.path).toSorted()).toEqual([
      'provider.gemini.apiKey',
      'render.concurrency',
    ]);
  });
});

/** Reads one resolved setting out of a snapshot, for the assertions above. */
function valueOf(snapshot: SettingsSnapshot, key: string): SettingValue | undefined {
  return snapshot.values.find((value) => value.key === key);
}
