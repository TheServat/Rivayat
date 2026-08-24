import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixedClock, instant } from '@rv/shared-kernel';

import { buildImageLanes, buildTextBackends, repositoryRoot, workflowDir } from './lanes';

const clock = new FixedClock(instant(0));

describe('repositoryRoot', () => {
  it('finds the checkout root from a nested package directory', () => {
    // This spec file lives inside the repository, so the walk must terminate on it.
    const root = repositoryRoot(process.cwd());
    expect(workflowDir({}, process.cwd())).toBe(join(root, 'tools', 'comfy-workflows'));
  });

  it('falls back to the given directory when there is no workspace manifest above it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'rv-nowhere-'));
    try {
      expect(repositoryRoot(outside)).toBe(outside);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('lets the environment override the workflow directory outright', () => {
    expect(workflowDir({ RV_COMFYUI_WORKFLOW_DIR: '/elsewhere' }, '/repo')).toBe('/elsewhere');
  });
});

describe('buildImageLanes', () => {
  let empty: string;

  beforeEach(async () => {
    empty = await mkdtemp(join(tmpdir(), 'rv-flows-'));
  });
  afterEach(async () => {
    await rm(empty, { recursive: true, force: true });
  });

  /**
   * An unwired lane is a missing key with a reason, never an adapter that throws on
   * first use - which is what `GenerateStyleProbeUseCase` documents that it wants.
   */
  it('reports why each lane is absent instead of failing', async () => {
    const built = await buildImageLanes({
      env: { RV_COMFYUI_WORKFLOW_DIR: empty },
      cwd: process.cwd(),
      clock,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.lanes.free).toBeUndefined();
    expect(built.value.lanes.paid).toBeUndefined();
    expect(built.value.unavailable.free).toContain('workflow');
    expect(built.value.unavailable.paid).toContain('GEMINI_API_KEY');
  });

  it('wires the paid lane as soon as a key exists, without probing the network', async () => {
    const built = await buildImageLanes({
      env: { RV_COMFYUI_WORKFLOW_DIR: empty, GEMINI_API_KEY: 'not-a-real-key' },
      cwd: process.cwd(),
      clock,
    });
    expect(built.ok && built.value.lanes.paid).toBeDefined();
  });

  it('wires the free lane from the repository workflows', async () => {
    const built = await buildImageLanes({ env: {}, cwd: process.cwd(), clock });
    expect(built.ok && built.value.lanes.free).toBeDefined();
  });
});

describe('buildTextBackends', () => {
  it('defaults to the local free lane', () => {
    const built = buildTextBackends({ env: {}, clock });
    expect(built.ok && built.value.modelRef).toBe('ollama:qwen3.5:latest');
    expect(built.ok && built.value.chain).toHaveLength(1);
  });

  it('keeps the colon inside an Ollama tag rather than splitting on the last one', () => {
    const built = buildTextBackends({ env: {}, clock, binding: 'ollama:gemma4:26b' });
    expect(built.ok && built.value.modelRef).toBe('ollama:gemma4:26b');
  });

  it('treats a bare model id as an Ollama model', () => {
    const built = buildTextBackends({ env: {}, clock, binding: 'qwen3:1.7b' });
    // `qwen3` reads as a provider, so the bare form only holds when there is no colon.
    expect(built.ok && built.value.modelRef.startsWith('ollama:')).toBe(true);
  });

  it('returns an empty chain, not a broken adapter, for Gemini with no key', () => {
    const built = buildTextBackends({ env: {}, clock, binding: 'gemini:gemini-3-flash' });
    expect(built.ok && built.value.chain).toHaveLength(0);
  });

  it('builds a Gemini backend when the key is present', () => {
    const built = buildTextBackends({
      env: { GEMINI_API_KEY: 'k' },
      clock,
      binding: 'gemini:gemini-3-flash',
    });
    expect(built.ok && built.value.chain).toHaveLength(1);
  });
});
