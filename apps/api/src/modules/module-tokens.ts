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
