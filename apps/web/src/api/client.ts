import type { RunId } from '@rv/contracts';

import { FixtureTransport } from './fixtures/fixture-transport';
import { ProjectList } from './schemas/pending-contracts';
import {
  type SettingsPatch,
  type SettingsScopeRef,
  SettingsSnapshot,
  type WritableSettingsScope,
} from './schemas/settings';
import { HttpTransport, type StudioTransport } from './transport';

/**
 * Every call the studio makes, in one typed surface.
 *
 * Each method names the schema its response must satisfy, and `transport.send`
 * validates against it before resolving. There is no path by which an unvalidated
 * payload reaches a store: the schema is a required field of the request, not an
 * option a caller can forget.
 */
export class StudioApi {
  readonly transport: StudioTransport;

  constructor(transport: StudioTransport) {
    this.transport = transport;
  }

  listProjects(signal?: AbortSignal): Promise<ProjectList> {
    return this.transport.send({
      method: 'GET',
      path: '/projects',
      schema: ProjectList,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  loadSettings(scope: SettingsScopeRef, signal?: AbortSignal): Promise<SettingsSnapshot> {
    const query = new URLSearchParams();
    if (scope.projectId !== null) query.set('projectId', scope.projectId);
    if (scope.runId !== null) query.set('runId', scope.runId);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.transport.send({
      method: 'GET',
      path: `/settings${suffix}`,
      schema: SettingsSnapshot,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Writes one layer, named in the path.
   *
   * `PUT /settings/:scope` rather than `PATCH /settings`, because the layer is a
   * property of the *request*, not of each entry: one submission is one all-or-nothing
   * write against one layer. A patch that spread itself across layers could be
   * half-applied, leaving the machine in a state the user never chose and cannot see.
   * The response is the refreshed snapshot, because a write changes provenance as well
   * as values and a client that guessed which rows moved would guess wrong.
   */
  saveSettings(
    scope: WritableSettingsScope,
    patch: SettingsPatch,
    signal?: AbortSignal,
  ): Promise<SettingsSnapshot> {
    return this.transport.send({
      method: 'PUT',
      path: `/settings/${scope}`,
      schema: SettingsSnapshot,
      body: patch,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** SSE endpoint for a run's progress, or `null` when the transport has no stream. */
  runStreamUrl(runId: RunId): string | null {
    return this.transport.eventSourceUrl(`/runs/${runId}/events`);
  }
}

/**
 * Chooses a transport from the environment.
 *
 * `fixture` is opt-in and visible: the shell shows a badge for it, so a screen served
 * from recorded payloads is labelled as one. The default is `http`, because a build
 * that quietly falls back to fixtures when the API is down is a build that reports
 * success for a broken deployment.
 */
export function createTransport(
  env: Pick<ImportMetaEnv, 'VITE_RV_TRANSPORT' | 'VITE_RV_API_BASE_URL'> = import.meta.env,
): StudioTransport {
  if (env.VITE_RV_TRANSPORT === 'fixture') return new FixtureTransport();
  return new HttpTransport(env.VITE_RV_API_BASE_URL ?? '/api');
}

let singleton: StudioApi | undefined;

/** The application-wide client. Stores call this; tests construct their own instead. */
export function useStudioApi(): StudioApi {
  singleton ??= new StudioApi(createTransport());
  return singleton;
}

/** Replaces the singleton. For tests and for the e2e harness only. */
export function setStudioApi(api: StudioApi | undefined): void {
  singleton = api;
}
