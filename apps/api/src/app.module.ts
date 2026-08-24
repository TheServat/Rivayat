/**
 * The composition root. The only file allowed to name a concrete class.
 *
 * Everything above this line - controllers, use-cases, the pipeline runner - holds an
 * interface and a token. Everything below it is `@rv/providers`, `@rv/persistence` and
 * this app's own `infrastructure/`. `pnpm arch:check` proves nothing above reaches
 * downward; this file is where the two halves are joined, once, in one place you can
 * read top to bottom and see the whole system's wiring.
 *
 * Three conventions hold throughout, and each has a reason:
 *
 * 1. **Every provider is a factory over tokens.** No `useClass`, no class-typed
 *    constructor parameters. esbuild - which Vitest transforms with - emits no
 *    `design:paramtypes`, so a class-typed parameter resolves to `Object` and fails at
 *    boot. A token resolves identically under every build tool.
 * 2. **A port with no implementation is bound to a stub, never left unbound.** Six
 *    engine packages are scaffolds; their tokens resolve to something that returns 501
 *    and names the package. An unbound token is a boot failure, and boot failures teach
 *    nobody anything.
 * 3. **`forRoot` takes an environment.** An e2e suite boots the whole application over
 *    `:memory:` and an empty `REDIS_URL` without touching `process.env`, which would
 *    leak into every other test in the worker.
 */

import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { FindSimilarAssetsUseCase, ResolveAssetDemandUseCase } from '@rv/asset-registry';
import type {
  AssetRepository,
  BlobStore,
  EmbeddingPort as RegistryEmbeddingPort,
} from '@rv/asset-registry';
import { FlatRateAssetCostEstimator } from '@rv/asset-registry';
import { Ids } from '@rv/contracts';
import {
  DrizzleAssetRepository,
  DrizzleSettingsRepository,
  FsBlobStore,
  createDatabase,
  type DatabaseHandle,
} from '@rv/persistence';
import {
  CapabilityMatrix,
  InMemoryResponseCache,
  ModelRouter,
  type EmbeddingPort,
  type ResponseCache,
} from '@rv/providers';
import type { StructuredBackend } from '@rv/prompt-kit';
import {
  FfmpegEncoder,
  FfprobeReader,
  NodeProcessRunner,
  createNapiCanvasBackend,
  type FrameBackendId,
  type FrameRenderer,
} from '@rv/render-engine';
import type { SettingsRepository } from '@rv/settings';
import {
  SystemClock,
  createRng,
  isErr,
  type Clock,
  type Logger,
  type Rng,
} from '@rv/shared-kernel';

