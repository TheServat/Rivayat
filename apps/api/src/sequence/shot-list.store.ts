/**
 * The shot list S7 produced, on disk, one JSON document per scene.
 *
 * **A stopgap, and it says which constraint makes it one.** `@rv/persistence` has a
 * `shots` table and it is the right table - but `shots.scene_id` references `scenes.id`,
 * and nothing in this app writes a `scenes` row: a scene arrives on the run payload,
 * because S3 (which invents scenes) has no endpoint yet. Writing shots against a scene
 * that does not exist would fail the foreign key, and adding the scene row here would put
 * this workstream inside another one's table. So the same arrangement `story.store.ts`
 * and `json-file.repositories.ts` use, and the same note: this becomes a projection of
 * `shots` the day a scene has a row.
 *
 * What is stored is the whole of what the reframer needs and nothing more: the shots, and
 * the safe area they were solved against. The safe area is recorded rather than
 * recomputed because the reframer's crop can legitimately lose part of it - story-engine
 * solves for a *centred* crop and the crop solver centres on the focus - and explaining
 * that difference afterwards is only possible if the rectangle that was solved is written
 * down.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { IsoInstant, NormRect, SceneId, Shot } from '@rv/contracts';
import {
  UNIT,
  ValidationError,
  err,
  ok,
  toAppError,
  type AppError,
  type Logger,
  type Result,
  type Unit,
} from '@rv/shared-kernel';
import { z } from 'zod';

/** Bumped when the document shape changes incompatibly. A mismatch is a failed read. */
export const SHOT_LIST_VERSION = 1;

export const StoredShotList = z.strictObject({
  version: z.literal(SHOT_LIST_VERSION),
  sceneId: SceneId,
  shots: z.array(Shot).min(1),
  /** The rectangle every shot was solved against. See the file header. */
  safeArea: NormRect,
  /** The director's own note on how it paced the scene. Prose, shown verbatim. */
  pacingNote: z.string().max(2000).default(''),
  createdAt: IsoInstant,
});
export type StoredShotList = z.infer<typeof StoredShotList>;

export interface ShotListStoreOptions {
  readonly workspaceDir: string;
  readonly logger: Logger;
}

export class ShotListStore {
  readonly #directory: string;
  readonly #logger: Logger;

  constructor(options: ShotListStoreOptions) {
    this.#directory = join(options.workspaceDir, 'shot-lists');
    this.#logger = options.logger.child({ component: 'shot-lists' });
  }

  async save(document: StoredShotList): Promise<Result<Unit, AppError>> {
    try {
      await mkdir(this.#directory, { recursive: true });
      const path = this.#path(document.sceneId);
      const staging = `${path}.tmp`;
      await writeFile(staging, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await rename(staging, path);
      return ok(UNIT);
    } catch (caught: unknown) {
      return err(toAppError(caught, `could not write the shot list for ${document.sceneId}`));
    }
  }

  /**
   * Reads one back.
   *
   * A document that no longer parses is a failure rather than an absence: the shot list
   * is the reframer's input, and a half-parsed one would crop a film.
   */
  async find(sceneId: SceneId): Promise<Result<StoredShotList | null, AppError>> {
    let raw: string;
    try {
      raw = await readFile(this.#path(sceneId), 'utf8');
    } catch {
      return ok(null);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `The stored shot list for ${sceneId} is not readable`,
          cause: caught,
          context: { sceneId },
        }),
      );
    }

    const parsed = StoredShotList.safeParse(json);
    if (parsed.success) return ok(parsed.data);

    this.#logger.warn('a stored shot list no longer satisfies the schema', { sceneId });
    return err(
      new ValidationError({
        message: `The stored shot list for ${sceneId} no longer satisfies the schema`,
        context: {
          sceneId,
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      }),
    );
  }

  #path(sceneId: string): string {
    return join(this.#directory, `${sceneId.replaceAll(/[^\w.-]/g, '_')}.json`);
  }
}
