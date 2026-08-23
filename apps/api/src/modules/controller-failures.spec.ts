/**
 * What every controller does when the thing beneath it fails.
 *
 * The e2e suites cover the happy path and the 404, because those are what a client
 * reaches. What they cannot reach is a storage failure - `:memory:` SQLite does not
 * fall over on request - and that is exactly the branch where an error is most likely
 * to be swallowed and turned into a 200 with an empty body.
 *
 * So the repositories here are fakes that fail, and the assertion is always the same:
 * the failure comes back as a `Result` the interceptor will throw and the filter will
 * map, never as a value.
 */

import {
  Ids,
  SETTINGS_REGISTRY,
  type EpisodeId,
  type ProjectId,
  type RunId,
  type SeriesId,
} from '@rv/contracts';
import type { AssetRepository } from '@rv/asset-registry';
import type { DatabaseHandle } from '@rv/persistence';
import { createDatabase } from '@rv/persistence';
import { layer, loadMachineLayer, type SettingsRepository } from '@rv/settings';
import {
  FixedClock,
  InternalError,
  UNIT,
  err,
  instant,
  isErr,
  ok,
  type Result,
} from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import type {
  EpisodeRepository,
  ProjectRepository,
  RunRepository,
  SeriesRepository,
  StyleBibleReader,
} from '../application/ports/repository.ports';
import type { AppConfig } from '../config/app-config';
import { loadConfig } from '../config/app-config';
import type { CostService } from '../cost/cost.service';
import {
  StubNarrativeMemory,
  StubRenderEngine,
  StubStyleEngine,
} from '../infrastructure/engines/stub.adapters';
import type { AdapterSet } from '../infrastructure/providers/build-adapters';
import type { PipelineRunner } from '../pipeline/pipeline-runner.service';
import type { JobQueue } from '../queue/job-queue.port';
import { AssetsController } from './assets/assets.controller';
import { EpisodesController } from './episodes/episodes.controller';
import { HealthController } from './health/health.controller';
import { NarrativeController } from './narrative/narrative.controller';
import { PipelineController } from './pipeline/pipeline.controller';
import { ProjectsController } from './projects/projects.controller';
import { RenderController } from './render/render.controller';
import { SeriesController } from './series/series.controller';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { StyleController } from './style/style.controller';

const PROJECT = 'prj_01J0000000000000000000000A' as ProjectId;
const SERIES = 'ser_01J0000000000000000000000A' as SeriesId;
const EPISODE = 'ep_01J0000000000000000000000A' as EpisodeId;
const RUN = 'run_01J0000000000000000000000A' as RunId;

const clock = new FixedClock(instant(1_700_000_000_000));
const ids = new Ids();

/** Every method fails the same way, which is all these tests need. */
function failing<T extends object>(): T {
  const boom = (): Promise<Result<never>> =>
    Promise.resolve(err(new InternalError({ message: 'storage is on fire' })));
  return new Proxy({} as T, { get: () => boom });
}

function config(): AppConfig {
  const parsed = loadConfig({ NODE_ENV: 'test', RV_DB_URL: ':memory:' });
  if (isErr(parsed)) throw parsed.error;
  return parsed.value;
}

async function expectFailure(promise: Promise<Result<unknown>>): Promise<void> {
  const outcome = await promise;
  expect(isErr(outcome)).toBe(true);
  if (!isErr(outcome)) return;
  // Propagated, not translated: the controller adds nothing it does not know.
  expect(outcome.error.kind).toBe('internal');
}

