/**
 * Where a resume point lives.
 *
 * JSON on disk rather than a row in the database, and deliberately so: the checkpoint
 * has to survive the process that owns the database connection dying, it has to be
 * readable by a human debugging a stuck render, and it belongs next to the frames it
 * describes. It is also the one piece of render state a worker on another machine needs
 * and nothing else does.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

import type { CheckpointRecord, CheckpointStorePort } from '../ports/storage';

export class InMemoryCheckpointStore implements CheckpointStorePort {
  readonly #records = new Map<string, CheckpointRecord>();
  /** Every save, in order. Lets a test assert *when* a checkpoint was taken. */
  readonly history: CheckpointRecord[] = [];

  load(jobId: string): Promise<Result<CheckpointRecord | null, AppError>> {
    return Promise.resolve(ok(this.#records.get(jobId) ?? null));
  }

  save(jobId: string, record: CheckpointRecord): Promise<Result<Unit, AppError>> {
    this.#records.set(jobId, record);
    this.history.push(record);
    return Promise.resolve(ok());
  }
}

export class FileCheckpointStore implements CheckpointStorePort {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async load(jobId: string): Promise<Result<CheckpointRecord | null, AppError>> {
    const bytes = await fromPromise(readFile(this.#path(jobId), 'utf8'), (caught) => caught);
    // A missing checkpoint is "this job has not started", not a failure. Every other
    // read error - a permission problem, a truncated file - is.
    if (!bytes.ok) return ok(null);

    try {
      return ok(parseRecord(JSON.parse(bytes.value), jobId));
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `checkpoint for ${jobId} is not readable; delete it to restart the render`,
          cause: caught,
          context: { jobId, path: this.#path(jobId) },
        }),
      );
    }
  }

  async save(jobId: string, record: CheckpointRecord): Promise<Result<Unit, AppError>> {
    const path = this.#path(jobId);
    const prepared = await fromPromise(mkdir(dirname(path), { recursive: true }), (caught) =>
      toAppError(caught, 'could not create the checkpoint directory'),
    );
    if (!prepared.ok) return prepared;

    const written = await fromPromise(
      writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8'),
      (caught) => toAppError(caught, `could not write the checkpoint for ${jobId}`),
    );
    return written.ok ? ok() : written;
  }

  #path(jobId: string): string {
    // The job id is a prefixed ULID, so it is already filename-safe; the replacement is
    // belt and braces against a caller that passes something else.
    return join(this.#directory, `${jobId.replaceAll(/[^\w.-]/g, '_')}.checkpoint.json`);
  }
}

/**
 * Validates a stored record before it is trusted to skip work.
 *
 * A malformed checkpoint that parsed as `{}` would report "nothing completed" and
 * silently re-render everything, which is the *benign* failure; one with a garbled
 * range would skip frames that were never drawn and encode a hole.
 */
export function parseRecord(value: unknown, jobId: string): CheckpointRecord {
  if (typeof value !== 'object' || value === null) throw new TypeError('not an object');
  const record = value as Partial<CheckpointRecord>;
  if (typeof record.irHash !== 'string') throw new TypeError('missing irHash');
  if (!Array.isArray(record.completedRanges)) throw new TypeError('missing completedRanges');

  const ranges = record.completedRanges.map((range) => {
    if (typeof range !== 'object' || range === null) throw new TypeError('malformed range');
    const { from, to } = range as { from?: unknown; to?: unknown };
    if (typeof from !== 'number' || typeof to !== 'number' || !(to > from)) {
      throw new TypeError('malformed range bounds');
    }
    return { from, to };
  });

  return {
    jobId,
    completedRanges: ranges,
    irHash: record.irHash,
    lastFrameHash: typeof record.lastFrameHash === 'string' ? record.lastFrameHash : null,
    updatedAtIso: typeof record.updatedAtIso === 'string' ? record.updatedAtIso : '',
  };
}
