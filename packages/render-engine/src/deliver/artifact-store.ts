/**
 * Files under the workspace root.
 *
 * `RenderArtifact.path` is workspace-relative on purpose - "Never absolute - workspaces
 * move" - and FFmpeg is a subprocess that needs a real path, so exactly one object owns
 * the join between the two. Everything else in the delivery path speaks relative paths
 * and stays portable.
 *
 * Renders never write into the repository. The workspace root is passed in, and the
 * only default anyone should use is `workspace/`, which is gitignored.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

import {
  ValidationError,
  err,
  fromPromise,
  ok,
  toAppError,
  type AppError,
  type Result,
  type Unit,
} from '@rv/shared-kernel';

import type { ArtifactStorePort } from '../ports/storage';

export class FileArtifactStore implements ArtifactStorePort {
  readonly #root: string;

  constructor(workspaceRoot: string) {
    this.#root = resolve(workspaceRoot);
  }

  async write(path: string, bytes: Uint8Array): Promise<Result<Unit, AppError>> {
    const target = this.#guard(path);
    if (!target.ok) return target;

    const prepared = await fromPromise(
      mkdir(dirname(target.value), { recursive: true }),
      (caught) => toAppError(caught, 'could not create the artefact directory'),
    );
    if (!prepared.ok) return prepared;

    const written = await fromPromise(writeFile(target.value, bytes), (caught) =>
      toAppError(caught, `could not write ${path}`),
    );
    return written.ok ? ok() : written;
  }

  async read(path: string): Promise<Result<Uint8Array, AppError>> {
    const target = this.#guard(path);
    if (!target.ok) return target;
    const bytes = await fromPromise(readFile(target.value), (caught) =>
      toAppError(caught, `could not read ${path}`),
    );
    return bytes.ok ? ok(Uint8Array.from(bytes.value)) : bytes;
  }

  async exists(path: string): Promise<boolean> {
    const target = this.#guard(path);
    if (!target.ok) return false;
    const info = await fromPromise(stat(target.value), (caught) => caught);
    return info.ok;
  }

  resolve(path: string): string {
    const target = this.#guard(path);
    if (!target.ok) throw target.error;
    return target.value;
  }

  async prepareWrite(path: string): Promise<Result<string, AppError>> {
    const target = this.#guard(path);
    if (!target.ok) return target;
    const prepared = await fromPromise(
      mkdir(dirname(target.value), { recursive: true }),
      (caught) => toAppError(caught, `could not prepare ${path} for writing`),
    );
    return prepared.ok ? ok(target.value) : prepared;
  }

  /**
   * Refuses anything that escapes the workspace.
   *
   * The paths here come from a render request, which comes from an API, and
   * `../../../etc/something` is a path an API eventually receives. Checking the
   * *resolved* path rather than looking for `..` in the input is the version that
   * cannot be smuggled past.
   */
  #guard(path: string): Result<string, AppError> {
    if (isAbsolute(path)) {
      return err(
        new ValidationError({
          message: `artefact paths are workspace-relative; got the absolute path ${path}`,
          context: { path },
        }),
      );
    }
    const resolved = resolve(this.#root, normalize(path));
    if (resolved !== this.#root && !resolved.startsWith(this.#root + sep)) {
      return err(
        new ValidationError({
          message: `${path} resolves outside the workspace`,
          context: { path, root: this.#root },
        }),
      );
    }
    return ok(resolved);
  }
}

/** The default workspace layout. Kept in one place so the CLI and the API agree. */
export const WORKSPACE_LAYOUT = {
  master: (projectId: string, episodeId: string): string =>
    join('projects', projectId, 'render', episodeId, 'master'),
  deliver: (projectId: string, episodeId: string): string =>
    join('projects', projectId, 'deliver', episodeId),
  frames: (projectId: string, jobId: string): string =>
    join('projects', projectId, 'render', 'frames', jobId),
  checkpoints: (projectId: string): string => join('projects', projectId, 'render', 'checkpoints'),
} as const;
