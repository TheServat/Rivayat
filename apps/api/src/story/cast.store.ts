/**
 * The state grid, on disk, one JSON document per character.
 *
 * The same stopgap as `story.store.ts` and for the same reason: `@rv/persistence` has no
 * table for a *prompt an author has edited*. The nearest thing is `entities.payload`,
 * which holds `CharacterVisual` and therefore holds the `expressionSet` and `poseSet`
 * the engine produced - but the grid carries per-cell state the sheet does not have and
 * must not gain: a status, an identity score, a cost estimate and, crucially, an
 * *edited* prompt that has diverged from the one the engine composed.
 *
 * Keeping the two apart is the point rather than an accident. The character sheet is
 * what S3 decided; the grid is what the pipeline is going to spend money on, cell by
 * cell, with a human's corrections on top. Folding the edit back into the sheet would
 * make "regenerate this character" silently regenerate the human's edits away.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EntityId, SeriesId } from '@rv/contracts';
import {
  NotFoundError,
  ValidationError,
  err,
  isErr,
  ok,
  type AppError,
  type Logger,
  type Result,
} from '@rv/shared-kernel';

import { CharacterStateCell, CharacterStates } from './cast.contracts';

export interface CharacterStateStoreOptions {
  readonly workspaceDir: string;
  readonly logger: Logger;
}

/** An empty grid, which is what a character S3 has not reached honestly has. */
export function emptyStates(): CharacterStates {
  return CharacterStates.parse({});
}

export class CharacterStateStore {
  readonly #directory: string;
  readonly #logger: Logger;

  constructor(options: CharacterStateStoreOptions) {
    this.#directory = join(options.workspaceDir, 'cast');
    this.#logger = options.logger.child({ component: 'cast-store' });
  }

  async load(seriesId: SeriesId, entityId: EntityId): Promise<Result<CharacterStates, AppError>> {
    let raw: string;
    try {
      raw = await readFile(this.#path(seriesId, entityId), 'utf8');
    } catch {
      return ok(emptyStates());
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `The stored state grid for ${entityId} is not readable JSON`,
          cause: caught,
          context: { seriesId, entityId },
        }),
      );
    }

    const document = CharacterStates.safeParse(parsed);
    return document.success
      ? ok(document.data)
      : err(
          new ValidationError({
            message: `The stored state grid for ${entityId} no longer satisfies the schema`,
            context: {
              seriesId,
              entityId,
              issues: document.error.issues.map((issue) => issue.path.map(String).join('.')),
            },
          }),
        );
  }

  async save(
    seriesId: SeriesId,
    entityId: EntityId,
    states: CharacterStates,
  ): Promise<Result<CharacterStates, AppError>> {
    const path = this.#path(seriesId, entityId);
    try {
      await mkdir(join(this.#directory, seriesId), { recursive: true });
      const staging = `${path}.tmp`;
      await writeFile(staging, `${JSON.stringify(states, null, 2)}\n`, 'utf8');
      await rename(staging, path);
      return ok(states);
    } catch (caught: unknown) {
      this.#logger.error('could not persist the state grid', {
        seriesId,
        entityId,
        cause: String(caught),
      });
      return err(
        new ValidationError({
          message: `Could not write the state grid for ${entityId}`,
          cause: caught,
          context: { seriesId, entityId, path },
        }),
      );
    }
  }

  /**
   * Replaces one cell, returning the cell rather than the grid.
   *
   * The routes that use it - the prompt edit and the single-cell generate - are both
   * about one cell, and answering with the whole grid would make a client that renders
   * five hundred of them re-render all of them to show one change.
   */
  async replaceCell(
    seriesId: SeriesId,
    entityId: EntityId,
    variantKey: string,
    change: (cell: CharacterStateCell) => CharacterStateCell,
  ): Promise<Result<CharacterStateCell, AppError>> {
    const current = await this.load(seriesId, entityId);
    if (isErr(current)) return current;

    const found = current.value.cells.find((cell) => cell.variantKey === variantKey);
    if (found === undefined) {
      return err(
        new NotFoundError('character state', variantKey, { context: { seriesId, entityId } }),
      );
    }

    const next = CharacterStateCell.parse(change(found));
    const saved = await this.save(seriesId, entityId, {
      ...current.value,
      cells: current.value.cells.map((cell) => (cell.variantKey === variantKey ? next : cell)),
    });
    return isErr(saved) ? saved : ok(next);
  }

  #path(seriesId: SeriesId, entityId: EntityId): string {
    return join(this.#directory, seriesId, `${entityId}.json`);
  }
}
