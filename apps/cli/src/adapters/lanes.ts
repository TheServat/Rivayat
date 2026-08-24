/**
 * The CLI's composition root: environment in, ports out.
 *
 * This is the only place in `apps/cli` that names a concrete adapter. Everything under
 * `src/commands` takes a port, which is why a command can be tested with a fake image
 * lane and no GPU, and why `pnpm arch:check` stays green - a use-case that imported
 * `ComfyUiAdapter` would be an application layer importing infrastructure.
 *
 * Lanes are `Partial`, not required. `GenerateStyleProbeUseCase` documents the reason:
 * an unwired lane should be a missing key the use-case reports by name, not an adapter
 * that throws the first time somebody draws with it. So a machine with no ComfyUI and
 * no Gemini key gets an empty map and a precise refusal, not a stack trace.
 */

import {
  COMFYUI_DEFAULT_BASE_URL,
  ComfyUiAdapter,
  GeminiAdapter,
  OllamaAdapter,
  loadComfyWorkflows,
  type ImageGenerationPort,
} from '@rv/providers';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { StructuredBackend } from '@rv/prompt-kit';
import { type AppError, type Clock, type Result, isErr, ok } from '@rv/shared-kernel';

/**
 * The repository root, found by walking up for the workspace manifest.
 *
 * `rv` is run from wherever the user happens to be - the repo root during a demo, the
 * package directory during development - and `tools/comfy-workflows` is repo-relative.
 * Resolving it against `process.cwd()` made the free image lane work from one directory
 * and fail from every other one, which reads as "ComfyUI is not installed".
 */
export function repositoryRoot(cwd: string): string {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/** Where the free image lane's graphs live. Overridable for a non-default checkout. */
export function workflowDir(env: NodeJS.ProcessEnv, cwd: string): string {
  return env.RV_COMFYUI_WORKFLOW_DIR ?? join(repositoryRoot(cwd), 'tools', 'comfy-workflows');
}

export interface ImageLanes {
  readonly lanes: Partial<Record<'free' | 'paid', ImageGenerationPort>>;
  /** Why a lane is absent, keyed by lane. Printed rather than swallowed. */
  readonly unavailable: Readonly<Record<string, string>>;
}

export interface BuildImageLanesOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly clock: Clock;
  /** Sampler steps for the free lane. 6 is the measured draft setting (research §0). */
  readonly steps?: number;
}

/**
 * Wires whichever image lanes this machine can actually serve.
 *
 * Never throws and never probes the network: reachability is `rv doctor`'s job, and a
 * lane that is wired but unreachable must fail at the call with the provider's own
 * error rather than here with a guess.
 */
export async function buildImageLanes(
  options: BuildImageLanesOptions,
): Promise<Result<ImageLanes, AppError>> {
  const lanes: Partial<Record<'free' | 'paid', ImageGenerationPort>> = {};
  const unavailable: Record<string, string> = {};

  const workflows = await loadComfyWorkflows(workflowDir(options.env, options.cwd));
  if (isErr(workflows)) {
    unavailable.free = workflows.error.message;
  } else {
    lanes.free = new ComfyUiAdapter({
      workflows: workflows.value,
      baseUrl: options.env.COMFYUI_HOST ?? COMFYUI_DEFAULT_BASE_URL,
      clock: options.clock,
      ...(options.steps === undefined ? {} : { defaults: { steps: options.steps } }),
      generationTimeoutMs: 300_000,
    });
  }

  const apiKey = options.env.GEMINI_API_KEY ?? '';
  if (apiKey === '') {
    unavailable.paid = 'GEMINI_API_KEY is not set';
  } else {
    lanes.paid = new GeminiAdapter({
      apiKey,
      model: options.env.RV_GEMINI_IMAGE_MODEL ?? 'gemini-3.1-flash-lite-image',
      clock: options.clock,
    });
  }

  return ok({ lanes, unavailable });
}

export interface TextBackendOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clock: Clock;
  /** `provider:model`, or a bare Ollama model id. Defaults to the local free lane. */
  readonly binding?: string | undefined;
}

export interface TextBackends {
  readonly chain: readonly StructuredBackend[];
  /** What the chain resolved to, for the run log. */
  readonly modelRef: string;
}

/**
 * The structured-generation chain for a text stage.
 *
 * One binding, resolved here rather than routed, because a CLI invocation has already
 * decided: `--model` or the stage pin from the settings stack is the answer, and
 * `FixedStageBackends` exists in `@rv/story-engine` for exactly this caller. Failover
 * across providers is the router's job and the router needs a capability matrix, which
 * a single-shot command has no use for.
 */
export function buildTextBackends(options: TextBackendOptions): Result<TextBackends, AppError> {
  const binding =
    options.binding ?? `ollama:${options.env.RV_OLLAMA_TEXT_MODEL ?? 'qwen3.5:latest'}`;
  const separator = binding.indexOf(':');
  const provider = separator < 0 ? 'ollama' : binding.slice(0, separator);
  const model = separator < 0 ? binding : binding.slice(separator + 1);

  if (provider === 'gemini') {
    const apiKey = options.env.GEMINI_API_KEY ?? '';
    if (apiKey === '') {
      return ok({ chain: [], modelRef: binding });
    }
    return ok({
      chain: [new GeminiAdapter({ apiKey, model, clock: options.clock })],
      modelRef: binding,
    });
  }

  return ok({
    chain: [
      new OllamaAdapter({
        model,
        ...(options.env.OLLAMA_HOST === undefined ? {} : { baseUrl: options.env.OLLAMA_HOST }),
        timeoutMs: 300_000,
      }),
    ],
    modelRef: `ollama:${model}`,
  });
}
