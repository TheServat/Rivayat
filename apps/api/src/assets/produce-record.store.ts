/**
 * What S6 knows about an asset key that the registry does not store.
 *
 * The registry is deliberately narrow: it stores the dedup key and its four components,
 * and it stores versions. It does **not** store the `AssetSpec` that produced them, and
 * it has no row at all for a take that stopped before step eight. Three things the
 * Assets screen asked for need exactly those two facts:
 *
 * | question                                   | needs                                   |
 * | ------------------------------------------ | --------------------------------------- |
 * | "why is the asset I asked for not here?"   | the take that failed, and where          |
 * | "where did this version stop, step by step"| the eight step records                   |
 * | "give me another take"                     | the spec, byte-for-byte                  |
 *
 * The third is the load-bearing one and the reason this store exists rather than a
 * projection. `specHash` is a component of the dedup key, so a regeneration built from a
 * *reconstructed* spec would derive a different key, miss, and create a **second asset**
 * instead of appending a version - which is non-negotiable #2 broken by a helpful guess.
 * So the spec that produced a key is kept beside it, and a regeneration reuses it
 * verbatim or refuses.
 *
 * **A file per asset key under the workspace, not a table.** The same arrangement, and
 * for the same reason, as `json-file.repositories.ts` and `story.store.ts`:
 * `@rv/persistence` has no table this shape fits and `apps/api` may not add a migration
 * to a package another workstream owns. The gap is reported rather than papered over -
 * see the report accompanying this change, and `produce_checkpoints` is the table this
 * should become a projection of once it can carry a semantic key and a duration.
 *
 * Reads and writes go through the schema, so a document written by an older build fails
 * loudly here rather than reaching the produce chain as half a request.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AssetKey, AssetSpec, IsoInstant, Sha256Hex, Slug, StyleBibleId } from '@rv/contracts';
import {
  ValidationError,
  err,
  isErr,
  ok,
  toAppError,
  type AppError,
  type Logger,
  type Result,
  UNIT,
  type Unit,
} from '@rv/shared-kernel';
import { z } from 'zod';

import { AssetProduceReport } from '../modules/assets/assets.contracts';

/** Bumped when the document shape changes incompatibly. A mismatch is a failed read. */
export const PRODUCE_RECORD_VERSION = 1;

/**
 * Everything S6 was asked for, and everything it did, for one dedup key.
 *
 * `takes` grows: a regeneration appends, exactly as the version list does, so the
 * history of what an asset cost survives the takes that were rejected.
 */
export const ProduceRecord = z.strictObject({
  version: z.literal(PRODUCE_RECORD_VERSION),
  key: AssetKey,
  /** The request, verbatim. See the file header for why a reconstruction will not do. */
  spec: AssetSpec,
  styleBibleId: StyleBibleId,
  styleChecksum: Sha256Hex,
  variantKey: Slug.optional(),
  takes: z.array(AssetProduceReport).max(256).default([]),
  updatedAt: IsoInstant,
});
export type ProduceRecord = z.infer<typeof ProduceRecord>;

export interface ProduceRecordStoreOptions {
  readonly workspaceDir: string;
  readonly logger: Logger;
}

export class ProduceRecordStore {
  readonly #directory: string;
  readonly #logger: Logger;

  constructor(options: ProduceRecordStoreOptions) {
    this.#directory = join(options.workspaceDir, 'produce-records');
    this.#logger = options.logger.child({ component: 'produce-records' });
  }

  async find(key: AssetKey): Promise<Result<ProduceRecord | null, AppError>> {
    let raw: string;
    try {
      raw = await readFile(this.#path(key), 'utf8');
    } catch {
      // Absent is the normal state for every asset this build did not produce.
      return ok(null);
    }
    return this.#parse(key, raw);
  }

  /**
   * Every record, newest first, capped.
   *
   * A document that no longer parses is reported and skipped rather than fatal: one bad
   * file must not take the library list with it, and the list is a read-only screen.
   */
  async list(limit: number): Promise<Result<readonly ProduceRecord[], AppError>> {
    let names: readonly string[];
    try {
      names = await readdir(this.#directory);
    } catch {
      return ok([]);
    }

    const records: ProduceRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let raw: string;
      try {
        raw = await readFile(join(this.#directory, name), 'utf8');
      } catch {
        continue;
      }
      const parsed = await this.#parse(name.slice(0, -'.json'.length), raw);
      if (isErr(parsed)) {
        this.#logger.warn('produce record skipped', { file: name, code: parsed.error.code });
        continue;
      }
      if (parsed.value !== null) records.push(parsed.value);
    }

    records.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
    return ok(records.slice(0, Math.max(0, limit)));
  }

  /**
   * Records one take, appending it to whatever this key already has.
   *
   * Append and never replace, for the same reason `appendVersion` does: the take that
   * failed cost real money, and a store that overwrote it would make the ledger and the
   * screen disagree about what a run spent.
   */
  async append(
    record: Omit<ProduceRecord, 'version' | 'takes' | 'updatedAt'>,
    take: AssetProduceReport,
    at: string,
  ): Promise<Result<Unit, AppError>> {
    const existing = await this.find(record.key);
    if (isErr(existing)) return existing;

    const takes = [...(existing.value?.takes ?? []), take];
    const document = ProduceRecord.safeParse({
      version: PRODUCE_RECORD_VERSION,
      key: record.key,
      spec: record.spec,
      styleBibleId: record.styleBibleId,
      styleChecksum: record.styleChecksum,
      ...(record.variantKey === undefined ? {} : { variantKey: record.variantKey }),
      // Newest last, and capped by the schema. A key with 256 takes is a runaway loop,
      // and truncating the oldest keeps the recent history that is actually read.
      takes: takes.slice(-256),
      updatedAt: at,
    });
    if (!document.success) {
      return err(
        new ValidationError({
          message: `Refusing to record a produce take for ${record.key}: it does not satisfy the record shape.`,
          context: { assetKey: record.key },
          issues: document.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        }),
      );
    }

    return this.#write(record.key, document.data);
  }

  async #parse(key: string, raw: string): Promise<Result<ProduceRecord | null, AppError>> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `The produce record for ${key} is not readable`,
          cause: caught,
          context: { assetKey: key },
        }),
      );
    }

    const parsed = ProduceRecord.safeParse(json);
    if (parsed.success) return Promise.resolve(ok(parsed.data));
    return err(
      new ValidationError({
        message: `The produce record for ${key} no longer satisfies the schema`,
        context: {
          assetKey: key,
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      }),
    );
  }

  async #write(key: AssetKey, document: ProduceRecord): Promise<Result<Unit, AppError>> {
    try {
      await mkdir(this.#directory, { recursive: true });
      // Temp file then rename, like every other durable write here: a record truncated
      // by a `ctrl-c` would make a regeneration derive the wrong key.
      const path = this.#path(key);
      const staging = `${path}.tmp`;
      await writeFile(staging, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await rename(staging, path);
      return ok(UNIT);
    } catch (caught: unknown) {
      return err(toAppError(caught, `could not write the produce record for ${key}`));
    }
  }

  #path(key: string): string {
    // An asset key is a hex digest and already filename-safe; the replacement guards a
    // caller that hands over something else.
    return join(this.#directory, `${key.replaceAll(/[^\w.-]/g, '_')}.json`);
  }
}
