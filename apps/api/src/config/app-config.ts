/**
 * Environment to the shape the rest of the app actually consults.
 *
 * `EnvSchema` describes what the file looks like; this describes what the code needs.
 * The two are different on purpose - nothing downstream should have to know that the
 * budget is three separate `RV_BUDGET_*` keys, or reconstruct "is the queue in-process"
 * from the presence of a string. The transform is where that knowledge lives, once.
 *
 * `AppConfig` is `z.infer`red from the transform rather than declared beside it
 * (CLAUDE.md §1.5): a hand-written interface here is a second source of truth that
 * drifts the first time a key is added.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { BudgetPolicy, RouterConfig } from '@rv/contracts';
import { ValidationError, type Result, err, ok } from '@rv/shared-kernel';
import { z } from 'zod';

import { EnvSchema } from './env.schema';

/**
 * The directory `./workspace` is relative to.
 *
 * Not `process.cwd()`, and that is the whole point. `RV_WORKSPACE_DIR=./workspace` lives
 * in one `.env` at the repository root and has to mean one directory - but the API is
 * launched from `apps/api` by `pnpm --filter @rv/api dev`, the CLI from the root by
 * `rv animate`, and a bare `node dist/main.js` from wherever the operator happens to be.
 * Resolved against the process directory, that single setting silently names three
 * different workspaces, and the symptom is exactly the one that produced this function:
 * `rv animate` wrote two videos into `workspace/demo` and the API, looking in
 * `apps/api/workspace/demo`, reported them missing.
 *
 * Found by walking up for `pnpm-workspace.yaml` rather than by counting `..` segments,
 * so it survives this file moving. If there is no marker - a published build, running
 * from `dist` - the process directory is the honest answer and is what gets used.
 */
function workspaceRoot(): string {
  let current = process.cwd();
  for (;;) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

/** A configured path, made absolute. An absolute one is already an answer. */
function fromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(workspaceRoot(), path);
}

/**
 * The same, for the database URL, whose relative form hides inside a `file:` scheme.
 *
 * `:memory:` and `file::memory:` are not paths and must survive untouched - every
 * repository test in the system opens one.
 */
function databaseUrlFromRoot(url: string): string {
  if (url === ':memory:' || url === 'file::memory:') return url;
  if (url.startsWith('file:')) {
    const path = url.slice('file:'.length);
    // `file://` is a URL with an authority, already absolute; only `file:./x` is relative.
    return path.startsWith('//') ? url : `file:${fromRoot(path)}`;
  }
  return url;
}

/**
 * Whether a provider is configured at all.
 *
 * "Configured" is not "reachable": the health endpoint answers reachability, this
 * answers whether there is any point asking. A provider with no key must not appear in
 * the router's chain, because failing over to it wastes a round trip on every call.
 */
function providerAvailability(env: z.infer<typeof EnvSchema>): {
  readonly ollama: boolean;
  readonly gemini: boolean;
  readonly openrouter: boolean;
  readonly comfyui: boolean;
} {
  return {
    ollama: env.OLLAMA_HOST !== null,
    gemini: env.GEMINI_API_KEY !== null,
    openrouter: env.OPENROUTER_API_KEY !== null,
    comfyui: env.RV_COMFYUI_ENABLED && env.COMFYUI_HOST !== null,
  };
}