import type {
  AssetProductionPort,
  NarrativeMemoryPort,
  RenderPort,
  StoryEnginePort,
  StyleEnginePort,
} from './application/ports/engine.ports';
import type {
  EpisodeRepository,
  ProjectRepository,
  RunRepository,
  SeriesRepository,
  StyleBibleReader,
} from './application/ports/repository.ports';
import type { RunPayloadStore } from './application/ports/run-payload.port';
import { AppErrorFilter } from './common/app-error.filter';
import { PinoLoggerAdapter, createPinoLogger } from './common/pino-logger';
import { ResultInterceptor } from './common/result.interceptor';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import { RivayatConfigModule } from './config/config.module';
import { routerConfigFrom, type AppConfig } from './config/app-config';
import { CostService } from './cost/cost.service';
import { LedgerService } from './cost/ledger.service';
import { MeteredCallRunner } from './cost/metered-call';
import { EventsModule } from './events/events.module';
import type { RunEventBus } from './events/run-event-bus';
import {
  StubAssetProduction,
  StubNarrativeMemory,
  StubRenderEngine,
  StubStoryEngine,
  StubStyleEngine,
} from './infrastructure/engines/stub.adapters';
import { DrizzleEpisodeRepository } from './infrastructure/persistence/drizzle-episode.repository';
import { DrizzleRunRepository } from './infrastructure/persistence/drizzle-run.repository';
import { DrizzleStyleBibleReader } from './infrastructure/persistence/drizzle-style-bible.reader';
import { JsonFileRunPayloadStore } from './infrastructure/persistence/json-file-run-payload.store';
import {
  JsonFileProjectRepository,
  JsonFileSeriesRepository,
} from './infrastructure/persistence/json-file.repositories';
import { buildAdapters, type AdapterSet } from './infrastructure/providers/build-adapters';
import { RegistryEmbeddingAdapter } from './infrastructure/providers/registry-embedding.adapter';
import { RoutedStructuredBackend } from './infrastructure/providers/routed-structured.backend';
import {
  RoutedEmbeddingPort,
  RoutedImageEditPort,
  RoutedImageGenerationPort,
  RoutedTextGenerationPort,
  RoutedVisionScoringPort,
} from './infrastructure/providers/routed.ports';
import { AssetsModule } from './modules/assets/assets.module';
import { EpisodesModule } from './modules/episodes/episodes.module';
import { HealthModule } from './modules/health/health.module';
import {
  ADAPTER_SET,
  FIND_SIMILAR_ASSETS_USE_CASE,
  PIPELINE_RUNNER,
  RESOLVE_ASSET_DEMAND_USE_CASE,
} from './modules/module-tokens';
import { NarrativeModule } from './modules/narrative/narrative.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { RenderModule } from './modules/render/render.module';
import { SeriesModule } from './modules/series/series.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StyleModule } from './modules/style/style.module';
import { OpenApiModule } from './openapi/openapi.module';
import { IntakeStageHandler, ResolveStageHandler, StubStageHandler } from './pipeline/handlers';
import { PipelineRunner } from './pipeline/pipeline-runner.service';
import { CompositionStore } from './modules/compositions/composition.store';
import { CompositionsModule } from './modules/compositions/compositions.module';
import { DeliveryService } from './render/delivery.service';
import { ReframeService } from './render/reframe.service';
import { RenderStageHandler } from './render/render-stage.handler';
import { buildStageRegistry, type StageHandler, type StageRegistry } from './pipeline/stage';
import { BullMqJobQueue } from './queue/bullmq.queue';
import { InProcessJobQueue } from './queue/in-process.queue';
import type { JobQueue } from './queue/job-queue.port';
import {
  APP_CONFIG,
  ASSET_COST_ESTIMATOR,
  ASSET_PRODUCTION_PORT,
  ASSET_REPOSITORY,
  BLOB_STORE,
  CAPABILITY_MATRIX,
  CLOCK,
  COST_SERVICE,
  COMPOSITION_STORE,
  DATABASE,
  DELIVERY_SERVICE,
  EMBEDDING_PORT,
  EPISODE_REPOSITORY,
  FRAME_RENDERERS,
  IDS,
  IMAGE_EDIT_PORT,
  IMAGE_GENERATION_PORT,
  JOB_QUEUE,
  LEDGER_SERVICE,
  LOGGER,
  METERED_CALL_RUNNER,
  MODEL_ROUTER,
  NARRATIVE_MEMORY_PORT,
  PROJECT_REPOSITORY,
  REFRAME_SERVICE,
  RENDER_PORT,
  RESPONSE_CACHE,
  RNG,
  RUN_EVENT_BUS,
  RUN_PAYLOAD_STORE,
  RUN_REPOSITORY,
  SERIES_REPOSITORY,
  SETTINGS_REPOSITORY,
  STAGE_REGISTRY,
  STYLE_BIBLE_READER,
  STORY_ENGINE_PORT,
  STRUCTURED_GENERATION_PORT,
  STYLE_ENGINE_PORT,
  TEXT_GENERATION_PORT,
  VIDEO_ENCODER,
  VIDEO_PROBER,
  VISION_SCORING_PORT,
} from './tokens';

export interface AppOptions {
  /** Replaces `process.env` and the dotenv files entirely. See `RivayatConfigModule`. */
  readonly env?: Record<string, unknown>;
}

