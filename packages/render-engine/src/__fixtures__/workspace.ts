/**
 * Scratch space for tests that touch the disk.
 *
 * Everything goes under the repository's gitignored `workspace/`, never into the source
 * tree and never into the system temp directory: a render that leaves files in the repo
 * is the failure this rule exists to prevent, and keeping the scratch beside the real
 * output means a debugging session can look at both together.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `<repo>/workspace/test/render-engine`, created if it is not there. */
export async function workspaceScratch(): Promise<string> {
  const root = resolve(HERE, '..', '..', '..', '..', 'workspace', 'test', 'render-engine');
  await mkdir(root, { recursive: true });
  return root;
}

/** A named subdirectory of the scratch space, created fresh. */
export async function scratchDir(name: string): Promise<string> {
  const path = join(await workspaceScratch(), name);
  await mkdir(path, { recursive: true });
  return path;
}
