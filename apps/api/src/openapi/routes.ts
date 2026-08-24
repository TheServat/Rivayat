/**
 * The route table the OpenAPI document is generated from.
 *
 * It is a separate declaration from the controllers, which is a cost worth naming: two
 * places can disagree. The alternatives were worse. Reading routes off Nest's metadata
 * needs `design:paramtypes` for the body type, which esbuild does not emit;
 * `@nestjs/swagger`'s CLI plugin needs the TypeScript compiler API and a build step
 * that the test runner does not have. A table typed against `API_SCHEMAS` at least
 * makes half the drift impossible - a schema that does not exist will not compile - and
 * `openapi.spec.ts` closes the other half by asserting every declared path is routable
 * on the live app.
 */

import type { ApiSchemaName } from './schema-registry';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteParam {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly required: boolean;
  readonly description: string;
  /** A primitive JSON Schema. Path parameters are always strings on the wire. */
  readonly schema: Record<string, unknown>;
}

export interface ApiRoute {
  readonly method: HttpMethod;
  /** OpenAPI path template, without the global prefix. */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly params?: readonly RouteParam[];
  readonly requestBody?: ApiSchemaName;
  readonly status: number;
  /** Absent for a 204 or a stream. */
  readonly response?: ApiSchemaName;
  /** True while the port behind it is a stub, so a client knows before it integrates. */
  readonly notImplemented?: boolean;
}

const idParam = (name: string, description: string): RouteParam => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});