/** Every pipeline stage, with the three that have real implementations wired. */
function stageHandlers(
  resolve: ResolveAssetDemandUseCase,
  render: RenderStageHandler,
): readonly StageHandler[] {
  return [
    new IntakeStageHandler(),
    new ResolveStageHandler(resolve),
    render,
    // The rest, in pipeline order. Listed explicitly rather than derived from the enum
    // minus the implemented ones, so adding a stage to `@rv/contracts` shows up here as
    // a missing entry rather than as a silently-stubbed route.
    new StubStageHandler('style'),
    new StubStageHandler('story'),
    new StubStageHandler('cast'),
    new StubStageHandler('world'),
    new StubStageHandler('produce'),
    new StubStageHandler('sequence'),
    new StubStageHandler('choreograph'),
    new StubStageHandler('preview'),
    new StubStageHandler('deliver'),
  ];
}

@Module({})
export class AppModule {
  static forRoot(options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        RivayatConfigModule.forRoot(options.env === undefined ? {} : { env: options.env }),
        EventsModule,
        HealthModule,
        OpenApiModule,
        ProjectsModule,
        SeriesModule,
        EpisodesModule,
        StyleModule,
        AssetsModule,
        CompositionsModule,
        NarrativeModule,
        PipelineModule,
        RenderModule,
        SettingsModule,
      ],
      providers: [
        // ── global HTTP behaviour ─────────────────────────────────────────
        {
          provide: APP_FILTER,
          inject: [LOGGER],
          useFactory: (logger: Logger): AppErrorFilter => new AppErrorFilter(logger),
        },
        { provide: APP_INTERCEPTOR, useClass: ResultInterceptor },
        // The schema-carrying form. Per-parameter pipes do the real work (see the pipe's
        // header); this catches anything that arrives with a DTO metatype.
        { provide: APP_PIPE, useFactory: (): ZodValidationPipe => ZodValidationPipe.passthrough() },

        // ── platform ──────────────────────────────────────────────────────
        { provide: CLOCK, useFactory: (): Clock => new SystemClock() },
        { provide: IDS, useFactory: (): Ids => new Ids() },
        {
          provide: RNG,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): Rng => createRng(config.seed),
        },
        {
          provide: LOGGER,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): Logger =>
            new PinoLoggerAdapter(createPinoLogger({ level: config.logLevel })),
        },

        // ── persistence ───────────────────────────────────────────────────
        {
          provide: DATABASE,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): DatabaseHandle => {
            const handle = createDatabase(config.paths.databaseUrl);
            // Thrown, not returned: a database we cannot open is not a request-time
            // failure to be reported, it is a reason not to accept requests at all.
            if (isErr(handle)) throw handle.error;
            return handle.value;
          },
        },
        {
          provide: BLOB_STORE,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): BlobStore =>
            new FsBlobStore({ root: config.paths.assetStoreDir }),
        },
        {
          provide: ASSET_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: DatabaseHandle): AssetRepository =>
            new DrizzleAssetRepository(database),
        },
        {
          provide: EPISODE_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: DatabaseHandle): EpisodeRepository =>
            new DrizzleEpisodeRepository(database),
        },
        {
          provide: RUN_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: DatabaseHandle): RunRepository =>
            new DrizzleRunRepository(database),
        },
        // No table yet - see `infrastructure/persistence/json-file.repositories.ts` for
        // why these are files under the workspace rather than rows, and what deletes
        // them.
        {
          provide: PROJECT_REPOSITORY,
          inject: [APP_CONFIG, LOGGER],
          useFactory: (config: AppConfig, logger: Logger): ProjectRepository =>
            new JsonFileProjectRepository({ workspaceDir: config.paths.workspaceDir, logger }),
        },
        {
          provide: SERIES_REPOSITORY,
          inject: [APP_CONFIG, LOGGER],
          useFactory: (config: AppConfig, logger: Logger): SeriesRepository =>
            new JsonFileSeriesRepository({ workspaceDir: config.paths.workspaceDir, logger }),
        },
        {
          provide: STYLE_BIBLE_READER,
          inject: [DATABASE],
          useFactory: (database: DatabaseHandle): StyleBibleReader =>
            new DrizzleStyleBibleReader(database),
        },
        {
          // The real `settings` table, keyed `(scope, scopeId, key)`. It refuses a
          // machine-scope write by design: `.env` is not a row.
          provide: SETTINGS_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: DatabaseHandle): SettingsRepository =>
            new DrizzleSettingsRepository(database),
        },
        {
          provide: RUN_PAYLOAD_STORE,
          inject: [APP_CONFIG, LOGGER],
          useFactory: (config: AppConfig, logger: Logger): RunPayloadStore =>
            new JsonFileRunPayloadStore({ workspaceDir: config.paths.workspaceDir, logger }),
        },
        {
          provide: ASSET_COST_ESTIMATOR,
          useFactory: (): FlatRateAssetCostEstimator => new FlatRateAssetCostEstimator(),
        },

        // ── providers ─────────────────────────────────────────────────────
        {
          provide: ADAPTER_SET,
          inject: [APP_CONFIG, LOGGER],
          useFactory: (config: AppConfig, logger: Logger): Promise<AdapterSet> =>
            buildAdapters(config, logger),
        },
        {
          provide: CAPABILITY_MATRIX,
          inject: [ADAPTER_SET],
          useFactory: (adapters: AdapterSet): CapabilityMatrix => adapters.matrix,
        },
        {
          provide: MODEL_ROUTER,
          inject: [APP_CONFIG, CAPABILITY_MATRIX, RNG, LOGGER],
          useFactory: (
            config: AppConfig,
            matrix: CapabilityMatrix,
            rng: Rng,
            logger: Logger,
          ): ModelRouter =>
            new ModelRouter({ config: routerConfigFrom(config), matrix, rng, logger }),
        },
        {
          provide: RESPONSE_CACHE,
          inject: [CLOCK],
          useFactory: (clock: Clock): ResponseCache => new InMemoryResponseCache({ clock }),
        },
        {
          provide: TEXT_GENERATION_PORT,
          inject: [MODEL_ROUTER, CAPABILITY_MATRIX],
          useFactory: (router: ModelRouter, matrix: CapabilityMatrix): RoutedTextGenerationPort =>
            new RoutedTextGenerationPort({ router, matrix }),
        },
        {
          provide: STRUCTURED_GENERATION_PORT,
          inject: [MODEL_ROUTER, CAPABILITY_MATRIX],
          useFactory: (router: ModelRouter, matrix: CapabilityMatrix): StructuredBackend =>
            new RoutedStructuredBackend({ router, matrix }),
        },
        {
          provide: IMAGE_GENERATION_PORT,
          inject: [MODEL_ROUTER, CAPABILITY_MATRIX],
          useFactory: (router: ModelRouter, matrix: CapabilityMatrix): RoutedImageGenerationPort =>
            new RoutedImageGenerationPort({ router, matrix }),
        },
        {
          provide: IMAGE_EDIT_PORT,
          inject: [MODEL_ROUTER, CAPABILITY_MATRIX],
          useFactory: (router: ModelRouter, matrix: CapabilityMatrix): RoutedImageEditPort =>
            new RoutedImageEditPort({ router, matrix }),
        },
        {
          provide: VISION_SCORING_PORT,
          inject: [MODEL_ROUTER, CAPABILITY_MATRIX],
          useFactory: (router: ModelRouter, matrix: CapabilityMatrix): RoutedVisionScoringPort =>
            new RoutedVisionScoringPort({ router, matrix }),
        },
        {
          provide: EMBEDDING_PORT,
          inject: [MODEL_ROUTER, CAPABILITY_MATRIX],
          useFactory: (router: ModelRouter, matrix: CapabilityMatrix): EmbeddingPort =>
            new RoutedEmbeddingPort({ router, matrix }),
        },

        // ── cost ──────────────────────────────────────────────────────────
        {
          provide: COST_SERVICE,
          inject: [CLOCK, LOGGER, IDS, APP_CONFIG],
          useFactory: (clock: Clock, logger: Logger, ids: Ids, config: AppConfig): CostService =>
            new CostService({ clock, logger, ids, policy: config.budget }),
        },
        {
          provide: LEDGER_SERVICE,
          inject: [RUN_REPOSITORY, COST_SERVICE, CLOCK, LOGGER],
          useFactory: (
            runs: RunRepository,
            cost: CostService,
            clock: Clock,
            logger: Logger,
          ): LedgerService => new LedgerService({ runs, cost, clock, logger }),
        },
        {
          provide: METERED_CALL_RUNNER,
          inject: [COST_SERVICE, RUN_EVENT_BUS, RUN_REPOSITORY, LOGGER],
          useFactory: (
            cost: CostService,
            events: RunEventBus,
            runs: RunRepository,
            logger: Logger,
          ): MeteredCallRunner => new MeteredCallRunner({ cost, events, runs, logger }),
        },

        // ── engine ports: five stubs, pending their packages ──────────────
        { provide: STYLE_ENGINE_PORT, useFactory: (): StyleEnginePort => new StubStyleEngine() },
        { provide: STORY_ENGINE_PORT, useFactory: (): StoryEnginePort => new StubStoryEngine() },
        {
          provide: ASSET_PRODUCTION_PORT,
          useFactory: (): AssetProductionPort => new StubAssetProduction(),
        },
        {
          provide: NARRATIVE_MEMORY_PORT,
          useFactory: (): NarrativeMemoryPort => new StubNarrativeMemory(),
        },
        { provide: RENDER_PORT, useFactory: (): RenderPort => new StubRenderEngine() },

        // ── asset registry use-cases: real, today ─────────────────────────
        {
          provide: RESOLVE_ASSET_DEMAND_USE_CASE,
          inject: [ASSET_REPOSITORY, ASSET_COST_ESTIMATOR],
          useFactory: (
            repository: AssetRepository,
            estimator: FlatRateAssetCostEstimator,
          ): ResolveAssetDemandUseCase => new ResolveAssetDemandUseCase({ repository, estimator }),
        },
        {
          provide: FIND_SIMILAR_ASSETS_USE_CASE,
          inject: [ASSET_REPOSITORY, EMBEDDING_PORT, APP_CONFIG],
          useFactory: (
            repository: AssetRepository,
            port: EmbeddingPort,
            config: AppConfig,
          ): FindSimilarAssetsUseCase => {
            // The registry declares its own narrow `EmbeddingPort`; this is the joint.
            const embeddings: RegistryEmbeddingPort = new RegistryEmbeddingAdapter({
              port,
              model: `ollama:${config.providers.ollama.embedModel}`,
              dimensions: 768,
            });
            return new FindSimilarAssetsUseCase({ repository, embeddings });
          },
        },

        // ── queue and pipeline ────────────────────────────────────────────
        {
          provide: JOB_QUEUE,
          inject: [APP_CONFIG, LOGGER, RNG, CLOCK],
          useFactory: (config: AppConfig, logger: Logger, rng: Rng, clock: Clock): JobQueue =>
            config.queue.redisUrl === null
              ? new InProcessJobQueue({ concurrency: config.queue.concurrency, rng, logger })
              : new BullMqJobQueue({
                  redisUrl: config.queue.redisUrl,
                  concurrency: config.queue.concurrency,
                  logger,
                  clock,
                }),
        },
        // ── render backends ──────────────────────────────────────
        {
          // Skia only. The Playwright backend needs a browser download and a running
          // Chromium, which is not something an API boot may assume; `selectBackend`
          // refuses a composition that needs it rather than drawing it *almost* right.
          provide: FRAME_RENDERERS,
          useFactory: (): ReadonlyMap<FrameBackendId, FrameRenderer> =>
            new Map([['napi-canvas', createNapiCanvasBackend()]]),
        },
        {
          provide: VIDEO_ENCODER,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): FfmpegEncoder =>
            new FfmpegEncoder(new NodeProcessRunner(), {
              ffmpeg: config.paths.ffmpegPath,
              ffprobe: config.paths.ffprobePath,
            }),
        },
        {
          provide: VIDEO_PROBER,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): FfprobeReader =>
            new FfprobeReader(new NodeProcessRunner(), {
              ffmpeg: config.paths.ffmpegPath,
              ffprobe: config.paths.ffprobePath,
            }),
        },
        {
          provide: REFRAME_SERVICE,
          inject: [IDS],
          useFactory: (ids: Ids): ReframeService => new ReframeService({ ids }),
        },
        {
          provide: COMPOSITION_STORE,
          inject: [APP_CONFIG, CLOCK, LOGGER],
          useFactory: (config: AppConfig, clock: Clock, logger: Logger): CompositionStore =>
            new CompositionStore({
              workspaceDir: config.paths.workspaceDir,
              clock,
              logger,
            }),
        },
        {
          provide: DELIVERY_SERVICE,
          inject: [RUN_REPOSITORY, APP_CONFIG],
          useFactory: (runs: RunRepository, config: AppConfig): DeliveryService =>
            new DeliveryService({ runs, workspaceDir: config.paths.workspaceDir }),
        },

        {
          provide: STAGE_REGISTRY,
          inject: [
            RESOLVE_ASSET_DEMAND_USE_CASE,
            FRAME_RENDERERS,
            VIDEO_ENCODER,
            VIDEO_PROBER,
            COMPOSITION_STORE,
            CLOCK,
            LOGGER,
            APP_CONFIG,
          ],
          useFactory: (
            resolve: ResolveAssetDemandUseCase,
            renderers: ReadonlyMap<FrameBackendId, FrameRenderer>,
            encoder: FfmpegEncoder,
            prober: FfprobeReader,
            compositions: CompositionStore,
            clock: Clock,
            logger: Logger,
            config: AppConfig,
          ): StageRegistry =>
            buildStageRegistry(
              stageHandlers(
                resolve,
                new RenderStageHandler({
                  renderers,
                  encoder,
                  prober,
                  compositions,
                  clock,
                  logger,
                  workspaceDir: config.paths.workspaceDir,
                }),
              ),
            ),
        },
        {
          provide: PIPELINE_RUNNER,
          inject: [
            RUN_REPOSITORY,
            RUN_PAYLOAD_STORE,
            JOB_QUEUE,
            RUN_EVENT_BUS,
            STAGE_REGISTRY,
            CLOCK,
            IDS,
            LOGGER,
          ],
          useFactory: (
            runs: RunRepository,
            payloads: RunPayloadStore,
            queue: JobQueue,
            events: RunEventBus,
            stages: StageRegistry,
            clock: Clock,
            ids: Ids,
            logger: Logger,
          ): PipelineRunner =>
            new PipelineRunner({ runs, payloads, queue, events, stages, clock, ids, logger }),
        },
      ],
      // `APP_CONFIG`, `MACHINE_SETTINGS` and `RUN_EVENT_BUS` are absent on purpose:
      // they are provided by `RivayatConfigModule` and `EventsModule`, both global, and
      // Nest refuses to re-export a provider a module does not own.
      exports: [
        CLOCK,
        IDS,
        RNG,
        LOGGER,
        DATABASE,
        BLOB_STORE,
        ASSET_REPOSITORY,
        ASSET_COST_ESTIMATOR,
        EPISODE_REPOSITORY,
        RUN_REPOSITORY,
        RUN_PAYLOAD_STORE,
        PROJECT_REPOSITORY,
        SERIES_REPOSITORY,
        SETTINGS_REPOSITORY,
        STYLE_BIBLE_READER,
        ADAPTER_SET,
        CAPABILITY_MATRIX,
        MODEL_ROUTER,
        RESPONSE_CACHE,
        TEXT_GENERATION_PORT,
        STRUCTURED_GENERATION_PORT,
        IMAGE_GENERATION_PORT,
        IMAGE_EDIT_PORT,
        VISION_SCORING_PORT,
        EMBEDDING_PORT,
        COST_SERVICE,
        LEDGER_SERVICE,
        METERED_CALL_RUNNER,
        STYLE_ENGINE_PORT,
        STORY_ENGINE_PORT,
        ASSET_PRODUCTION_PORT,
        NARRATIVE_MEMORY_PORT,
        RENDER_PORT,
        FRAME_RENDERERS,
        VIDEO_ENCODER,
        VIDEO_PROBER,
        REFRAME_SERVICE,
        DELIVERY_SERVICE,
        COMPOSITION_STORE,
        RESOLVE_ASSET_DEMAND_USE_CASE,
        FIND_SIMILAR_ASSETS_USE_CASE,
        JOB_QUEUE,
        STAGE_REGISTRY,
        PIPELINE_RUNNER,
      ],
      global: true,
    };
  }
}
