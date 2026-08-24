/**
 * Tokens for things that are injected but are not ports.
 *
 * `tokens.ts` is the port registry and `app.spec.ts` counts it, so a service that is
 * merely convenient - the pipeline runner, the adapter set, a use-case instance - must
 * not be in that list or the count stops meaning "every declared port is bound".
 *
 * They are still tokens rather than class references because nothing in this app relies
 * on `design:paramtypes`: esbuild, which Vitest transforms with, does not emit it, so a
 * constructor parameter typed by its class would resolve to `Object` and fail at boot.
 * One convention applied everywhere beats two that differ by build tool.
 */

/** `AdapterSet` from `infrastructure/providers/build-adapters`. */
export const ADAPTER_SET = 'ADAPTER_SET';
/** `PipelineRunner`. */
export const PIPELINE_RUNNER = 'PIPELINE_RUNNER';
/** `ResolveAssetDemandUseCase` from `@rv/asset-registry`. */
export const RESOLVE_ASSET_DEMAND_USE_CASE = 'RESOLVE_ASSET_DEMAND_USE_CASE';
/** `FindSimilarAssetsUseCase` from `@rv/asset-registry`. */
export const FIND_SIMILAR_ASSETS_USE_CASE = 'FIND_SIMILAR_ASSETS_USE_CASE';
/** `SettingsService` - the registry, the resolver and the patch validator, assembled. */
export const SETTINGS_SERVICE = 'SETTINGS_SERVICE';
/** `ProjectSummaryService` - the projects read-model the studio's list screen needs. */
export const PROJECT_SUMMARY_SERVICE = 'PROJECT_SUMMARY_SERVICE';
/** `RegisterAssetVersionUseCase` from `@rv/asset-registry` - the one door into the library. */
export const REGISTER_ASSET_VERSION_USE_CASE = 'REGISTER_ASSET_VERSION_USE_CASE';
/** `AssetLibraryQuery` - the read model behind `GET /api/assets`. */
export const ASSET_LIBRARY_QUERY = 'ASSET_LIBRARY_QUERY';
/** `AssetDemandService` - `GET /api/assets/demand/plan` over the recorded specs. */
export const ASSET_DEMAND_SERVICE = 'ASSET_DEMAND_SERVICE';
/** `ProduceRecordStore` - what S6 knows about a key that the registry does not store. */
export const PRODUCE_RECORD_STORE = 'PRODUCE_RECORD_STORE';
/** `RegenerateAssetVersionUseCase` - the only path that spends money on a second take. */
export const REGENERATE_ASSET_USE_CASE = 'REGENERATE_ASSET_USE_CASE';
/** `ProduceLanes` - which image port draws which generation lane. */
export const PRODUCE_LANES = 'PRODUCE_LANES';
/** `ProduceCheckpointStore` from `@rv/persistence` - S6's per-step resume points. */
export const PRODUCE_CHECKPOINTS = 'PRODUCE_CHECKPOINTS';
/** `StyleBibleRepository` - read and write for a bible between choose, probe and lock. */
export const STYLE_BIBLE_REPOSITORY = 'STYLE_BIBLE_REPOSITORY';
/** `ShotListStore` - what S7 produced, until a scene has a row to hang shots off. */
export const SHOT_LIST_STORE = 'SHOT_LIST_STORE';
/**
 * The three stage handlers this workstream owns, each on its own token.
 *
 * A token per handler rather than three more positional parameters on the stage-registry
 * factory: that factory is already the most-edited function in this file, and a handler
 * built at its own binding is one line to move when a dependency changes rather than four
 * spread across an `inject` array and a parameter list.
 */
export const STYLE_STAGE_HANDLER = 'STYLE_STAGE_HANDLER';
export const PRODUCE_STAGE_HANDLER = 'PRODUCE_STAGE_HANDLER';
export const SEQUENCE_STAGE_HANDLER = 'SEQUENCE_STAGE_HANDLER';
