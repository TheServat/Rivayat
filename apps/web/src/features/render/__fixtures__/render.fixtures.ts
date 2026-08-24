/**
 * Doubles for the render screen's tests.
 *
 * The format payload is **not** invented: it is `FORMAT_PRESETS` from `@rv/contracts`,
 * the same object the API serves from `GET /api/render/formats`. A hand-written copy
 * of seven platform specs is a second table that drifts, and drift in exactly this
 * table is what the whole screen exists to prevent.
 *
 * The run and cost payloads are shaped from a live capture against `apps/api` on
 * 2026-08-23 rather than from the schema's defaults, so a test that passes here is
 * testing against what the server actually sends.
 */

import { FORMAT_PRESETS } from '@rv/contracts';

import { ApiError } from '../../../api/errors';
import type { StudioTransport, TransportRequest } from '../../../api/transport';
import type { RunSummary } from '../render-wire';

export const FORMAT_PAYLOAD = Object.values(FORMAT_PRESETS);

export const PROJECT_ID = 'prj_0DEM0GR0VE0000000000000001';
export const SERIES_ID = 'ser_0DEM0GR0VE0000000000000002';

export const PROJECT_PAYLOAD = {
  projects: [
    {
      id: PROJECT_ID,
      name: 'حکایت‌های باغ انار',
      locale: 'fa',
      styleBibleId: 'sty_0DEM0GR0VE0000000000000003',
      styleLocked: true,
      episodeCount: 1,
      spentNanoUsd: 0,
      updatedAt: '2026-08-23T16:26:35.063Z',
    },
  ],
};

/** A run in whatever state the test needs, with the fields the API really sends. */
export function runFixture(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run_01M0QZHAN8BCTP6WMZNQP587ZK',
    projectId: PROJECT_ID,
    seriesId: SERIES_ID,
    status: 'running',
    requestedStages: ['render', 'deliver'],
    currentStage: 'render',
    stages: [
      {
        stage: 'render',
        status: 'running',
        costNanoUsd: 0,
        durationMs: 0,
        artifacts: [],
        errorCode: null,
        inputHash: '31f3efc225d01e7363324e4588c4355adc5b1e2b8118370b6d989447f05298fa',
        deliveredMs: null,
      },
    ],
    seed: 7,
    budgetNanoUsd: null,
    spentNanoUsd: 0,
    errorCode: null,
    startedAt: '2026-08-23T18:53:40.903Z',
    finishedAt: null,
    ...overrides,
  };
}

export function costFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
    seriesId: null,
    runs: [
      {
        runId: 'run_01M0QZHAN8BCTP6WMZNQP587ZK',
        seriesId: SERIES_ID,
        status: 'succeeded',
        startedAt: '2026-08-23T18:53:40.903Z',
        finishedAt: '2026-08-23T18:57:10.000Z',
        deliveredMs: 90_000,
        costNanoUsd: 1_500_000_000,
        nanoUsdPerDeliveredMinute: 1_000_000_000,
        byStage: {},
        byProvider: {},
      },
    ],
    summary: {
      total: {
        calls: 12,
        failures: 0,
        inputTokens: 4200,
        outputTokens: 900,
        images: 6,
        costNanoUsd: 1_500_000_000,
      },
      byProvider: {},
      byModel: {},
      byTask: {},
      byStage: {},
    },
    deliveredMs: 90_000,
    nanoUsdPerDeliveredMinute: 1_000_000_000,
    updatedAt: '2026-08-23T19:00:00.000Z',
    ...overrides,
  };
}

/** What a route should do: answer with a payload, or refuse. */
export type StubRoute = { readonly payload: unknown } | { readonly error: ApiError };

/**
 * A transport that answers only the routes a test names.
 *
 * Anything else is a 404 rather than a silent `undefined`, because "this screen called
 * an endpoint the test did not expect" is a finding, not a detail. Payloads still go
 * through the real schema: a fixture that drifts from the contract fails here.
 */
export function stubTransport(routes: Readonly<Record<string, StubRoute>>): StudioTransport {
  return {
    kind: 'http',
    eventSourceUrl: (path: string): string => `http://test.invalid/api${path}`,
    send: async <T>(request: TransportRequest<T>): Promise<T> => {
      await Promise.resolve();
      const [path = ''] = request.path.split('?');
      const route = routes[path];
      if (route === undefined) {
        throw new ApiError({
          failure: 'api',
          code: 'stub-route-missing',
          kind: 'not-found',
          status: 404,
          message: `no stub for ${request.method} ${path}`,
        });
      }
      if ('error' in route) throw route.error;
      return request.schema.parse(route.payload);
    },
  };
}

export function apiFailure(code: string, message: string): ApiError {
  return new ApiError({
    failure: 'api',
    code,
    kind: 'internal',
    status: 500,
    message,
    retryable: true,
  });
}

/**
 * Re-exported so the render specs keep one import, while the double itself lives in
 * `src/test/` where any screen watching a run can reach it.
 */
export { FakeEventSource } from '../../../test/fake-event-source';
