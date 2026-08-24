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
import {
  FindSimilarAssetsUseCase,
  RegisterAssetVersionUseCase,
  ResolveAssetDemandUseCase,
} from '@rv/asset-registry';
import type {
  AssetRepository,
  BlobStore,
  EmbeddingPort as RegistryEmbeddingPort,
} from '@rv/asset-registry';
import { FlatRateAssetCostEstimator } from '@rv/asset-registry';
import { Ids } from '@rv/contracts';
import {
  ChainedMatting,
  PngRaster,
  ThresholdMatting,
  type LaneBinding,
  type ProduceCheckpointStore,
  type ProduceLanes,
} from '@rv/asset-engine';
import {
  DrizzleAssetRepository,
  DrizzleProduceCheckpointRepository,
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
  type ImageGenerationPort,
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
import { AssetDemandService } from './assets/asset-demand.service';
import { AssetLibraryQuery } from './assets/asset-library.query';
import { ProduceRecordStore } from './assets/produce-record.store';
import { ProduceStageHandler } from './assets/produce-stage.handler';
import { RegenerateAssetVersionUseCase } from './assets/regenerate-asset.use-case';
import { SequenceStageHandler } from './sequence/sequence-stage.handler';
import { ShotListStore } from './sequence/shot-list.store';
import { PngStyleRaster } from './style/png-style.raster';
import { StyleEngineAdapter } from './style/style-engine.adapter';
import { StyleStageHandler } from './style/style-stage.handler';
import {
  DrizzleStyleBibleRepository,
  type StyleBibleRepository,
} from './style/style-bible.repository';
import { AssetsModule } from './modules/assets/assets.module';
import { BlobsModule } from './modules/blobs/blobs.module';
import { EpisodesModule } from './modules/episodes/episodes.module';
import { HealthModule } from './modules/health/health.module';
import {
  ADAPTER_SET,
  ASSET_DEMAND_SERVICE,
  ASSET_LIBRARY_QUERY,
  FIND_SIMILAR_ASSETS_USE_CASE,
  PIPELINE_RUNNER,
  PRODUCE_CHECKPOINTS,
  PRODUCE_LANES,
  PRODUCE_RECORD_STORE,
  PRODUCE_STAGE_HANDLER,
  REGENERATE_ASSET_USE_CASE,
  REGISTER_ASSET_VERSION_USE_CASE,
  RESOLVE_ASSET_DEMAND_USE_CASE,
  SEQUENCE_STAGE_HANDLER,
  SHOT_LIST_STORE,
  STYLE_BIBLE_REPOSITORY,
  STYLE_STAGE_HANDLER,
} from './modules/module-tokens';
import { NarrativeModule } from './modules/narrative/narrative.module';
import { NarrativeGraphStore } from './narrative/graph.store';
import { NARRATIVE_GRAPH_STORE, SNAPSHOT_SERVICE } from './narrative/narrative.tokens';
import { SnapshotService } from './narrative/snapshot.service';
import { WorldStageHandler } from './narrative/world-stage.handler';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { RenderModule } from './modules/render/render.module';
import { SeriesModule } from './modules/series/series.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StoryModule } from './modules/story/story.module';
import { StyleModule } from './modules/style/style.module';
import { CastStageHandler } from './story/cast-stage.handler';
import { CastService } from './story/cast.service';
import { CharacterStateStore } from './story/cast.store';
import { OutlineService } from './story/outline.service';
import { StoryEngineFactory } from './story/story-engine.deps';
import { StoryStageHandler } from './story/story-stage.handler';
import { StoryStore } from './story/story.store';
import {
  CAST_SERVICE,
  CHARACTER_STATE_STORE,
  OUTLINE_SERVICE,
  STORY_ENGINE_FACTORY,
  STORY_STORE,
} from './story/story.tokens';
import { OpenApiModule } from './openapi/openapi.module';
import { IntakeStageHandler, ResolveStageHandler } from './pipeline/handlers';
import { PipelineRunner } from './pipeline/pipeline-runner.service';
import { CompositionStore } from './modules/compositions/composition.store';
import { CompositionsModule } from './modules/compositions/compositions.module';
import {
  ChoreographStageHandler,
  defaultMotionProviders,
} from './render/choreograph-stage.handler';
import { ChoreographyStore } from './render/choreography.store';
import { DeliverStageHandler } from './render/deliver-stage.handler';
import { DeliveryService } from './render/delivery.service';
import { PreviewStageHandler } from './render/preview-stage.handler';
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

/**
 * The three LLM story stages, built together.
 *
 * One bundle rather than three parameters on `stageHandlers`, because they share five
 * dependencies - the stores, the engine factory, the meter and the router - and a
 * factory taking eleven positional arguments is a factory whose call site nobody reads.
 */
export interface StoryStageBundle {
  readonly story: StoryStageHandler;
  readonly cast: CastStageHandler;
  readonly world: WorldStageHandler;
}

/**
 * The three animation stages, built together.
 *
 * A bundle for the same reason `StoryStageBundle` is one: they share the workspace, the
 * composition store, the encoder and the clock, and they are the three ends of one
 * thread - S8 writes a composition, S9 looks at it, S11 cuts what S10 rendered of it.
 */
export interface AnimationStageBundle {
  readonly choreograph: ChoreographStageHandler;
  readonly preview: PreviewStageHandler;
  readonly deliver: DeliverStageHandler;
}

/**
 * S1, S6 and S7, built at their own tokens and handed over as one bundle.
 *
 * Bound separately rather than constructed inside the stage-registry factory because
 * they carry sixteen dependencies between them, and a factory with sixteen more
 * positional parameters is a factory whose call site nobody reads.
 */
export interface AssetStageBundle {
  readonly style: StyleStageHandler;
  readonly produce: ProduceStageHandler;
  readonly sequence: SequenceStageHandler;
}

/** Every pipeline stage. All twelve have real implementations. */
function stageHandlers(
  resolve: ResolveAssetDemandUseCase,
  render: RenderStageHandler,
  storyStages: StoryStageBundle,
  animation: AnimationStageBundle,
  assetStages: AssetStageBundle,
): readonly StageHandler[] {
  return [
    new IntakeStageHandler(),
    new ResolveStageHandler(resolve),
    render,
    storyStages.story,
    storyStages.cast,
    storyStages.world,
    animation.choreograph,
    animation.preview,
    animation.deliver,
    // Listed explicitly rather than derived from the enum, so adding a stage to
    // `@rv/contracts` shows up here as a missing entry rather than as a silently-stubbed
    // route. `StubStageHandler` is still imported and still bound to nothing: the day a
    // stage is removed from a build, a stub is what should stand in for it.
    assetStages.style,
    assetStages.produce,
    assetStages.sequence,
  ];
}

/**
 * The matting chain S6 keys its generated sheets with.
 *
 * Threshold first at the default tolerance, then a wider one: the parts sheet is drawn on
 * a field the prompt asked to be flat, and a model that shades it slightly still keys
 * cleanly at 46 -> 72 rather than needing a segmentation model and a 400 MB download
 * (research §4). The two are chained rather than merged so the *first* engine that
 * succeeds is the one recorded on the version - which is how "which matte produced this"
 * stays answerable.
 */
function produceMatting(): ChainedMatting {
  return new ChainedMatting([
    new ThresholdMatting(),
    new ThresholdMatting({ tolerance: 30 * 30 * 3, softTolerance: 72 * 72 * 3 }),
  ]);
}

/**
 * S8, S9 and S11 over one workspace.
 *
 * The `ChoreographyStore` and the motion registry are built here rather than bound to
 * tokens of their own because nothing outside these three stages resolves either: a
 * token exists so a *controller* can name a dependency it must not import, and neither
 * of these has a controller. The moment a route needs the shot list - a timeline view
 * would - it becomes a token like the composition store did.
 */
function animationStages(deps: {
  readonly renderers: ReadonlyMap<FrameBackendId, FrameRenderer>;
  readonly encoder: FfmpegEncoder;
  readonly prober: FfprobeReader;
  readonly compositions: CompositionStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly workspaceDir: string;
}): AnimationStageBundle {
  const choreography = new ChoreographyStore(deps.workspaceDir);
  return {
    choreograph: new ChoreographStageHandler({
      compositions: deps.compositions,
      choreography,
      motion: defaultMotionProviders(),
      clock: deps.clock,
      logger: deps.logger,
    }),
    preview: new PreviewStageHandler({
      renderers: deps.renderers,
      encoder: deps.encoder,
      compositions: deps.compositions,
      clock: deps.clock,
      logger: deps.logger,
      workspaceDir: deps.workspaceDir,
    }),
    deliver: new DeliverStageHandler({
      encoder: deps.encoder,
      prober: deps.prober,
      compositions: deps.compositions,
      choreography,
      clock: deps.clock,
      logger: deps.logger,
      workspaceDir: deps.workspaceDir,
    }),
  };
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
        BlobsModule,
        CompositionsModule,
        NarrativeModule,
        StoryModule,
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

        // ── engine ports ──────────────────────────────────────────────────
        {
          // S1 is real. `StubStyleEngine` still exists - see its header - but nothing in
          // a running process reaches it: `@rv/style-engine` owns the presets, the
          // derivation, the probe and the scorer, and this is the joint.
          provide: STYLE_ENGINE_PORT,
          inject: [
            STYLE_BIBLE_REPOSITORY,
            BLOB_STORE,
            IMAGE_GENERATION_PORT,
            CAPABILITY_MATRIX,
            STRUCTURED_GENERATION_PORT,
            PRODUCE_LANES,
            IDS,
            CLOCK,
            LOGGER,
          ],
          useFactory: (
            repository: StyleBibleRepository,
            blobs: BlobStore,
            images: RoutedImageGenerationPort,
            matrix: CapabilityMatrix,
            structured: StructuredBackend,
            lanes: ProduceLanes,
            ids: Ids,
            clock: Clock,
            logger: Logger,
          ): StyleEnginePort => {
            // The free lane is the *local* one and must stay local: research §0 measured
            // 1.42 s and $0.00 for a 512px draft on ComfyUI, which is what makes rejecting
            // six candidate styles cost nothing. Taking it from the produce lane table
            // rather than from the router means the probe and the assets are drawn by the
            // same checkpoint, which is the whole point of a probe.
            const free = lanes.byLane['local-parts-sheet']?.images;
            const imageLanes: Partial<Record<'free' | 'paid', ImageGenerationPort>> = {
              ...(free === undefined ? {} : { free }),
              // The paid lane is the router's: it picks a cloud model by task and tier,
              // which is the decision the router exists to make.
              ...(matrix.refsFor('image-generation').length === 0 ? {} : { paid: images }),
            };
            return new StyleEngineAdapter({
              repository,
              blobs,
              ids,
              clock,
              logger,
              imageLanes,
              // One routed backend, not a hand-picked chain: `StructuredCall` escalates
              // along it, and the router already knows which models can see an image.
              backends: matrix.refsFor('structured-generation').length === 0 ? [] : [structured],
              raster: new PngStyleRaster(),
            });
          },
        },
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

        // ── S1 style, S6 produce, S7 sequence: the stores and lanes ───────
        {
          provide: STYLE_BIBLE_REPOSITORY,
          inject: [DATABASE, LOGGER],
          useFactory: (database: DatabaseHandle, logger: Logger): StyleBibleRepository =>
            new DrizzleStyleBibleRepository({ database, logger }),
        },
        {
          provide: PRODUCE_RECORD_STORE,
          inject: [APP_CONFIG, LOGGER],
          useFactory: (config: AppConfig, logger: Logger): ProduceRecordStore =>
            new ProduceRecordStore({ workspaceDir: config.paths.workspaceDir, logger }),
        },
        {
          provide: SHOT_LIST_STORE,
          inject: [APP_CONFIG, LOGGER],
          useFactory: (config: AppConfig, logger: Logger): ShotListStore =>
            new ShotListStore({ workspaceDir: config.paths.workspaceDir, logger }),
        },
        {
          provide: PRODUCE_CHECKPOINTS,
          inject: [DATABASE],
          useFactory: (database: DatabaseHandle): ProduceCheckpointStore =>
            new DrizzleProduceCheckpointRepository(database),
        },
        {
          /**
           * Which port draws which generation lane.
           *
           * The lane table is `@rv/asset-engine`'s (`produce/lanes.ts`) and says *what*
           * each lane is for; this says *who* runs it, which is a wiring decision and
           * must not live in the engine. A lane with no binding is a typed refusal that
           * names the lane, never a silent substitution - so a machine with no ComfyUI
           * fails a prop spec by saying "the local-parts-sheet lane is not configured"
           * rather than quietly drawing it somewhere that cannot key its background.
           *
           * The local binding is resolved from the **capability matrix** rather than
           * constructed, so the parts-sheet graph, the checkpoint name and the ledger's
           * model string all come from the one adapter `/api/health` reports.
           */
          provide: PRODUCE_LANES,
          inject: [CAPABILITY_MATRIX, LOGGER],
          useFactory: (matrix: CapabilityMatrix, logger: Logger): ProduceLanes => {
            const byLane: Record<string, LaneBinding> = {};
            for (const adapter of matrix.adapters()) {
              if (adapter.kind !== 'comfyui') continue;
              const port = matrix.resolve(adapter.modelRef, 'image-generation');
              if (isErr(port)) continue;
              byLane['local-parts-sheet'] = {
                images: port.value,
                provider: 'comfyui',
                model: adapter.modelRef.slice('comfyui:'.length),
                // SD 1.5 conditions on CLIP-L at 77 tokens. Declared on the binding rather
                // than inferred from the lane name, because the same graphs will host SDXL
                // and FLUX later and FLUX's T5-XXL wants the long shape (research §2).
                promptEncoder: 'clip-77',
              };
              break;
            }
            logger.info('produce lanes bound', { lanes: Object.keys(byLane) });
            return { byLane };
          },
        },

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
        {
          // The one door into the library. S6 gets it without an intent, so a first take
          // registers and a second is a `ConflictError`; only the regenerate use-case may
          // wrap it with one.
          provide: REGISTER_ASSET_VERSION_USE_CASE,
          inject: [ASSET_REPOSITORY, IDS, CLOCK],
          useFactory: (
            repository: AssetRepository,
            ids: Ids,
            clock: Clock,
          ): RegisterAssetVersionUseCase =>
            new RegisterAssetVersionUseCase({ repository, ids, clock }),
        },
        {
          provide: ASSET_LIBRARY_QUERY,
          inject: [DATABASE, LOGGER],
          useFactory: (database: DatabaseHandle, logger: Logger): AssetLibraryQuery =>
            new AssetLibraryQuery({ database, logger }),
        },
        {
          provide: ASSET_DEMAND_SERVICE,
          inject: [RESOLVE_ASSET_DEMAND_USE_CASE, PRODUCE_RECORD_STORE],
          useFactory: (
            resolve: ResolveAssetDemandUseCase,
            records: ProduceRecordStore,
          ): AssetDemandService => new AssetDemandService({ resolve, records }),
        },
        {
          provide: REGENERATE_ASSET_USE_CASE,
          inject: [
            ASSET_REPOSITORY,
            RESOLVE_ASSET_DEMAND_USE_CASE,
            REGISTER_ASSET_VERSION_USE_CASE,
            ASSET_COST_ESTIMATOR,
            PRODUCE_LANES,
            BLOB_STORE,
            PRODUCE_RECORD_STORE,
            STYLE_BIBLE_REPOSITORY,
            RUN_REPOSITORY,
            PROJECT_REPOSITORY,
            COST_SERVICE,
            RUN_EVENT_BUS,
            IDS,
            CLOCK,
            LOGGER,
          ],
          useFactory: (
            assets: AssetRepository,
            resolver: ResolveAssetDemandUseCase,
            registrar: RegisterAssetVersionUseCase,
            estimator: FlatRateAssetCostEstimator,
            lanes: ProduceLanes,
            blobs: BlobStore,
            records: ProduceRecordStore,
            styles: StyleBibleRepository,
            runs: RunRepository,
            projects: ProjectRepository,
            cost: CostService,
            events: RunEventBus,
            ids: Ids,
            clock: Clock,
            logger: Logger,
          ): RegenerateAssetVersionUseCase =>
            new RegenerateAssetVersionUseCase({
              assets,
              resolver,
              registrar,
              estimator,
              lanes,
              raster: new PngRaster(),
              matting: produceMatting(),
              blobs,
              records,
              styles,
              runs,
              projects,
              cost: { cost, events, runs, logger },
              ids,
              clock,
              logger,
            }),
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

        // ── S2/S3/S4: the story surface, real ─────────────────────────────
        {
          provide: STORY_STORE,
          inject: [APP_CONFIG, LOGGER],
          useFactory: (config: AppConfig, logger: Logger): StoryStore =>
            new StoryStore({ workspaceDir: config.paths.workspaceDir, logger }),
        },
        {
          provide: CHARACTER_STATE_STORE,
          inject: [APP_CONFIG, LOGGER],
          useFactory: (config: AppConfig, logger: Logger): CharacterStateStore =>
            new CharacterStateStore({ workspaceDir: config.paths.workspaceDir, logger }),
        },
        {
          provide: NARRATIVE_GRAPH_STORE,
          inject: [DATABASE, LOGGER],
          useFactory: (database: DatabaseHandle, logger: Logger): NarrativeGraphStore =>
            new NarrativeGraphStore({ database, logger }),
        },
        {
          provide: SNAPSHOT_SERVICE,
          inject: [NARRATIVE_GRAPH_STORE, EPISODE_REPOSITORY, CLOCK],
          useFactory: (
            graph: NarrativeGraphStore,
            episodes: EpisodeRepository,
            clock: Clock,
          ): SnapshotService => new SnapshotService({ graph, episodes, clock }),
        },
        {
          // The engine's own two ports, satisfied once. Nothing above this line names a
          // provider, and `RoutedStageBackends` is what makes "pin S2 to a model in the
          // settings" work without a line changing in a use-case.
          provide: STORY_ENGINE_FACTORY,
          inject: [MODEL_ROUTER, CAPABILITY_MATRIX, CLOCK, IDS, LOGGER],
          useFactory: (
            router: ModelRouter,
            matrix: CapabilityMatrix,
            clock: Clock,
            ids: Ids,
            logger: Logger,
          ): StoryEngineFactory => new StoryEngineFactory({ router, matrix, clock, ids, logger }),
        },
        {
          provide: OUTLINE_SERVICE,
          inject: [STORY_STORE, CLOCK, IDS],
          useFactory: (store: StoryStore, clock: Clock, ids: Ids): OutlineService =>
            new OutlineService({ store, clock, ids }),
        },
        {
          provide: CAST_SERVICE,
          inject: [IDS],
          useFactory: (ids: Ids): CastService => new CastService({ ids }),
        },

        // ── S1, S6, S7: the three stage handlers ──────────────────────────
        {
          provide: STYLE_STAGE_HANDLER,
          inject: [STYLE_ENGINE_PORT, STYLE_BIBLE_REPOSITORY, IDS, CLOCK, LOGGER],
          useFactory: (
            engine: StyleEnginePort,
            repository: StyleBibleRepository,
            ids: Ids,
            clock: Clock,
            logger: Logger,
          ): StyleStageHandler => new StyleStageHandler({ engine, repository, ids, clock, logger }),
        },
        {
          provide: PRODUCE_STAGE_HANDLER,
          inject: [
            RESOLVE_ASSET_DEMAND_USE_CASE,
            REGISTER_ASSET_VERSION_USE_CASE,
            PRODUCE_LANES,
            BLOB_STORE,
            PRODUCE_CHECKPOINTS,
            STYLE_BIBLE_REPOSITORY,
            PRODUCE_RECORD_STORE,
            COST_SERVICE,
            RUN_EVENT_BUS,
            RUN_REPOSITORY,
            IDS,
            CLOCK,
            LOGGER,
          ],
          useFactory: (
            resolver: ResolveAssetDemandUseCase,
            registrar: RegisterAssetVersionUseCase,
            lanes: ProduceLanes,
            blobs: BlobStore,
            checkpoints: ProduceCheckpointStore,
            styles: StyleBibleRepository,
            records: ProduceRecordStore,
            cost: CostService,
            events: RunEventBus,
            runs: RunRepository,
            ids: Ids,
            clock: Clock,
            logger: Logger,
          ): ProduceStageHandler =>
            new ProduceStageHandler({
              resolver,
              registrar,
              lanes,
              raster: new PngRaster(),
              matting: produceMatting(),
              blobs,
              checkpoints,
              styles,
              records,
              cost: { cost, events, runs, logger },
              ids,
              clock,
              logger,
            }),
        },
        {
          provide: SEQUENCE_STAGE_HANDLER,
          inject: [
            STYLE_BIBLE_REPOSITORY,
            SHOT_LIST_STORE,
            STORY_ENGINE_FACTORY,
            MODEL_ROUTER,
            METERED_CALL_RUNNER,
            CLOCK,
            LOGGER,
          ],
          useFactory: (
            styles: StyleBibleRepository,
            shotLists: ShotListStore,
            engines: StoryEngineFactory,
            router: ModelRouter,
            meter: MeteredCallRunner,
            clock: Clock,
            logger: Logger,
          ): SequenceStageHandler =>
            new SequenceStageHandler({
              styles,
              shotLists,
              engine: (scoped: Logger) => engines.create(scoped),
              router,
              meter,
              clock,
              logger,
            }),
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
            OUTLINE_SERVICE,
            STORY_STORE,
            CHARACTER_STATE_STORE,
            NARRATIVE_GRAPH_STORE,
            CAST_SERVICE,
            STORY_ENGINE_FACTORY,
            SERIES_REPOSITORY,
            METERED_CALL_RUNNER,
            MODEL_ROUTER,
            IDS,
            STYLE_STAGE_HANDLER,
            PRODUCE_STAGE_HANDLER,
            SEQUENCE_STAGE_HANDLER,
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
            outline: OutlineService,
            storyStore: StoryStore,
            states: CharacterStateStore,
            graph: NarrativeGraphStore,
            cast: CastService,
            engines: StoryEngineFactory,
            series: SeriesRepository,
            meter: MeteredCallRunner,
            router: ModelRouter,
            ids: Ids,
            style: StyleStageHandler,
            produce: ProduceStageHandler,
            sequence: SequenceStageHandler,
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
                {
                  story: new StoryStageHandler({
                    outline,
                    store: storyStore,
                    series,
                    engine: (scoped: Logger) => engines.create(scoped),
                    meter,
                    router,
                    clock,
                    logger,
                  }),
                  cast: new CastStageHandler({
                    cast,
                    story: storyStore,
                    states,
                    graph,
                    engine: (scoped: Logger) => engines.create(scoped),
                    // The model a generate on the state grid would run on, recorded on
                    // the grid so the screen can show an estimate line without knowing
                    // the settings stack.
                    imageModel:
                      config.providers.gemini.apiKey === null
                        ? null
                        : `gemini:${config.providers.gemini.imageModel}`,
                    meter,
                    router,
                    logger,
                  }),
                  world: new WorldStageHandler({
                    graph,
                    story: storyStore,
                    backends: engines.backends,
                    ids,
                    meter,
                    router,
                    clock,
                    logger,
                  }),
                },
                animationStages({
                  renderers,
                  encoder,
                  prober,
                  compositions,
                  clock,
                  logger,
                  workspaceDir: config.paths.workspaceDir,
                }),
                { style, produce, sequence },
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
        REGISTER_ASSET_VERSION_USE_CASE,
        ASSET_LIBRARY_QUERY,
        ASSET_DEMAND_SERVICE,
        PRODUCE_RECORD_STORE,
        PRODUCE_LANES,
        PRODUCE_CHECKPOINTS,
        REGENERATE_ASSET_USE_CASE,
        STYLE_BIBLE_REPOSITORY,
        SHOT_LIST_STORE,
        STYLE_STAGE_HANDLER,
        PRODUCE_STAGE_HANDLER,
        SEQUENCE_STAGE_HANDLER,
        STORY_STORE,
        OUTLINE_SERVICE,
        STORY_ENGINE_FACTORY,
        CHARACTER_STATE_STORE,
        CAST_SERVICE,
        NARRATIVE_GRAPH_STORE,
        SNAPSHOT_SERVICE,
        JOB_QUEUE,
        STAGE_REGISTRY,
        PIPELINE_RUNNER,
      ],
      global: true,
    };
  }
}