export const API_ROUTES: readonly ApiRoute[] = [
  {
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    summary: 'Wiring, database reachability, provider availability and queue driver.',
    tags: ['health'],
    status: 200,
    response: 'HealthReport',
  },

  // ── projects ──────────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/projects',
    operationId: 'createProject',
    summary: 'Create a project.',
    tags: ['projects'],
    requestBody: 'CreateProjectRequest',
    status: 201,
    response: 'Project',
  },
  {
    method: 'get',
    path: '/projects',
    operationId: 'listProjects',
    summary: 'Every project, as the list screen needs them.',
    tags: ['projects'],
    status: 200,
    response: 'ProjectList',
  },
  {
    method: 'get',
    path: '/projects/{id}',
    operationId: 'getProject',
    summary: 'One project.',
    tags: ['projects'],
    params: [idParam('id', 'Project id, `prj_<ULID>`.')],
    status: 200,
    response: 'Project',
  },
  {
    method: 'patch',
    path: '/projects/{id}',
    operationId: 'updateProject',
    summary: 'Update a project. Identity and creation time are not mutable.',
    tags: ['projects'],
    params: [idParam('id', 'Project id, `prj_<ULID>`.')],
    requestBody: 'UpdateProjectRequest',
    status: 200,
    response: 'Project',
  },

  // ── series and episodes ───────────────────────────────────────────────────
  {
    method: 'post',
    path: '/projects/{projectId}/series',
    operationId: 'createSeries',
    summary: 'Create a series inside a project.',
    tags: ['series'],
    params: [idParam('projectId', 'Project id, `prj_<ULID>`.')],
    requestBody: 'CreateSeriesRequest',
    status: 201,
    response: 'SeriesCard',
  },
  {
    method: 'get',
    path: '/projects/{projectId}/series',
    operationId: 'listSeries',
    summary: 'Every series in a project.',
    tags: ['series'],
    params: [idParam('projectId', 'Project id, `prj_<ULID>`.')],
    status: 200,
    response: 'SeriesCard',
  },
  {
    method: 'get',
    path: '/series/{id}',
    operationId: 'getSeries',
    summary: 'One series.',
    tags: ['series'],
    params: [idParam('id', 'Series id, `ser_<ULID>`.')],
    status: 200,
    response: 'SeriesCard',
  },
  {
    method: 'get',
    path: '/series/{seriesId}/episodes',
    operationId: 'listEpisodes',
    summary: 'Episode outlines for a series, in airing order.',
    tags: ['episodes'],
    params: [idParam('seriesId', 'Series id, `ser_<ULID>`.')],
    status: 200,
    response: 'EpisodeOutline',
  },
  {
    method: 'get',
    path: '/episodes/{id}',
    operationId: 'getEpisode',
    summary: 'One episode outline; acts carry scene ids, not scene bodies.',
    tags: ['episodes'],
    params: [idParam('id', 'Episode id, `ep_<ULID>`.')],
    status: 200,
    response: 'EpisodeOutline',
  },

  // ── style (S1) ────────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/style/presets',
    operationId: 'listStylePresets',
    summary: 'Curated style preset names.',
    tags: ['style'],
    status: 501,
    notImplemented: true,
  },
  {
    method: 'post',
    path: '/style/from-preset',
    operationId: 'styleFromPreset',
    summary: 'Build a style bible from a preset.',
    tags: ['style'],
    requestBody: 'FromPresetBody',
    status: 501,
    response: 'StyleBible',
    notImplemented: true,
  },
  {
    method: 'post',
    path: '/style/derive',
    operationId: 'deriveStyle',
    summary: 'Derive a style bible from reference images.',
    tags: ['style'],
    requestBody: 'DeriveStyleBody',
    status: 501,
    response: 'StyleBible',
    notImplemented: true,
  },
  {
    method: 'post',
    path: '/style/{id}/lock',
    operationId: 'lockStyle',
    summary: 'Freeze the checksum. Every asset dedup key depends on it.',
    tags: ['style'],
    params: [idParam('id', 'Style bible id, `sty_<ULID>`.')],
    status: 501,
    response: 'StyleBible',
    notImplemented: true,
  },

  // ── assets (S5) ───────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/assets/resolve',
    operationId: 'resolveAssetDemand',
    summary: 'S5: what the library already has, and what the rest would cost.',
    tags: ['assets'],
    requestBody: 'ResolveAssetsBody',
    status: 201,
    response: 'AssetDemandPlan',
  },
  {
    method: 'post',
    path: '/assets/search',
    operationId: 'searchAssets',
    summary: 'Semantic search. Find it before you make it.',
    tags: ['assets'],
    requestBody: 'SearchAssetsBody',
    status: 201,
  },
  {
    method: 'get',
    path: '/assets/{id}',
    operationId: 'getAsset',
    summary: 'One asset, with its versions.',
    tags: ['assets'],
    params: [idParam('id', 'Asset id, `ast_<ULID>`.')],
    status: 200,
    response: 'Asset',
  },

  // ── narrative ─────────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/narrative/series/{seriesId}/scenes',
    operationId: 'ingestScene',
    summary: 'Fold a scene into the bi-temporal graph and report contradictions.',
    tags: ['narrative'],
    params: [idParam('seriesId', 'Series id, `ser_<ULID>`.')],
    requestBody: 'Scene',
    status: 501,
    notImplemented: true,
  },
  {
    method: 'get',
    path: '/narrative/episodes/{episodeId}/continuity',
    operationId: 'checkContinuity',
    summary: 'Unresolved continuity issues in an episode subtree.',
    tags: ['narrative'],
    params: [idParam('episodeId', 'Episode id, `ep_<ULID>`.')],
    status: 501,
    notImplemented: true,
  },
  {
    method: 'post',
    path: '/narrative/retrieve',
    operationId: 'retrieveMemory',
    summary: 'Budgeted retrieval over the narrative graph.',
    tags: ['narrative'],
    requestBody: 'MemoryRetrievalRequest',
    status: 501,
    notImplemented: true,
  },

  // ── pipeline ──────────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/runs',
    operationId: 'startRun',
    summary: 'Start a pipeline run. 202: the record exists, the work is queued.',
    tags: ['pipeline'],
    requestBody: 'StartRunBody',
    status: 202,
    response: 'RunSummary',
  },
  {
    method: 'get',
    path: '/runs/{id}',
    operationId: 'getRun',
    summary: 'One run, with its per-stage results.',
    tags: ['pipeline'],
    params: [idParam('id', 'Run id, `run_<ULID>`.')],
    status: 200,
    response: 'RunSummary',
  },
  {
    method: 'get',
    path: '/runs/{id}/delivery',
    operationId: 'getRunDelivery',
    summary:
      'What the run put on disk, probed: size, duration, codec, pixel format, frame ' +
      'rate, hash, and the verdict against each platform spec.',
    tags: ['pipeline'],
    params: [idParam('id', 'Run id, `run_<ULID>`.')],
    status: 200,
    response: 'RunDelivery',
  },
  {
    method: 'get',
    path: '/runs/{id}/ledger',
    operationId: 'getRunLedger',
    summary: 'Every provider call this run made, and the four cost summaries.',
    tags: ['pipeline'],
    params: [idParam('id', 'Run id, `run_<ULID>`.')],
    status: 200,
    response: 'CostLedger',
  },
  {
    method: 'post',
    path: '/runs/{id}/cancel',
    operationId: 'cancelRun',
    summary: 'Stop a run inside its current stage, aborting in-flight provider calls.',
    tags: ['pipeline'],
    params: [idParam('id', 'Run id, `run_<ULID>`.')],
    status: 202,
    response: 'RunSummary',
  },
  {
    method: 'post',
    path: '/runs/{id}/resume',
    operationId: 'resumeRun',
    summary:
      'Re-queue a failed or orphaned run from its last checkpoint. 409 for a run that ' +
      'succeeded or was cancelled - both are terminal, and a new run reuses the ' +
      'checkpoints anyway.',
    tags: ['pipeline'],
    params: [idParam('id', 'Run id, `run_<ULID>`.')],
    status: 202,
    response: 'RunSummary',
  },
  {
    method: 'get',
    path: '/runs/{id}/events',
    operationId: 'streamRunEvents',
    summary:
      'Server-sent events: stage progress, cost as it accrues, completion. Honours ' +
      '`Last-Event-ID`; sends a heartbeat every 15 s so a proxy does not drop the stream.',
    tags: ['pipeline'],
    params: [
      idParam('id', 'Run id, `run_<ULID>`.'),
      {
        name: 'Last-Event-ID',
        in: 'query',
        required: false,
        description:
          'Sequence number of the last event received. Set automatically by EventSource ' +
          'as a header on reconnect; also accepted here for clients that cannot.',
        schema: { type: 'integer', minimum: 0 },
      },
    ],
    status: 200,
    response: 'RunEvent',
  },
  {
    method: 'get',
    path: '/projects/{projectId}/cost',
    operationId: 'getProjectCost',
    summary:
      'What a project - or one series in it - has cost, per run, per stage, per ' +
      'provider, and per delivered minute.',
    tags: ['pipeline'],
    params: [
      idParam('projectId', 'Project id, `prj_<ULID>`.'),
      {
        name: 'seriesId',
        in: 'query',
        required: false,
        description: 'Narrows the report to one series. Omit for the whole project.',
        schema: { type: 'string' },
      },
    ],
    status: 200,
    response: 'CostReport',
  },
  {
    method: 'get',
    path: '/projects/{projectId}/runs',
    operationId: 'listProjectRuns',
    summary: 'Every run of a project.',
    tags: ['pipeline'],
    params: [idParam('projectId', 'Project id, `prj_<ULID>`.')],
    status: 200,
    response: 'RunSummary',
  },

  // ── render ────────────────────────────────────────────────────────────────
  // ── compositions ──────────────────────────────────────────────────────────
  {
    method: 'post',
    path: '/compositions',
    operationId: 'storeComposition',
    summary:
      'Store an AnimationIR by content hash. 200, not 201: the id *is* the content, so ' +
      'storing the same composition twice finds the first one rather than making a second.',
    tags: ['compositions'],
    requestBody: 'StoreCompositionBody',
    status: 200,
    response: 'CompositionSummary',
  },
  {
    method: 'get',
    path: '/compositions',
    operationId: 'listCompositions',
    summary: 'Every stored composition, newest first. Summaries only - an IR is megabytes.',
    tags: ['compositions'],
    status: 200,
    response: 'CompositionList',
  },
  {
    method: 'get',
    path: '/compositions/{id}',
    operationId: 'getComposition',
    summary: 'One composition, whole, for the renderer and the player.',
    tags: ['compositions'],
    params: [idParam('id', 'The composition content hash, 64 hex characters.')],
    status: 200,
    response: 'StoredComposition',
  },

  {
    method: 'post',
    path: '/render/reframe',
    operationId: 'reframeComposition',
    summary:
      'Solve a crop per shot per format from the composition alone. No render, no ' +
      'encoder, no cost - reframing is computed, not re-authored.',
    tags: ['render'],
    requestBody: 'ReframeBody',
    status: 201,
    response: 'ReframePlanSet',
  },
  {
    method: 'get',
    path: '/render/formats',
    operationId: 'listFormatProfiles',
    summary: 'Verified delivery format specs (research §7).',
    tags: ['render'],
    status: 200,
    response: 'FormatProfile',
  },
  {
    method: 'post',
    path: '/render/deliveries',
    operationId: 'startDelivery',
    summary:
      'Cut every requested format from a master that already exists. 202: the run is ' +
      'queued. Costs nothing - a delivery calls no provider.',
    tags: ['render'],
    requestBody: 'StartDeliveryBody',
    status: 202,
    response: 'RunSummary',
  },
  {
    method: 'post',
    path: '/render',
    operationId: 'startRender',
    summary: 'S10/S11: IR to master to per-format reframes.',
    tags: ['render'],
    requestBody: 'RenderBody',
    status: 501,
    notImplemented: true,
  },

  // ── settings ──────────────────────────────────────────────────────────────
  {
    method: 'get',
    path: '/settings',
    operationId: 'getSettings',
    summary:
      'The whole setting registry, resolved for a scope, with the layer each value came from.',
    tags: ['settings'],
    params: [
      {
        name: 'projectId',
        in: 'query',
        required: false,
        description: 'Resolve through this project’s override layer.',
        schema: { type: 'string' },
      },
      {
        name: 'runId',
        in: 'query',
        required: false,
        description: 'Resolve through this run’s override layer.',
        schema: { type: 'string' },
      },
    ],
    status: 200,
    response: 'SettingsSnapshot',
  },
  {
    method: 'put',
    path: '/settings/{scope}',
    operationId: 'writeSettings',
    summary: 'Write one settings layer and answer with the refreshed snapshot.',
    tags: ['settings'],
    params: [
      idParam('scope', 'The layer to write: `global`, `project` or `run`. Never `machine`.'),
    ],
    requestBody: 'SettingsPatch',
    status: 200,
    response: 'SettingsSnapshot',
  },

  // ── the document itself ───────────────────────────────────────────────────
  {
    method: 'get',
    path: '/openapi.json',
    operationId: 'getOpenApiDocument',
    summary: 'This document, emitted from the same Zod schemas the API validates with.',
    tags: ['meta'],
    status: 200,
  },
];
