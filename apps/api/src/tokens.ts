/**
 * Every DI token in one file, and the list a test counts.
 *
 * Two reasons this is a module of its own rather than a constant next to each module.
 *
 * First, the dependency rule (architecture §1) is only real if it holds at *runtime*.
 * A controller that imports a concrete adapter typechecks and passes
 * `pnpm arch:check` right up until someone points the graph at a vendor SDK; a
 * controller that can only name a token cannot import one at all. So the token is the
 * seam, and `app.module.ts` is the single place a token meets a class.
 *
 * Second, RV-180 asks for an assertion that "the count of registered tokens equals the
 * count of declared ports". That is only checkable if the declaration is data, which
 * is what {@link PORT_TOKENS} is.
 *
 * Tokens are strings rather than symbols on purpose: an unresolved symbol token prints
 * as `Symbol(...)` in Nest's dependency error and an unresolved string token prints
 * its own name, which is the difference between a five-second and a fifteen-minute
 * diagnosis.
 */

// ── platform capabilities ───────────────────────────────────────────────────

/** `Clock` from `@rv/shared-kernel`. Nothing reads the wall clock directly (#1). */
export const CLOCK = 'CLOCK';
/** `Logger` from `@rv/shared-kernel`, backed by pino in the composition root. */
export const LOGGER = 'LOGGER';
/** `Ids` from `@rv/contracts` - the only minter of branded ids. */
export const IDS = 'IDS';
/** `Rng` from `@rv/shared-kernel`, seeded from config so retries replay. */
export const RNG = 'RNG';
/** The validated `AppConfig`. */
export const APP_CONFIG = 'APP_CONFIG';

// ── provider ports (architecture §5) ────────────────────────────────────────

export const TEXT_GENERATION_PORT = 'TEXT_GENERATION_PORT';
export const STRUCTURED_GENERATION_PORT = 'STRUCTURED_GENERATION_PORT';
export const IMAGE_GENERATION_PORT = 'IMAGE_GENERATION_PORT';
export const IMAGE_EDIT_PORT = 'IMAGE_EDIT_PORT';
export const VISION_SCORING_PORT = 'VISION_SCORING_PORT';
export const EMBEDDING_PORT = 'EMBEDDING_PORT';

/** `CapabilityMatrix` - what the router is allowed to ask for. */
export const CAPABILITY_MATRIX = 'CAPABILITY_MATRIX';
/** `ModelRouter` - `(task, tier, policy)` to an ordered chain. */
export const MODEL_ROUTER = 'MODEL_ROUTER';
/**
 * `CostService` - the ledger and the budget guard, per project.
 *
 * One token rather than a `COST_METER` and a `BUDGET_GUARD`, because both are
 * *per-project* objects: `CostMeter` takes a `ProjectId` in its constructor and
 * `BudgetGuard` is built over one meter. A singleton of either would be a ledger that
 * mixes two projects' spend, which is the one thing a ledger must not do.
 */
export const COST_SERVICE = 'COST_SERVICE';
/**
 * `MeteredCallRunner` - guard, then call, then meter. In that order (#3).
 *
 * A port token rather than a plain service, because it is the *only* sanctioned way to
 * reach a provider from a stage: a call that bypassed it would be unmetered and
 * unguarded, and nothing else would notice.
 */
export const METERED_CALL_RUNNER = 'METERED_CALL_RUNNER';
/**
 * `LedgerService` - the bill, read from `usage_records` rather than from memory.
 *
 * A separate token from `COST_SERVICE` because they are separate concerns with
 * different storage: the guard has to be fast and in-process, the report has to be
 * durable and cross-process. One token would have made "which one does this read from"
 * a question about the method name.
 */
export const LEDGER_SERVICE = 'LEDGER_SERVICE';
/** `ResponseCache` - never pay twice for a byte-identical request. */
export const RESPONSE_CACHE = 'RESPONSE_CACHE';

// ── persistence ports ───────────────────────────────────────────────────────

/** `DatabaseHandle` from `@rv/persistence`. */
export const DATABASE = 'DATABASE';
/** `AssetRepository`, declared by `@rv/asset-registry`. */
export const ASSET_REPOSITORY = 'ASSET_REPOSITORY';
/** `BlobStore`, declared by `@rv/asset-registry`. */
export const BLOB_STORE = 'BLOB_STORE';
/** `AssetCostEstimator`, declared by `@rv/asset-registry`. */
export const ASSET_COST_ESTIMATOR = 'ASSET_COST_ESTIMATOR';
/** `ProjectRepository`, declared in this app - see `src/application/ports`. */
export const PROJECT_REPOSITORY = 'PROJECT_REPOSITORY';
/** `SeriesRepository`, declared in this app. */
export const SERIES_REPOSITORY = 'SERIES_REPOSITORY';
/** `EpisodeRepository`, declared in this app, over the `episodes` table. */
export const EPISODE_REPOSITORY = 'EPISODE_REPOSITORY';
/** `RunRepository`, declared in this app, over the `runs` table. */
export const RUN_REPOSITORY = 'RUN_REPOSITORY';
/**
 * `RunPayloadStore` - the durable copy of what a run was started with.
 *
 * Separate from `RUN_REPOSITORY` because the payload is megabytes of `AnimationIR` and
 * `RunSummary` is polled by every open progress bar. See the port for the whole story.
 */
