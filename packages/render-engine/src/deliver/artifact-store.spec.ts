import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { unwrap } from '@rv/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scratchDir } from '../__fixtures__/workspace';
import { FileArtifactStore, WORKSPACE_LAYOUT } from './artifact-store';

describe('FileArtifactStore', () => {
  let root: string;
  let store: FileArtifactStore;

  beforeAll(async () => {
    root = await scratchDir('artifacts');
    store = new FileArtifactStore(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes and reads a workspace-relative path', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect((await store.write('deliver/e01/out.mp4', bytes)).ok).toBe(true);
    expect(unwrap(await store.read('deliver/e01/out.mp4'))).toEqual(bytes);
    expect(await store.exists('deliver/e01/out.mp4')).toBe(true);
  });

  it('reports a path that is not there', async () => {
    expect(await store.exists('nothing.mp4')).toBe(false);
    expect((await store.read('nothing.mp4')).ok).toBe(false);
  });

  it('resolves to a real path for FFmpeg, which has its own working directory', () => {
    expect(store.resolve('a/b.mp4')).toBe(resolve(root, join('a', 'b.mp4')));
  });

  it('refuses an absolute path', async () => {
    // `RenderArtifact.path` is workspace-relative on purpose: "workspaces move".
    const result = await store.write(resolve(root, 'x.mp4'), new Uint8Array());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('refuses a path that escapes the workspace', async () => {
    // These paths come from a render request, which comes from an API.
    const result = await store.write('../../etc/passwd', new Uint8Array());
    expect(result.ok).toBe(false);
    expect(await store.exists('../../etc/passwd')).toBe(false);
    expect(() => store.resolve('../escape')).toThrow();
  });

  it('accepts a path that traverses and comes back', async () => {
    expect((await store.write('a/../b.mp4', new Uint8Array([9]))).ok).toBe(true);
  });
});

describe('WORKSPACE_LAYOUT', () => {
  it('keeps every render artefact under projects/, never in the repository', () => {
    for (const path of [
      WORKSPACE_LAYOUT.master('prj_1', 'ep_1'),
      WORKSPACE_LAYOUT.deliver('prj_1', 'ep_1'),
      WORKSPACE_LAYOUT.frames('prj_1', 'job_1'),
      WORKSPACE_LAYOUT.checkpoints('prj_1'),
    ]) {
      expect(path.startsWith('projects')).toBe(true);
      expect(path.includes('..')).toBe(false);
    }
  });
});
