/**
 * `ProduceCheckpointStore`, on SQLite.
 *
 * The port is declared in `@rv/asset-engine` - the same ADR-0006 seam every other
 * repository here uses - and it had no adapter anywhere, so the only thing that made
 * "kill the produce run and start it again" demonstrable was a JSON file written from
 * `apps/cli`. Its own header says it is a stopgap in the wrong layer. This is the
 * durable one.
 *
 * Three properties are the whole of resumability, and only the first is the port's:
 *
 * **A write is an upsert.** The same `(runId, assetKey, step, attempt)` is written
 * again whenever a step re-runs - because its inputs changed, or because its record had
 * vanished - and the new checkpoint must replace the old one. An insert that conflicted
 * would fail the write, which the engine treats as "costs a re-run next time" and would
 * therefore make the *next* resume wrong as well, permanently.
 *
 * **`inputHash` is stored verbatim and compared by the caller.** This class never
 * decides whether a checkpoint is still valid. `ProduceAssetsUseCase` hashes what the
 * step is about to consume and compares; a store that pre-filtered would be deciding
 * with less information than the caller has, and "already ran" would quietly stand in
 * for "already ran on this".
 *
 * **A row that no longer parses reads as absent.** The port says so explicitly - "an
 * implementation that forgets is allowed; `read` returning `null` costs a re-run, never
 * a wrong answer" - and it is the right answer for a checkpoint written by an older
 * build: re-running a step is cheap and correct, while failing the asset is neither, and
 * trusting an unvalidated row is how a resumed run produces a subtly different asset and
 * reports success.
 */

import { StageCheckpoint } from '@rv/contracts';
import type { ProduceCheckpointKey, ProduceCheckpointStore } from '@rv/asset-engine';
import {
  type AppError,
  type Result,
  UNIT,
  type Unit,
  fromThrowable,
  isErr,
  ok,
  toAppError,
} from '@rv/shared-kernel';
import { and, eq } from 'drizzle-orm';

import type { DatabaseHandle, RivayatDatabase } from '../database/database';
import { type ProduceCheckpointRow, produceCheckpoints } from '../schema/index';

/**
 * `better-sqlite3` is synchronous, so a failing statement throws rather than rejecting.
 * `fromThrowable` is the correct boundary conversion; wrapping in a promise first would
 * let the throw escape before anything could catch it.
 */
function attempt<T>(message: string, run: () => T): Result<T, AppError> {
  return fromThrowable(run, (caught) => toAppError(caught, message));
}

export class DrizzleProduceCheckpointRepository implements ProduceCheckpointStore {
  readonly #db: RivayatDatabase;

  constructor(handle: DatabaseHandle) {
    this.#db = handle.db;
  }

  read(key: ProduceCheckpointKey): Promise<Result<StageCheckpoint | null, AppError>> {
    const rows = attempt(`Could not read the produce checkpoint for ${key.step}`, () =>
      this.#db
        .select()
        .from(produceCheckpoints)
        .where(
          and(
            eq(produceCheckpoints.runId, key.runId),
            eq(produceCheckpoints.assetKey, key.assetKey),
            eq(produceCheckpoints.step, key.step),
            eq(produceCheckpoints.attempt, key.attempt),
          ),
        )
        .all(),
    );
    if (isErr(rows)) return Promise.resolve(rows);

    const row = rows.value[0];
    return Promise.resolve(ok(row === undefined ? null : toCheckpoint(row)));
  }

  write(key: ProduceCheckpointKey, checkpoint: StageCheckpoint): Promise<Result<Unit, AppError>> {
    const written = attempt(`Could not write the produce checkpoint for ${key.step}`, () =>
      this.#db
        .insert(produceCheckpoints)
        .values({
          runId: key.runId,
          assetKey: key.assetKey,
          step: key.step,
          attempt: key.attempt,
          stage: checkpoint.stage,
          inputHash: checkpoint.inputHash,
          outputs: [...checkpoint.outputs],
          jobIds: [...checkpoint.jobIds],
          costNanoUsd: checkpoint.costNanoUsd,
          completedAt: checkpoint.completedAt,
        })
        .onConflictDoUpdate({
          target: [
            produceCheckpoints.runId,
            produceCheckpoints.assetKey,
            produceCheckpoints.step,
            produceCheckpoints.attempt,
          ],
          set: {
            stage: checkpoint.stage,
            inputHash: checkpoint.inputHash,
            outputs: [...checkpoint.outputs],
            jobIds: [...checkpoint.jobIds],
            costNanoUsd: checkpoint.costNanoUsd,
            completedAt: checkpoint.completedAt,
          },
        })
        .run(),
    );
    return Promise.resolve(isErr(written) ? written : ok(UNIT));
  }
}

/**
 * A row back into the contract record, or `null` if it is no longer one.
 *
 * Parsed rather than cast. The alternative - handing the caller a shape the schema
 * would reject - defers the failure to whichever step trusted it, and the symptom is a
 * resumed asset that differs from the one the run reported.
 */
function toCheckpoint(row: ProduceCheckpointRow): StageCheckpoint | null {
  const parsed = StageCheckpoint.safeParse({
    stage: row.stage,
    inputHash: row.inputHash,
    outputs: row.outputs,
    jobIds: row.jobIds,
    costNanoUsd: row.costNanoUsd,
    completedAt: row.completedAt,
  });
  return parsed.success ? parsed.data : null;
}