describe('controllers propagate a storage failure rather than reporting success', () => {
  it('projects', async () => {
    const controller = new ProjectsController(
      failing<ProjectRepository>(),
      clock,
      ids,
      failing<SeriesRepository>(),
      failing<EpisodeRepository>(),
      failing<RunRepository>(),
      failing<StyleBibleReader>(),
    );
    await expectFailure(controller.findOne(PROJECT));
    await expectFailure(controller.list());
    await expectFailure(controller.update(PROJECT, { name: 'x' }));
    await expectFailure(controller.create({ name: 'a', description: 'b', budgetNanoUsd: null }));
  });

  it('series', async () => {
    const controller = new SeriesController(
      failing<SeriesRepository>(),
      failing<ProjectRepository>(),
      clock,
      ids,
    );
    await expectFailure(controller.findOne(SERIES));
    await expectFailure(controller.list(PROJECT));
    // The parent lookup fails first, so the create must not proceed to the write.
    await expectFailure(controller.create(PROJECT, { title: 'T', premise: 'P' }));
  });

  it('episodes', async () => {
    const controller = new EpisodesController(failing<EpisodeRepository>());
    await expectFailure(controller.findOne(EPISODE));
    await expectFailure(controller.list(SERIES));
  });

  it('assets', async () => {
    const controller = new AssetsController(failing(), failing(), failing<AssetRepository>());
    await expectFailure(controller.findOne('ast_01J0000000000000000000000A'));
  });

  it('runs', async () => {
    const controller = new PipelineController(
      failing<PipelineRunner>(),
      failing<RunRepository>(),
      failing<CostService>(),
    );
    await expectFailure(controller.findOne(RUN));
    await expectFailure(controller.listForProject(PROJECT));
    // The run has to be read before the ledger can be scoped to its project.
    await expectFailure(controller.ledger(RUN));
  });

  it('settings', async () => {
    const controller = new SettingsController(
      new SettingsService(failing<SettingsRepository>(), loadMachineLayer({}), clock),
    );
    await expectFailure(controller.view(undefined, undefined));
    await expectFailure(
      controller.write('global', { scope: { projectId: null, runId: null }, set: [], clear: [] }),
    );
  });
});

