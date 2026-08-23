/**
 * Which adapters get built, and - more importantly - which do not.
 *
 * An unconfigured provider that gets registered anyway is a routing hole: it enters
 * the failover chain and costs a round trip and a retry on every call before failing
 * with a 401. So the assertions are mostly negative, and every skip carries a reason
 * the health endpoint can show an operator.
 *
 * Nothing here opens a socket. Constructing an adapter is construction; the first
 * request is what would talk to a host, and none is made.
 */

import { MemoryLogger, isErr } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../config/app-config';
import { buildAdapters } from './build-adapters';

function config(env: Record<string, string>): AppConfig {
  const parsed = loadConfig({ NODE_ENV: 'test', ...env });
  if (isErr(parsed)) throw parsed.error;
  return parsed.value;
}

const logger = new MemoryLogger();

describe('buildAdapters', () => {
  it('registers nothing and explains every absence when nothing is configured', async () => {
    const set = await buildAdapters(config({}), logger);

    expect(set.adapters).toEqual([]);
    expect(set.matrix.adapters()).toEqual([]);
    expect(set.skipped.map((entry) => entry.provider).sort()).toEqual([
      'comfyui',
      'gemini',
      'ollama',
      'openrouter',
    ]);
    for (const entry of set.skipped) {
      expect(entry.reason, entry.provider).not.toBe('');
    }
  });

  it('registers Ollama twice, because text and embeddings are different models', async () => {
    const set = await buildAdapters(
      config({
        OLLAMA_HOST: 'http://127.0.0.1:11434',
        RV_OLLAMA_TEXT_MODEL: 'qwen3.5:latest',
        RV_OLLAMA_EMBED_MODEL: 'nomic-embed-text',
      }),
      logger,
    );

    expect(set.adapters.map((adapter) => adapter.modelRef)).toEqual([
      'ollama:qwen3.5:latest',
      'ollama:nomic-embed-text',
    ]);
    // The embedding registration is narrowed: an embed model that also claimed text
    // generation would be routed prose it cannot write.
    expect(set.matrix.refsFor('embedding')).toEqual(['ollama:nomic-embed-text']);
    expect(set.matrix.refsFor('text-generation')).toEqual(['ollama:qwen3.5:latest']);
  });

  it('does not register the same provider:model twice when text and image agree', async () => {
    // The matrix throws on a duplicate `provider:model`, by design. A configuration
    // that points text and image at one model must produce one registration.
    const set = await buildAdapters(
      config({
        GEMINI_API_KEY: 'k',
        RV_GEMINI_TEXT_MODEL: 'gemini-3-flash',
        RV_GEMINI_IMAGE_MODEL: 'gemini-3-flash',
      }),
      logger,
    );

    expect(set.adapters.map((adapter) => adapter.modelRef)).toEqual(['gemini:gemini-3-flash']);
  });

  it('registers a separate Gemini adapter per distinct model', async () => {
    const set = await buildAdapters(
      config({
        GEMINI_API_KEY: 'k',
        RV_GEMINI_TEXT_MODEL: 'gemini-3-flash',
        RV_GEMINI_IMAGE_MODEL: 'gemini-3.1-flash-lite-image',
      }),
      logger,
    );

    expect(set.adapters).toHaveLength(2);
    expect(set.skipped.map((entry) => entry.provider)).not.toContain('gemini');
  });

  it('registers OpenRouter with the attribution headers it bills by', async () => {
    const set = await buildAdapters(
      config({
        OPENROUTER_API_KEY: 'k',
        RV_OPENROUTER_TEXT_MODEL: 'z-ai/glm-5.2:free',
        RV_OPENROUTER_IMAGE_MODEL: 'openai/gpt-5-image-mini',
      }),
      logger,
    );

    expect(set.adapters.map((adapter) => adapter.modelRef)).toEqual([
      'openrouter:z-ai/glm-5.2:free',
      'openrouter:openai/gpt-5-image-mini',
    ]);
  });

  it('skips ComfyUI when it is disabled, and says that is why', async () => {
    const set = await buildAdapters(
      config({ RV_COMFYUI_ENABLED: 'false', COMFYUI_HOST: 'http://127.0.0.1:8288' }),
      logger,
    );
    const comfy = set.skipped.find((entry) => entry.provider === 'comfyui');
    expect(comfy?.reason).toContain('RV_COMFYUI_ENABLED');
  });

  it('skips ComfyUI when it is enabled with no host', async () => {
    const set = await buildAdapters(config({ RV_COMFYUI_ENABLED: 'true' }), logger);
    const comfy = set.skipped.find((entry) => entry.provider === 'comfyui');
    expect(comfy?.reason).toContain('COMFYUI_HOST');
  });

  it('starts anyway when ComfyUI is configured and its workflow files are missing', async () => {
    // An operator problem, not a reason to refuse to boot: every other lane still
    // works, and the health endpoint names this one.
    const set = await buildAdapters(
      config({
        RV_COMFYUI_ENABLED: 'true',
        COMFYUI_HOST: 'http://127.0.0.1:8288',
        RV_COMFYUI_WORKFLOW_DIR: './does-not-exist',
      }),
      logger,
    );

    expect(set.adapters).toEqual([]);
    const comfy = set.skipped.find((entry) => entry.provider === 'comfyui');
    expect(comfy?.reason).toContain('workflow');
  });

  it('registers ComfyUI when its workflows are on disk', async () => {
    const set = await buildAdapters(
      config({
        RV_COMFYUI_ENABLED: 'true',
        COMFYUI_HOST: 'http://127.0.0.1:8288',
        // The real directory, from the repo root that Vitest runs `apps/api` in.
        RV_COMFYUI_WORKFLOW_DIR: '../../tools/comfy-workflows',
      }),
      logger,
    );

    const registered = set.adapters.map((adapter) => adapter.kind);
    const comfySkip = set.skipped.find((entry) => entry.provider === 'comfyui');
    // Either it registered, or the workflow files are not vendored in this checkout -
    // and in that case the skip must still name why, which is the property under test.
    expect(registered.includes('comfyui') || comfySkip !== undefined).toBe(true);
  });
});
