/**
 * `RunPayloadStore` as one JSON file per run, under `<workspace>/runs/`.
 *
 * One file per run rather than one collection, unlike `json-file.repositories.ts`, and
 * the difference is what is stored: a payload holds a whole `AnimationIR`, so a single
 * document would be rewritten in its entirety every time any run started. One file per
 * run makes a write O(this run) and makes a corrupt payload cost exactly one run.
 *
 * Written to a temporary name and renamed, because the failure this store exists to
 * survive is the process being killed - and a payload truncated by the kill it is
 * meant to outlive would be worse than none, since a resume would read half an IR and
 * render half a composition rather than refusing.
 *
 * A stopgap with the same expiry as its neighbours: it becomes a row the day
 * `@rv/persistence` grows the checkpoint table.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunId } from '@rv/contracts';
import {
  UNIT,
  ValidationError,
  fromPromise,
  isErr,
  ok,
  toAppError,
  type Logger,
  type Result,
  type Unit,
} from '@rv/shared-kernel';

import type { RunPayloadStore } from '../../application/ports/run-payload.port';

export interface JsonFileRunPayloadStoreOptions {
  readonly workspaceDir: string;
  readonly logger: Logger;
}

export class JsonFileRunPayloadStore implements RunPayloadStore {
  readonly #directory: string;
  readonly #logger: Logger;

  constructor(options: JsonFileRunPayloadStoreOptions) {
    this.#directory = join(options.workspaceDir, 'runs');
    this.#logger = options.logger.child({ component: 'run-payload-store' });
  }

  async save(runId: RunId, payload: Record<string, unknown>): Promise<Result<Unit>> {
    const prepared = await fromPromise(mkdir(this.#directory, { recursive: true }), (caught) =>
      toAppError(caught, 'could not create the run payload directory'),
    );
    if (isErr(prepared)) return prepared;

    const path = this.#path(runId);
    const staging = `${path}.tmp`;
    const written = await fromPromise(
      writeFile(staging, JSON.stringify(payload), 'utf8'),
      (caught) => toAppError(caught, `could not write the payload for ${runId}`),
    );
    if (isErr(written)) return written;

    const moved = await fromPromise(rename(staging, path), (caught) =>
      toAppError(caught, `could not commit the payload for ${runId}`),
    );
    return isErr(moved) ? moved : ok(UNIT);
  }

  async load(runId: RunId): Promise<Result<Record<string, unknown> | null>> {
    const raw = await fromPromise(readFile(this.#path(runId), 'utf8'), (caught) => caught);
    // Absent means "this run was started by a build that did not save payloads", which
    // a resume reports as a refusal rather than as a corruption.
    if (isErr(raw)) return ok(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.value);
    } catch (caught: unknown) {
      this.#logger.error('stored run payload is not JSON', { runId });
      return {
        ok: false,
        error: new ValidationError({
          message: `The stored payload for ${runId} is not readable; the run cannot be resumed`,
          cause: caught,
          context: { runId },
        }),
      };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        error: new ValidationError({
          message: `The stored payload for ${runId} is not an object`,
          context: { runId },
        }),
      };
    }
    return ok(parsed as Record<string, unknown>);
  }

  #path(runId: RunId): string {
    // Run ids are prefixed ULIDs and therefore already filename-safe; the replacement
    // is belt and braces against a caller that hands over something else.
    return join(this.#directory, `${runId.replaceAll(/[^\w.-]/g, '_')}.payload.json`);
  }
}