describe('controllers over a scaffolded engine refuse in the taxonomy', () => {
  /** The four routes an e2e request cannot reach with a body a schema will accept. */
  it('narrative ingest, retrieve and continuity', async () => {
    const controller = new NarrativeController(new StubNarrativeMemory());
    const outcomes: Result<unknown>[] = [
      await controller.ingest(SERIES, undefined as never),
      await controller.retrieve(undefined as never),
      await controller.continuity(EPISODE),
    ];

    for (const outcome of outcomes) {
      expect(isErr(outcome)).toBe(true);
      if (!isErr(outcome)) continue;
      expect(outcome.error.kind).toBe('unsupported');
      expect(outcome.error.context.provider).toBe('@rv/narrative-memory');
    }
  });

  it('render start', async () => {
    const controller = new RenderController(new StubRenderEngine());
    const outcome = await controller.start({
      ir: undefined as never,
      formats: ['yt-1080p'],
      outputDir: './out',
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context.provider).toBe('@rv/render-engine');
  });

  it('render formats needs no engine at all', () => {
    const outcome = new RenderController(new StubRenderEngine()).formats();
    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;
    // `FORMAT_PRESETS` is verified data in `@rv/contracts`, not something an engine
    // computes, so this route works today and will not change when one lands.
    expect(outcome.value.map((format) => format.id)).toContain('tiktok-9x16');
  });

  it('style derive', async () => {
    const controller = new StyleController(new StubStyleEngine());
    const outcome = await controller.derive({
      brief: undefined as never,
      referenceHashes: ['a'.repeat(64)],
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context.provider).toBe('@rv/style-engine');
  });
});

describe('the settings snapshot', () => {
  /**
   * A repository that answers, so the resolution path is exercised rather than the
   * failure path. It holds whatever the caller stored at the global layer, which is
   * what gives the snapshot a non-default origin to report.
   */
  function repository(stored: Record<string, unknown>): SettingsRepository {
    return {
      loadLayer: (ref) => Promise.resolve(ok(layer(ref.scope, stored, ref.scopeId))),
      loadStack: () => Promise.resolve(ok([layer('global', stored, null)])),
      save: () => Promise.resolve(ok(UNIT)),
      clear: () => Promise.resolve(ok(UNIT)),
      list: () => Promise.resolve(ok([])),
    };
  }

  function service(
    stored: Record<string, unknown> = {},
    env: Record<string, string> = {},
  ): SettingsService {
    return new SettingsService(repository(stored), loadMachineLayer(env), clock);
  }

  it('serves every declared setting, with the layer each value came from', async () => {
    const snapshot = await service({ 'model.qualityTier': 'final' }).snapshot({
      projectId: null,
      runId: null,
    });
    if (isErr(snapshot)) throw snapshot.error;

    // Every registry entry, not a subset: a client that had to merge a partial payload
    // against its own idea of the registry would be a client with its own registry.
    expect(snapshot.value.descriptors).toHaveLength(SETTINGS_REGISTRY.length);
    expect(snapshot.value.values).toHaveLength(SETTINGS_REGISTRY.length);

    const tier = snapshot.value.values.find((value) => value.key === 'model.qualityTier');
    expect(tier).toMatchObject({ secret: false, origin: 'global', value: 'final' });

    const untouched = snapshot.value.values.find((value) => value.key === 'model.routingPolicy');
    expect(untouched?.origin).toBe('default');
  });

  it('names the layer a write from this scope would land on', async () => {
    const global = await service().snapshot({ projectId: null, runId: null });
    const project = await service().snapshot({ projectId: PROJECT, runId: null });
    const run = await service().snapshot({ projectId: PROJECT, runId: RUN });

    if (isErr(global) || isErr(project) || isErr(run)) throw new Error('snapshot failed');
    expect(global.value.target).toBe('global');
    expect(project.value.target).toBe('project');
    // Most specific wins: a run view writes the run layer even though a project is named.
    expect(run.value.target).toBe('run');
  });

  it('reports a secret as present without revealing it, anywhere in the payload', async () => {
    const snapshot = await service({}, { GEMINI_API_KEY: 'sk-do-not-print-me' }).snapshot({
      projectId: null,
      runId: null,
    });
    if (isErr(snapshot)) throw snapshot.error;

    const key = snapshot.value.values.find((value) => value.key === 'provider.gemini.apiKey');
    expect(key).toEqual({
      key: 'provider.gemini.apiKey',
      secret: true,
      set: true,
      origin: 'machine',
      shadowed: [],
      ignored: [],
    });

    // The whole serialised response, nested included. A redaction that only holds at the
    // top level is a redaction that holds until someone adds a nested field.
    expect(JSON.stringify(snapshot.value)).not.toContain('sk-do-not-print-me');
  });

  it('walks the serialised response and finds no secret value at any depth', async () => {
    const secrets: Record<string, string> = {
      GEMINI_API_KEY: 'sk-gemini-canary-0001',
      OPENROUTER_API_KEY: 'sk-openrouter-canary-0002',
      COMFYUI_AUTH_TOKEN: 'comfy-canary-0003',
      HF_TOKEN: 'hf-canary-0004',
      REDIS_URL: 'redis://user:canary-0005@127.0.0.1:6379',
    };
    const snapshot = await service({}, secrets).snapshot({ projectId: null, runId: null });
    if (isErr(snapshot)) throw snapshot.error;

    // Not `JSON.stringify().includes()`: that would pass if a secret were hidden behind
    // a `toJSON`, and it says nothing about *where* a leak was. This walks every node.
    const found: string[] = [];
    const seen = new Set<unknown>();
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        for (const [name, value] of Object.entries(secrets)) {
          if (node.includes(value)) found.push(`${path} leaked ${name}`);
        }
        return;
      }
      if (typeof node !== 'object' || node === null || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        node.forEach((item, index) => {
          walk(item, `${path}[${String(index)}]`);
        });
        return;
      }
      for (const [property, value] of Object.entries(node)) walk(value, `${path}.${property}`);
    };
    walk(snapshot.value, 'snapshot');

    expect(found).toEqual([]);
    // The walk has to be able to fail, or an empty result proves nothing.
    walk({ nested: [{ deep: secrets.GEMINI_API_KEY }] }, 'canary');
    expect(found).toEqual(['canary.nested[0].deep leaked GEMINI_API_KEY']);
  });

  it('reports every secret that is set, and every one that is not', async () => {
    const snapshot = await service(
      {},
      { GEMINI_API_KEY: 'set', OPENROUTER_API_KEY: '   ' },
    ).snapshot({ projectId: null, runId: null });
    if (isErr(snapshot)) throw snapshot.error;

    const presence = new Map(
      snapshot.value.values.flatMap((value) => (value.secret ? [[value.key, value.set]] : [])),
    );
    expect(presence.get('provider.gemini.apiKey')).toBe(true);
    // Blank is not set: `.env.example` ships every credential as `NAME=`, and reporting
    // that as configured tells the operator a lane works when the next call will 401.
    expect(presence.get('provider.openrouter.apiKey')).toBe(false);
    expect(presence.get('provider.huggingface.token')).toBe(false);
  });

  it('surfaces an unknown RV_ variable rather than ignoring it', async () => {
    const snapshot = await service({}, { RV_BUDGET_PER_RUN_USD: '5.00' }).snapshot({
      projectId: null,
      runId: null,
    });
    if (isErr(snapshot)) throw snapshot.error;

    // The transposed spelling of `RV_BUDGET_USD_PER_RUN`: the exact typo the registry
    // exists to catch, and the one that would otherwise leave the budget on its default.
    expect(snapshot.value.warnings).toContainEqual(
      expect.objectContaining({ variable: 'RV_BUDGET_PER_RUN_USD', reason: 'unknown' }),
    );
  });

  it('reports a stored value that no longer parses, and falls back rather than failing', async () => {
    const snapshot = await service({ 'render.concurrency': 'a lot' }).snapshot({
      projectId: null,
      runId: null,
    });
    if (isErr(snapshot)) throw snapshot.error;

    const concurrency = snapshot.value.values.find((value) => value.key === 'render.concurrency');
    // A settings screen that refused to open because one row is stale cannot be used to
    // fix that row.
    expect(concurrency?.origin).toBe('default');
    expect(concurrency?.ignored).toHaveLength(1);
    expect(concurrency?.ignored.at(0)?.scope).toBe('global');
  });

  it('reports every bad key in one answer, not the first', async () => {
    const outcome = await service().write('global', {
      scope: { projectId: null, runId: null },
      set: [
        { key: 'model.qualityTier', value: 'luxurious' },
        { key: 'render.concurrency', value: 9999 },
        { key: 'provider.gemini.apiKey', value: 'sk-nope' },
      ],
      clear: ['runtime.apiPort'],
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    const issues = outcome.error.context.issues as { path: string; code: string }[];
    // All four, including the clear: a settings form marks every bad field at once.
    expect(issues.map((issue) => issue.path)).toEqual([
      'model.qualityTier',
      'render.concurrency',
      'provider.gemini.apiKey',
      'runtime.apiPort',
    ]);
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('invalid-value');
    // A secret above the machine layer gets its own code: the fix is "move it to .env",
    // not "write it at a broader scope".
    expect(codes).toContain('secret-scope');
    // `runtime.apiPort` is machine-scope, so clearing it at global is not a thing.
    expect(codes).toContain('scope-violation');
  });

  it('accepts a write the descriptor allows and answers with the refreshed snapshot', async () => {
    const outcome = await service().write('global', {
      scope: { projectId: null, runId: null },
      set: [{ key: 'model.qualityTier', value: 'final' }],
      clear: [],
    });
    if (isErr(outcome)) throw outcome.error;
    expect(outcome.value.descriptors).toHaveLength(SETTINGS_REGISTRY.length);
  });

  it('refuses a project write that names no project', async () => {
    const outcome = await service().write('project', {
      scope: { projectId: null, runId: null },
      set: [{ key: 'image.lane', value: 'cloud-api' }],
      clear: [],
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
  });
});

describe('the health check', () => {
  const emptyAdapters: AdapterSet = {
    matrix: { adapters: () => [] } as unknown as AdapterSet['matrix'],
    adapters: [],
    skipped: [{ provider: 'ollama', reason: 'OLLAMA_HOST is not set' }],
  };
  const queue = { driver: 'in-process', peakConcurrency: 0 } as unknown as JobQueue;
  const runner = { implementedStages: () => ['intake'] } as unknown as PipelineRunner;

  function open(): DatabaseHandle {
    const opened = createDatabase(':memory:');
    if (isErr(opened)) throw opened.error;
    return opened.value;
  }

  it('reports ok while the database answers', () => {
    const handle = open();
    const report = new HealthController(
      config(),
      handle,
      queue,
      emptyAdapters,
      runner,
      null,
    ).check();

    expect(report.status).toBe('ok');
    expect(report.database.reachable).toBe(true);
    expect(report.database.error).toBeUndefined();
    handle.close();
  });

  it('reports degraded, with the reason, once the database stops answering', () => {
    const handle = open();
    handle.close();

    const report = new HealthController(
      config(),
      handle,
      queue,
      emptyAdapters,
      runner,
      null,
    ).check();

    // Degraded rather than a thrown 500: a health endpoint that fails to respond tells
    // a load balancer nothing except "try again", which is what it was already doing.
    expect(report.status).toBe('degraded');
    expect(report.database.reachable).toBe(false);
    expect(report.database.error).toBeTypeOf('string');
  });
});