const toAppConfig = (env: z.infer<typeof EnvSchema>) =>
  ({
    env: env.NODE_ENV,
    logLevel: env.RV_LOG_LEVEL,
    seed: env.RV_SEED,

    http: {
      port: env.RV_API_PORT,
      globalPrefix: env.RV_API_PREFIX,
      corsOrigin: env.RV_WEB_ORIGIN,
    },

    paths: {
      workspaceDir: fromRoot(env.RV_WORKSPACE_DIR),
      assetStoreDir: fromRoot(env.RV_ASSET_STORE_DIR),
      databaseUrl: databaseUrlFromRoot(env.RV_DB_URL),
      comfyWorkflowDir: fromRoot(env.RV_COMFYUI_WORKFLOW_DIR),
      ffmpegPath: env.RV_FFMPEG_PATH,
      ffprobePath: env.RV_FFPROBE_PATH,
    },

    queue: {
      /**
       * The whole of "runs with no Redis". Derived here so no module has to re-decide
       * it, and so the health endpoint reports the same answer the queue acted on.
       */
      driver: env.REDIS_URL === null ? ('in-process' as const) : ('bullmq' as const),
      redisUrl: env.REDIS_URL,
      concurrency: env.RV_QUEUE_CONCURRENCY,
    },

    providers: {
      available: providerAvailability(env),
      ollama: {
        host: env.OLLAMA_HOST,
        textModel: env.RV_OLLAMA_TEXT_MODEL,
        fastModel: env.RV_OLLAMA_FAST_MODEL,
        visionModel: env.RV_OLLAMA_VISION_MODEL,
        embedModel: env.RV_OLLAMA_EMBED_MODEL,
      },
      gemini: {
        apiKey: env.GEMINI_API_KEY,
        textModel: env.RV_GEMINI_TEXT_MODEL,
        imageModel: env.RV_GEMINI_IMAGE_MODEL,
        visionModel: env.RV_GEMINI_VISION_MODEL,
      },
      openrouter: {
        apiKey: env.OPENROUTER_API_KEY,
        siteUrl: env.OPENROUTER_SITE_URL,
        appName: env.OPENROUTER_APP_NAME,
        textModel: env.RV_OPENROUTER_TEXT_MODEL,
        imageModel: env.RV_OPENROUTER_IMAGE_MODEL,
        visionModel: env.RV_OPENROUTER_VISION_MODEL,
      },
      comfyui: {
        host: env.COMFYUI_HOST,
        enabled: env.RV_COMFYUI_ENABLED,
        remote: env.RV_COMFYUI_REMOTE,
        authToken: env.COMFYUI_AUTH_TOKEN,
      },
      huggingFaceToken: env.HF_TOKEN,
    },

    /**
     * Exactly `BudgetPolicy` from `@rv/contracts`, filled from the machine layer.
     *
     * Typed as the contract rather than as a look-alike so the guard receives the
     * shape it declares, and so a field added to the policy fails to compile here
     * instead of silently defaulting.
     */
    budget: {
      perRunNanoUsd: env.RV_BUDGET_USD_PER_RUN,
      perDayNanoUsd: env.RV_BUDGET_USD_PER_DAY,
      perProjectNanoUsd: null,
      confirmAboveNanoUsd: env.RV_CONFIRM_SPEND_ABOVE_USD,
      onExceed: 'abort',
    } satisfies BudgetPolicy,

    render: {
      backend: env.RV_RENDER_BACKEND,
      concurrency: env.RV_RENDER_CONCURRENCY,
    },
  }) as const;

/** The parsed, structured configuration. Inferred, never hand-written beside it. */
export const AppConfigSchema = EnvSchema.transform(toAppConfig);
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** Keys whose value never leaves the process (§7b: "secret"). */
export const SECRET_ENV_KEYS: readonly string[] = [
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'COMFYUI_AUTH_TOKEN',
  'HF_TOKEN',
  'REDIS_URL',
];

/**
 * Parses the environment, reporting *every* bad key rather than the first.
 *
 * A `Result` rather than a throw because the caller decides what a bad configuration
 * means: `main.ts` exits, and a test asserts the message. The composition root is the
 * only place that turns this into a fatal.
 */
export function loadConfig(raw: Record<string, unknown>): Result<AppConfig, ValidationError> {
  const parsed = AppConfigSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);

  const issues = parsed.error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${key}: ${issue.message}`;
  });

  return err(
    new ValidationError({
      message: `Invalid configuration:\n  - ${issues.join('\n  - ')}`,
      context: { issues },
      issues,
    }),
  );
}

/**
 * The router configuration the machine layer implies.
 *
 * Deliberately minimal: no rules, no pins. §7b's layered resolution puts real routing
 * policy in the global/project/run layers, and inventing rules from `.env` here would
 * put a fourth, invisible layer underneath them.
 */
export function routerConfigFrom(config: AppConfig): RouterConfig {
  return {
    projectId: null,
    defaultPolicy:
      config.providers.available.gemini || config.providers.available.openrouter
        ? 'balanced'
        : 'cheapest',
    rules: [],
    stageOverrides: {},
    taskOverrides: {},
    failover: {
      maxAttemptsPerModel: 3,
      initialBackoffMs: 500,
      backoffMultiplier: 2,
      maxBackoffMs: 30_000,
      jitter: 0.2,
      failoverOn: ['rate-limit', 'timeout', 'provider', 'unsupported'],
    },
  };
}
