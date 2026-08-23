/**
 * The machine layer of architecture §7b, as one Zod schema.
 *
 * Not `class-validator`: CLAUDE.md §1.5 makes Zod the single source of truth for every
 * shape in the system, and a second validation dialect for env alone would be a second
 * place to express the same constraint and a second place to get it wrong. The schema
 * also does the *parsing* - `"3000"` becomes `3000`, `"5.00"` becomes an integer
 * nano-dollar amount - so nothing downstream re-reads `process.env` and re-guesses a
 * type.
 *
 * Two decisions worth naming:
 *
 * - **Blank means absent.** A dotenv file cannot express "unset"; it expresses `KEY=`.
 *   Every value here is preprocessed so the two are the same thing, which is what an
 *   operator blanking a line actually intends - and it is why `REDIS_URL=` selects the
 *   in-process queue rather than dialling a host called `""`.
 * - **Failure is fatal and legible.** A server that boots with a broken configuration
 *   and fails on the first request has moved the error from the operator's terminal to
 *   a user's screen. `loadConfig` reports every bad field at once, with its key.
 */

import { fromUsd } from '@rv/shared-kernel';
import { z } from 'zod';

/**
 * Blank string to `undefined`, so the inner schema's `.default()` sees "absent".
 *
 * Applied to every field rather than to the optional ones only: `RV_API_PORT=` should
 * fall back to 3000, not fail with "expected a whole number, got NaN".
 */
function envValue<T extends z.ZodType>(inner: T): z.ZodType<z.output<T>, unknown> {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    inner,
  );
}

/** `"3000"` → `3000`; anything non-numeric fails with its own key named. */
function intEnv(min: number, max: number, fallback: number): z.ZodType<number, unknown> {
  return envValue(
    z.preprocess((value) => {
      if (typeof value !== 'string') return value;
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : value;
    }, z.number().int().min(min).max(max).default(fallback)),
  );
}

function stringEnv(fallback: string): z.ZodType<string, unknown> {
  return envValue(z.string().min(1).default(fallback));
}

/** Present-or-not, never blank. `null` is the honest encoding of "no key configured". */
function optionalEnv<T extends z.ZodType>(inner: T): z.ZodType<z.output<T> | null, unknown> {
  return envValue(inner.nullable().default(null));
}

function boolEnv(fallback: boolean): z.ZodType<boolean, unknown> {
  return envValue(
    z.preprocess((value) => {
      if (typeof value !== 'string') return value;
      const normalised = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
      if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
      return value;
    }, z.boolean().default(fallback)),
  );
}

/**
 * `"5.00"` → 5_000_000_000 nano-dollars.
 *
 * The conversion happens here, once, because money is an integer everywhere past this
 * point (`@rv/shared-kernel/money`) and a float that survives into the ledger is the
 * bug that makes ten thousand cheap calls sum to the wrong total.
 */
const usdEnv: z.ZodType<number | null, unknown> = envValue(
  z
    .preprocess((value) => {
      if (typeof value !== 'string') return value;
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : value;
    }, z.number().nonnegative('a budget ceiling cannot be negative').nullable().default(null))
    .transform((usd) => (usd === null ? null : (fromUsd(usd) as number))),
);

const urlEnv = z.url('expected an absolute URL, e.g. http://127.0.0.1:11434');

/**
 * Everything the API reads out of the environment.
 *
 * Keys match `.env.example`. A key that appears there and not here is a value nothing
 * reads - exactly the drift §7b's settings registry exists to prevent - so the two
 * lists are worth diffing when either changes.
 */
export const EnvSchema = z.object({
  NODE_ENV: envValue(z.enum(['development', 'test', 'production']).default('development')),
  RV_LOG_LEVEL: envValue(z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info')),

  RV_WORKSPACE_DIR: stringEnv('./workspace'),
  RV_ASSET_STORE_DIR: stringEnv('./workspace/assets'),
  RV_DB_URL: stringEnv('file:./workspace/rivayat.db'),

  RV_API_PORT: intEnv(1, 65_535, 3000),
  RV_API_PREFIX: stringEnv('api'),
  RV_WEB_ORIGIN: stringEnv('http://localhost:5173'),

  /** Blank selects the in-process queue. Running with no Redis at all is a constraint. */
  REDIS_URL: optionalEnv(z.string().min(1)),
  RV_QUEUE_CONCURRENCY: intEnv(1, 64, 4),

  OLLAMA_HOST: optionalEnv(urlEnv),
  RV_OLLAMA_TEXT_MODEL: stringEnv('qwen3.5:latest'),
  RV_OLLAMA_FAST_MODEL: stringEnv('qwen3:1.7b'),
  RV_OLLAMA_VISION_MODEL: stringEnv('gemma4:26b'),
  RV_OLLAMA_EMBED_MODEL: stringEnv('nomic-embed-text'),

  GEMINI_API_KEY: optionalEnv(z.string().min(1)),
  RV_GEMINI_TEXT_MODEL: stringEnv('gemini-3-flash'),
  RV_GEMINI_IMAGE_MODEL: stringEnv('gemini-3.1-flash-lite-image'),
  RV_GEMINI_VISION_MODEL: stringEnv('gemini-3-flash'),

  OPENROUTER_API_KEY: optionalEnv(z.string().min(1)),
  OPENROUTER_SITE_URL: stringEnv('http://localhost:5173'),
  OPENROUTER_APP_NAME: stringEnv('Rivayat'),
  RV_OPENROUTER_TEXT_MODEL: stringEnv('z-ai/glm-5.2:free'),
  RV_OPENROUTER_IMAGE_MODEL: stringEnv('openai/gpt-5-image-mini'),
  RV_OPENROUTER_VISION_MODEL: stringEnv('google/gemma-4-31b-it:free'),

  COMFYUI_HOST: optionalEnv(urlEnv),
  RV_COMFYUI_WORKFLOW_DIR: stringEnv('./tools/comfy-workflows'),
  RV_COMFYUI_ENABLED: boolEnv(false),
  RV_COMFYUI_REMOTE: boolEnv(false),
  COMFYUI_AUTH_TOKEN: optionalEnv(z.string().min(1)),

  RV_BUDGET_USD_PER_RUN: usdEnv,
  RV_BUDGET_USD_PER_DAY: usdEnv,
  RV_CONFIRM_SPEND_ABOVE_USD: usdEnv,

  RV_FFMPEG_PATH: stringEnv('ffmpeg'),
  RV_FFPROBE_PATH: stringEnv('ffprobe'),
  RV_RENDER_BACKEND: envValue(z.enum(['auto', 'playwright', 'canvas']).default('auto')),
  RV_RENDER_CONCURRENCY: intEnv(1, 32, 2),

  HF_TOKEN: optionalEnv(z.string().min(1)),

  /**
   * Seed for the deterministic decisions the *process* makes rather than a run - retry
   * jitter is the visible one. Non-negotiable #1 does not exempt infrastructure.
   */
  RV_SEED: intEnv(0, Number.MAX_SAFE_INTEGER, 1),
});

export type Env = z.infer<typeof EnvSchema>;
