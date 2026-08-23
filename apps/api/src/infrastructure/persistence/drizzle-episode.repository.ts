/**
 * `EpisodeRepository` over the `episodes` table.
 *
 * Read-only for now: nothing in the API writes an episode, because the stage that
 * produces one (S2 Story) is bound to a stub. The reads are real, against the real
 * table, so the day the stage lands the writes are the only new code.
 *
 * The row is already an `EpisodeOutline` in all but name - `episodes.structure` is
 * exactly `ActOutline[]` - so this is a field rename and three nullable-to-optional
 * conversions rather than a translation. Those three matter: `exactOptionalPropertyTypes`
 * is on, so `{ coldOpen: undefined }` and `{}` are different types, and assigning the
 * former where an optional field is expected is a compile error rather than a shrug.
 */

import { EpisodeOutline, type EpisodeId, type SeriesId } from '@rv/contracts';
import type { DatabaseHandle, RivayatDatabase } from '@rv/persistence';
import { episodes } from '@rv/persistence';
import {
  ValidationError,
  type Result,
  err,
  fromThrowable,
  isErr,
  ok,
  toAppError,
} from '@rv/shared-kernel';
import { asc, eq } from 'drizzle-orm';

import type { EpisodeRepository } from '../../application/ports/repository.ports';

function attempt<T>(message: string, fn: () => T): Result<T> {
  return fromThrowable(fn, (caught) => toAppError(caught, message));
}

function fromRow(row: typeof episodes.$inferSelect): Result<EpisodeOutline> {
  const parsed = EpisodeOutline.safeParse({
    id: row.id,
    ordinal: row.ordinal,
    title: row.title,
    summary: row.summary,
    plannedSummary: row.plannedSummary,
    status: row.status,
    logline: row.logline,
    // Nullable column, optional field. Omitted rather than set to `undefined`.
    ...(row.coldOpen === null ? {} : { coldOpen: row.coldOpen }),
    ...(row.cliffhanger === null ? {} : { cliffhanger: row.cliffhanger }),
    ...(row.airedAt === null ? {} : { airedAt: row.airedAt }),
    opensLoops: row.opensLoops,
    closesLoops: row.closesLoops,
    acts: row.structure,
  });

  return parsed.success
    ? ok(parsed.data)
    : err(
        new ValidationError({
          message: `Stored episode ${row.id} no longer satisfies EpisodeOutline`,
          context: {
            episodeId: row.id,
            // The path, not just the message. "Too small" with no field name is a
            // message that costs an hour of reading stored JSON to act on.
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        }),
      );
}

export class DrizzleEpisodeRepository implements EpisodeRepository {
  readonly #db: RivayatDatabase;

  constructor(handle: DatabaseHandle) {
    this.#db = handle.db;
  }

  findById(id: EpisodeId): Promise<Result<EpisodeOutline | null>> {
    const rows = attempt(`Could not read episode ${id}`, () =>
      this.#db.select().from(episodes).where(eq(episodes.id, id)).all(),
    );
    if (isErr(rows)) return Promise.resolve(rows);
    const row = rows.value[0];
    return Promise.resolve(row === undefined ? ok(null) : fromRow(row));
  }

  listBySeries(seriesId: SeriesId): Promise<Result<readonly EpisodeOutline[]>> {
    const rows = attempt(`Could not list episodes for ${seriesId}`, () =>
      this.#db
        .select()
        .from(episodes)
        .where(eq(episodes.seriesId, seriesId))
        // Airing order. The unique index on (series_id, ordinal) guarantees it is total.
        .orderBy(asc(episodes.ordinal))
        .all(),
    );
    if (isErr(rows)) return Promise.resolve(rows);

    const outlines: EpisodeOutline[] = [];
    for (const row of rows.value) {
      const parsed = fromRow(row);
      if (isErr(parsed)) return Promise.resolve(parsed);
      outlines.push(parsed.value);
    }
    return Promise.resolve(ok(outlines));
  }
}