export const RUN_PAYLOAD_STORE = 'RUN_PAYLOAD_STORE';
/**
 * `SettingsRepository`, declared by `@rv/settings` and implemented in `@rv/persistence`.
 *
 * The port the settings screen writes through. It stores the global, project and run
 * layers and *refuses* the machine layer, which is `.env` and belongs to the process
 * rather than to a row that gets backed up and exported.
 */
export const SETTINGS_REPOSITORY = 'SETTINGS_REPOSITORY';
/**
 * `MachineLayerLoad` - `.env`, read once through the registry, with its complaints.
 *
 * A value rather than a service because the machine layer cannot change while the
 * process runs: it is read at boot, and a setting whose descriptor says
 * `requiresRestart` is telling the truth about this token.
 */
export const MACHINE_SETTINGS = 'MACHINE_SETTINGS';
/** `StyleBibleReader` - "is this style locked", for the projects list. */
export const STYLE_BIBLE_READER = 'STYLE_BIBLE_READER';

// ── orchestration ───────────────────────────────────────────────────────────

/** `JobQueue` - BullMQ when `REDIS_URL` is set, in-process when it is not. */
export const JOB_QUEUE = 'JOB_QUEUE';
/** `RunEventBus` - what the SSE endpoint subscribes to. */
export const RUN_EVENT_BUS = 'RUN_EVENT_BUS';
/** `StageRegistry` - stage id to its handler, so there is no `switch` on a stage. */
export const STAGE_REGISTRY = 'STAGE_REGISTRY';

// ── engine ports, several of them still scaffolds ───────────────────────────

/** `StyleEnginePort` - S1. Stubbed until `@rv/style-engine` is implemented. */
export const STYLE_ENGINE_PORT = 'STYLE_ENGINE_PORT';
/** `StoryEnginePort` - S2/S3/S4/S7. Stubbed until `@rv/story-engine` exists. */
export const STORY_ENGINE_PORT = 'STORY_ENGINE_PORT';
/** `AssetProductionPort` - S6. Stubbed until `@rv/asset-engine` exists. */
export const ASSET_PRODUCTION_PORT = 'ASSET_PRODUCTION_PORT';
/** `NarrativeMemoryPort` - the graph. Stubbed until `@rv/narrative-memory` exists. */
export const NARRATIVE_MEMORY_PORT = 'NARRATIVE_MEMORY_PORT';
/** `RenderPort` - the one-shot render/deliver call. S11 is still a stub behind it. */
export const RENDER_PORT = 'RENDER_PORT';
/**
 * `FrameRenderer` map - the backends S10 may draw with, by id.
 *
 * A token rather than a construction inside the stage handler so a test can install a
 * backend that draws something cheap, and so a deployment with no Skia binding fails at
 * boot with a name rather than at frame 1 of a long render.
 */
export const FRAME_RENDERERS = 'FRAME_RENDERERS';
/** `FfmpegEncoder` over the configured binary paths. */
export const VIDEO_ENCODER = 'VIDEO_ENCODER';
/** `FfprobeReader` - what came out, as opposed to what was asked for. */
export const VIDEO_PROBER = 'VIDEO_PROBER';
/**
 * `ReframeService` - one composition to a crop per format, without rendering anything.
 *
 * A token of its own rather than a method on the render port because it is pure
 * geometry: no encoder, no disk, no money, and answerable while the user is still
 * choosing formats.
 */
export const REFRAME_SERVICE = 'REFRAME_SERVICE';
/** `DeliveryService` - what a run actually put on disk, measured. */
export const DELIVERY_SERVICE = 'DELIVERY_SERVICE';
/**
 * `CompositionStore` - `AnimationIR` by content hash, so a run can name one.
 *
 * The studio cannot start a render without a composition and has no way to build one;
 * this is where the ones that exist live. Content-addressed rather than id-addressed
 * because ADR-0001 requires a render to be reproducible from its input, and only a hash
 * cannot point at something else later.
 */
export const COMPOSITION_STORE = 'COMPOSITION_STORE';

/**
 * Every port token the app declares.
 *
 * `app.spec.ts` resolves each one against a booted application context. A token added
 * here without a binding fails that test, which is the runtime half of the dependency
 * rule `pnpm arch:check` enforces statically.
 */
export const PORT_TOKENS = [
  CLOCK,
  LOGGER,
  IDS,
  RNG,
  APP_CONFIG,

  TEXT_GENERATION_PORT,
  STRUCTURED_GENERATION_PORT,
  IMAGE_GENERATION_PORT,
  IMAGE_EDIT_PORT,
  VISION_SCORING_PORT,
  EMBEDDING_PORT,
  CAPABILITY_MATRIX,
  MODEL_ROUTER,
  COST_SERVICE,
  LEDGER_SERVICE,
  METERED_CALL_RUNNER,
  RESPONSE_CACHE,

  DATABASE,
  ASSET_REPOSITORY,
  BLOB_STORE,
  ASSET_COST_ESTIMATOR,
  PROJECT_REPOSITORY,
  SERIES_REPOSITORY,
  EPISODE_REPOSITORY,
  RUN_REPOSITORY,
  RUN_PAYLOAD_STORE,
  SETTINGS_REPOSITORY,
  MACHINE_SETTINGS,
  STYLE_BIBLE_READER,

  JOB_QUEUE,
  RUN_EVENT_BUS,
  STAGE_REGISTRY,

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
] as const;

export type PortToken = (typeof PORT_TOKENS)[number];
