/**
 * "Is this style locked?", against the real `style_bibles` table.
 *
 * One query, one column. The table has existed since the first migration and nothing in
 * this app had a reason to read it until the projects list needed to distinguish a
 * project that has *chosen* a style from one that can actually generate against it -
 * `assertUsableForGeneration` refuses an unlocked bible, so those are different states.
 *
 * A missing row answers `false` rather than failing. A project can name a bible that was
 * never written - the two live in different stores, one of which is still in memory -
 * and "unlocked" is the safe reading of that: it disables generation instead of
 * enabling it.
 */

import type { StyleBibleId } from '@rv/contracts';
import { type DatabaseHandle, type RivayatDatabase, styleBibles } from '@rv/persistence';
import { fromThrowable, toAppError, type Result } from '@rv/shared-kernel';
import { eq } from 'drizzle-orm';

import type { StyleBibleReader } from '../../application/ports/repository.ports';

export class DrizzleStyleBibleReader implements StyleBibleReader {
  readonly #db: RivayatDatabase;

  constructor(handle: DatabaseHandle) {
    this.#db = handle.db;
  }

  /**
   * `better-sqlite3` is synchronous, so a failing statement throws rather than
   * rejecting. `fromThrowable` is the boundary conversion; wrapping in a promise first
   * would let the throw escape before anything could catch it.
   */
  isLocked(id: StyleBibleId): Promise<Result<boolean>> {
    return Promise.resolve(
      fromThrowable(
        () => {
          const row = this.#db
            .select({ lockedAt: styleBibles.lockedAt })
            .from(styleBibles)
            .where(eq(styleBibles.id, id))
            .limit(1)
            .all()
            .at(0);
          return row !== undefined && row.lockedAt !== null;
        },
        (caught) => toAppError(caught, 'reading a style bible failed'),
      ),
    );
  }
}
