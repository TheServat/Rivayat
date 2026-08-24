/**
 * `@rv/providers` - every outward capability, behind a narrow port.
 *
 * This is the infrastructure layer of architecture §1: nothing above it may import a
 * vendor SDK, and `pnpm arch:check` fails the build if anything tries. What it exports
 * is ports, adapters that satisfy them, and the three things that decide *which*
 * adapter runs and what it is allowed to cost - the router, the meter and the guard.
 */

// ── ports ───────────────────────────────────────────────────────────────────
export type {
  ImagePayload,
  ImageArtifact,
  ProviderUsage,
  ProviderCallResult,
  ProviderAdapter,
  TextGenerationRequest,
  TextGenerationResult,
  TextGenerationPort,
  ImageCostQuote,
  ImageCostRequest,
  ImageGenerationRequest,
  ImageResult,
  ImageGenerationPort,
  ImageEditRequest,
  ImageEditPort,
  PartsSheetRequest,
  PartsSheetPort,
  VisionRubricCriterion,
  VisionScoringRequest,
  VisionScore,
  VisionScoringResult,
  VisionScoringPort,
  EmbeddingRequest,
  EmbeddingResult,
  EmbeddingPort,
  PortByCapability,
  CapabilityMethod,
} from './ports';
export {
  toImageArtifact,
  usage,
  NO_TOKENS,
  NO_IMAGES,
  declaresCapability,
  projectedNanoUsd,
  supportsPartsSheet,
  VisionScoreSheet,
  buildRubricPrompt,
  parseScoreSheet,
  CapabilityMatrix,
  CAPABILITY_METHOD,
} from './ports';

// ── http ────────────────────────────────────────────────────────────────────
export type { FetchLike, JsonHttpOptions, RequestOptions } from './http/json-http';
export { JsonHttpClient } from './http/json-http';
export type { HttpFailure, ThrownFailure } from './http/errors';
export { parseRetryAfterMs, errorFromResponse, errorFromThrown, errorFromSdk } from './http/errors';

// ── adapters ────────────────────────────────────────────────────────────────
export type { OllamaAdapterOptions } from './adapters/ollama/ollama-adapter';
export {
  OllamaAdapter,
  OLLAMA_CAPABILITIES,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_RECOMMENDED_VISION_MODEL,
} from './adapters/ollama/ollama-adapter';

export type {
  GeminiAdapterOptions,
  GeminiClient,
  GeminiModelsApi,
} from './adapters/gemini/gemini-adapter';
export {
  GeminiAdapter,
  GEMINI_CAPABILITIES,
  GEMINI_TEXT_CAPABILITIES,
} from './adapters/gemini/gemini-adapter';

export type { OpenRouterAdapterOptions } from './adapters/openrouter/openrouter-adapter';
export {
  OpenRouterAdapter,
  OPENROUTER_CAPABILITIES,
  OPENROUTER_DEFAULT_BASE_URL,
} from './adapters/openrouter/openrouter-adapter';
export type {
  CatalogueEntry,
  CatalogueSnapshot,
  CatalogueDrift,
  DriftKind,
} from './adapters/openrouter/catalogue';
export { buildSnapshot, reconcile, toCatalogueEntry } from './adapters/openrouter/catalogue';

export type { ComfyUiAdapterOptions, ComfyWorkflowSet } from './adapters/comfyui/comfyui-adapter';
export {
  ComfyUiAdapter,
  COMFYUI_CAPABILITIES,
  COMFYUI_DEFAULTS,
  COMFYUI_DEFAULT_BASE_URL,
  COMFYUI_MAX_DIMENSION,
  COMFYUI_PARTS_SHEET_DEFAULTS,
  COMFYUI_RECOMMENDED_DIMENSION,
} from './adapters/comfyui/comfyui-adapter';
export type { BuiltGraph, PlaceholderValues } from './adapters/comfyui/workflow';
export { buildGraph, NUMERIC_PLACEHOLDERS } from './adapters/comfyui/workflow';
export {
  COMFY_OPTIONAL_WORKFLOW_FILES,
  COMFY_WORKFLOW_FILES,
  loadComfyWorkflows,
} from './adapters/comfyui/load-workflows';

// ── routing ─────────────────────────────────────────────────────────────────
export type {
  RouteRequest,
  RouteSource,
  ResolvedRoute,
  FailoverStep,
  RoutedOutcome,
  ModelRouterDeps,
  ExecuteOptions,
} from './routing/model-router';
export { ModelRouter } from './routing/model-router';
export { TASK_CAPABILITY, capabilityForTask } from './routing/task-capability';
export type { RetryOptions } from './routing/retry';
export { withRetry, computeBackoffMs } from './routing/retry';

// ── cost ────────────────────────────────────────────────────────────────────
export {
  IMAGE_OUTPUT_TOKENS_PER_1K_IMAGE,
  UNPRICED,
  estimateImageOutputTokens,
  findModelDescriptor,
  pricingFor,
  priceCall,
  quoteImageCall,
} from './cost/pricing';
export type { RecordCallInput, CostMeterDeps, SpendReader } from './cost/cost-meter';
export { CostMeter } from './cost/cost-meter';
export type { BudgetCheck, BudgetGuardDeps } from './cost/budget-guard';
export { BudgetGuard } from './cost/budget-guard';

// ── cache ───────────────────────────────────────────────────────────────────
export type {
  CacheKeyInput,
  CacheEntry,
  ResponseCache,
  InMemoryResponseCacheOptions,
} from './cache/response-cache';
export { cacheKey, InMemoryResponseCache } from './cache/response-cache';
