/**
 * The choreography record on disk, filed under the composition it describes.
 *
 * The same shape and the same reasoning as `CompositionStore`: one JSON file per
 * document under `<workspace>/choreography/<compositionId>.json`, written temp-then-
 * rename so a `ctrl-c` cannot leave half a record, and addressed by *content* rather
 * than by run so the delivery of a cut finds the shots of that cut whoever produced
 * them and however many times.
 *
 * Separate from the composition file rather than a field on it, for one reason that
 * decides it: the composition's id is the hash of the composition, and folding
 * anything else into that document would change the id of every IR that carries one.
 * A run that stored a composition through `POST /api/compositions` and a run that
 * choreographed the same shots must arrive at the same address.
 *
 * Absent is a normal state, not an error. A composition that was authored elsewhere -
 * the studio storing an IR directly - has no shot record, and `find` says `null` so the
 * delivery can fall back to the whole timeline as one shot and *say* that it did.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ValidationError,
  err,
  ok,
  toAppError,
  type AppError,
  type Result,
} from '@rv/shared-kernel';

import { Choreography } from './choreography.contracts';

export class ChoreographyStore {
  readonly #directory: string;

  constructor(workspaceDir: string) {
    this.#directory = join(workspaceDir, 'choreography');
  }

  async save(record: Choreography): Promise<Result<Choreography, AppError>> {
    const prepared = await attempt(mkdir(this.#directory, { recursive: true }));
    if (!prepared.ok) return prepared;

    const path = this.#path(record.compositionId);
    const staging = `${path}.tmp`;
    const written = await attempt(
      writeFile(staging, `${JSON.stringify(record, null, 2)}\n`, 'utf8'),
    );
    if (!written.ok) return written;

    const renamed = await attempt(rename(staging, path));
    return renamed.ok ? ok(record) : renamed;
  }

  /** `null` for a composition nobody choreographed, which is not a failure. */
  async find(compositionId: string): Promise<Result<Choreography | null, AppError>> {
    let raw: string;
    try {
      raw = await readFile(this.#path(compositionId), 'utf8');
    } catch {
      return ok(null);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `The choreography record for ${compositionId} is not readable`,
          cause: caught,
          context: { compositionId },
        }),
      );
    }

    // Parsed, not cast. A record written by an older build must fail here rather than
    // reach the reframer as half a shot list and produce a plan nobody can explain.
    const record = Choreography.safeParse(parsed);
    return record.success
      ? ok(record.data)
      : err(
          new ValidationError({
            message: `The choreography record for ${compositionId} no longer satisfies the schema`,
            context: {
              compositionId,
              issues: record.error.issues.map((issue) => issue.path.join('.')),
            },
          }),
        );
  }

  #path(compositionId: string): string {
    return join(this.#directory, `${compositionId.replaceAll(/[^\w.-]/g, '_')}.json`);
  }
}

async function attempt(work: Promise<unknown>): Promise<Result<void, AppError>> {
  try {
    await work;
    return ok(undefined);
  } catch (caught: unknown) {
    return err(toAppError(caught, 'could not write the choreography record'));
  }
}
