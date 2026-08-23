/**
 * Configuration to a registered set of provider adapters.
 *
 * This file, `@rv/providers` and nothing else may name a vendor. It is the composition
 * root's provider half: it reads the machine layer, constructs only the adapters that
 * are actually configured, and registers each one with the `CapabilityMatrix` - which
 * checks the declaration against the methods that are really there and throws at
 * wiring time if they disagree.
 *
 * **An unconfigured provider is not registered.** A Gemini adapter with no key would
 * enter the router's failover chain and burn a round trip and a retry on every call
 * before failing with a 401. Absence is the honest encoding of "there is no point
 * asking", and the health endpoint reports it as such.
 */

import type { Capability } from '@rv/contracts';
import {
  ComfyUiAdapter,
  GeminiAdapter,
  OllamaAdapter,
  OpenRouterAdapter,
  CapabilityMatrix,
  loadComfyWorkflows,
  type ProviderAdapter,
} from '@rv/providers';
import { isErr, type Logger } from '@rv/shared-kernel';

import type { AppConfig } from '../../config/app-config';

/** What was built, and what was skipped and why. Reported by `/api/health`. */
export interface AdapterSet {
  readonly matrix: CapabilityMatrix;
  readonly adapters: readonly ProviderAdapter[];
  readonly skipped: readonly { readonly provider: string; readonly reason: string }[];
}

/**
 * Ollama registers twice: one adapter for text, one for embeddings.
 *
 * Both are narrowed rather than left at `OLLAMA_CAPABILITIES`. The default set is what
 * the *server* can do, not what a given model can: `qwen3.5` has an `embed` method
 * behind it and produces a vector that is not an embedding in any useful sense, and
 * `nomic-embed-text` will happily be asked to write a scene. The router would then have
 * two candidates for every embed and pick on price, which is zero for both.
 */
function buildOllama(config: AppConfig): readonly ProviderAdapter[] {
  const host = config.providers.ollama.host;
  if (host === null) return [];

  const generative: readonly Capability[] = [
    'text-generation',
    'structured-generation',
    'vision-scoring',
  ];
  const embeddingOnly: readonly Capability[] = ['embedding'];

  return [
    new OllamaAdapter({
      model: config.providers.ollama.textModel,
      baseUrl: host,
      capabilities: generative,
    }),
    new OllamaAdapter({
      model: config.providers.ollama.embedModel,
      baseUrl: host,
      capabilities: embeddingOnly,
    }),
  ];
}

function buildGemini(config: AppConfig): readonly ProviderAdapter[] {
  const apiKey = config.providers.gemini.apiKey;
  if (apiKey === null) return [];

  const { textModel, imageModel } = config.providers.gemini;
  const adapters = [new GeminiAdapter({ apiKey, model: textModel })];
  // Only if it is a different model: registering the same `provider:model` twice is a
  // `ValidationError` from the matrix, by design.
  if (imageModel !== textModel) adapters.push(new GeminiAdapter({ apiKey, model: imageModel }));
  return adapters;
}

function buildOpenRouter(config: AppConfig): readonly ProviderAdapter[] {
  const apiKey = config.providers.openrouter.apiKey;
  if (apiKey === null) return [];

  const { textModel, imageModel, siteUrl, appName } = config.providers.openrouter;
  const shared = { apiKey, referer: siteUrl, title: appName };
  const adapters = [new OpenRouterAdapter({ ...shared, model: textModel })];
  if (imageModel !== textModel) {
    adapters.push(new OpenRouterAdapter({ ...shared, model: imageModel }));
  }
  return adapters;
}

/**
 * Builds every configured adapter and registers it.
 *
 * Async only because ComfyUI's workflow graphs come off disk. Everything else is
 * construction.
 */
export async function buildAdapters(config: AppConfig, logger: Logger): Promise<AdapterSet> {
  const log = logger.child({ component: 'providers' });
  const matrix = new CapabilityMatrix();
  const skipped: { provider: string; reason: string }[] = [];

  const adapters: ProviderAdapter[] = [
    ...buildOllama(config),
    ...buildGemini(config),
    ...buildOpenRouter(config),
  ];

  if (config.providers.ollama.host === null) {
    skipped.push({ provider: 'ollama', reason: 'OLLAMA_HOST is not set' });
  }
  if (config.providers.gemini.apiKey === null) {
    skipped.push({ provider: 'gemini', reason: 'GEMINI_API_KEY is not set' });
  }
  if (config.providers.openrouter.apiKey === null) {
    skipped.push({ provider: 'openrouter', reason: 'OPENROUTER_API_KEY is not set' });
  }

  const comfy = config.providers.comfyui;
  if (!comfy.enabled || comfy.host === null) {
    skipped.push({
      provider: 'comfyui',
      reason: comfy.enabled ? 'COMFYUI_HOST is not set' : 'RV_COMFYUI_ENABLED is false',
    });
  } else {
    const workflows = await loadComfyWorkflows(config.paths.comfyWorkflowDir);
    if (isErr(workflows)) {
      // A missing workflow file is an operator problem, not a reason to refuse to
      // start: every other lane still works, and the health endpoint names this one.
      skipped.push({ provider: 'comfyui', reason: workflows.error.message });
      log.warn('comfyui not registered', { reason: workflows.error.message });
    } else {
      adapters.push(new ComfyUiAdapter({ workflows: workflows.value, baseUrl: comfy.host }));
    }
  }

  matrix.registerAll(adapters);
  log.info('providers registered', {
    registered: adapters.map((adapter) => adapter.modelRef),
    skipped: skipped.map((entry) => entry.provider),
  });

  return { matrix, adapters, skipped };
}
