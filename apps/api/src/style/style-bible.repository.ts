/**
 * Where a `StyleBible` lives between the moment it is chosen and the moment it is
 * locked.
 *
 * `style_bibles` has existed since the first migration and nothing wrote to it: the
 * seed inserts a row directly and `DrizzleStyleBibleReader` reads one column. That was
 * enough while S1 was a stub, and it is not enough for choose → probe → lock, which is
 * three requests against the same document - the client holds an id between them and
 * the server has to be able to resolve it.
 *
 * The port is here, in the layer that needs it, and the adapter is in the same file
 * rather than under `infrastructure/persistence/` for the reason `render/render-stores.ts`
 * and `modules/compositions/composition.store.ts` already give: a store whose only
 * consumer is one feature is easier to read next to that feature, and the composition
 * root is still the only thing that constructs it.
 *
 * **It never updates a locked row's content.** `save` is an upsert on the whole
 * document, and `lockedAt` is written by `lock()` in `@rv/core-domain`, which refuses a
 * second lock; a fork gets a new id and a new row. So the one thing this table must
 * guarantee - that a checksum, once locked, describes bytes nobody moved afterwards -
 * is guaranteed by the domain and merely persisted here.
 */

import { StyleBible, type StyleBibleId } from '@rv/contracts';
import { type DatabaseHandle, type RivayatDatabase, styleBibles } from '@rv/persistence';
import {
  type AppError,
  type Logger,
  type Result,
  UNIT,
  type Unit,
  fromThrowable,
  isErr,
  ok,
  toAppError,
} from '@rv/shared-kernel';
import { desc, eq } from 'drizzle-orm';

/**
 * Read and write for one style bible.
 *
 * Narrow on purpose: S1 needs "get me the document this id names" and "remember this
 * document". Listing exists because the studio's style screen opens on whatever was
 * last worked on and has no other way to find it.
 */
export interface StyleBibleRepository {
  find(id: StyleBibleId): Promise<Result<StyleBible | null, AppError>>;
  /** Upsert of the whole document. The caller has already decided what it should be. */
  save(bible: StyleBible): Promise<Result<Unit, AppError>>;
  /** Most recently created first, capped. For the Style Lab's "resume where I was". */
  list(limit: number): Promise<Result<readonly StyleBible[], AppError>>;
}

export interface DrizzleStyleBibleRepositoryDeps {
  readonly database: DatabaseHandle;
  readonly logger: Logger;
}

export class DrizzleStyleBibleRepository implements StyleBibleRepository {
  readonly #db: RivayatDatabase;
  readonly #logger: Logger;

  constructor(deps: DrizzleStyleBibleRepositoryDeps) {
    this.#db = deps.database.db;
    this.#logger = deps.logger.child({ component: 'style-bibles' });
  }

  find(id: StyleBibleId): Promise<Result<StyleBible | null, AppError>> {
    const rows = attempt(`Could not read style bible ${id}`, () =>
      this.#db.select().from(styleBibles).where(eq(styleBibles.id, id)).limit(1).all(),
    );
    if (isErr(rows)) return Promise.resolve(rows);

    const row = rows.value.at(0);
    if (row === undefined) return Promise.resolve(ok(null));
    return Promise.resolve(ok(this.#parse(row)));
  }

  save(bible: StyleBible): Promise<Result<Unit, AppError>> {
    const values = {
      id: bible.id,
      name: bible.name,
      version: bible.version,
      origin: bible.origin,
      parentId: bible.parentId ?? null,
      visual: bible.visual,
      motion: bible.motion,
      render: bible.render,
      prompts: bible.prompts,
      anchors: [...bible.anchors],
      seed: bible.seed,
      checksum: bible.checksum,
      lockedAt: bible.lockedAt,
      createdAt: bible.createdAt,
      notes: bible.notes ?? null,
    };

    const written = attempt(`Could not store style bible ${bible.id}`, () =>
      this.#db
        .insert(styleBibles)
        .values(values)
        .onConflictDoUpdate({ target: styleBibles.id, set: values })
        .run(),
    );
    return Promise.resolve(isErr(written) ? written : ok(UNIT));
  }

  list(limit: number): Promise<Result<readonly StyleBible[], AppError>> {
    const rows = attempt('Could not list style bibles', () =>
      this.#db
        .select()
        .from(styleBibles)
        .orderBy(desc(styleBibles.createdAt))
        .limit(Math.max(1, limit))
        .all(),
    );
    if (isErr(rows)) return Promise.resolve(rows);

    const parsed: StyleBible[] = [];
    for (const row of rows.value) {
      const bible = this.#parse(row);
      if (bible !== null) parsed.push(bible);
    }
    return Promise.resolve(ok(parsed));
  }

  /**
   * A row that no longer parses reads as absent.
   *
   * The alternative is worse in both directions: failing the request punishes the user
   * for a document an older build wrote, and trusting an unvalidated row hands an
   * unchecked `StyleBible` to the checksum function, which would then compute a
   * checksum for something that is not a style bible.
   */
  #parse(row: typeof styleBibles.$inferSelect): StyleBible | null {
    const parsed = StyleBible.safeParse({
      ...row,
      parentId: row.parentId ?? undefined,
      notes: row.notes ?? undefined,
    });
    if (parsed.success) return parsed.data;

    this.#logger.warn('a style_bibles row does not satisfy StyleBible; treating it as absent', {
      styleBibleId: row.id,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    return null;
  }
}

/**
 * `better-sqlite3` is synchronous, so a failing statement throws rather than rejecting.
 * `fromThrowable` is the boundary conversion; wrapping in a promise first would let the
 * throw escape before anything could catch it.
 */
function attempt<T>(message: string, run: () => T): Result<T, AppError> {
  return fromThrowable(run, (caught) => toAppError(caught, message));
}
