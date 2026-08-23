/**
 * `SettingsRepository`, on SQLite.
 *
 * The interface is declared in `@rv/settings`, not here - the same ADR-0006 seam every
 * other repository uses. Two responsibilities this class carries that the interface can
 * only describe in prose:
 *
 * **A save is a merge.** The form that produces a patch only ever sends what changed, so
 * replacing the stored layer would silently delete every override the user did not
 * happen to touch on that screen. Each key is an upsert, and removing an override is
 * `clear`, explicitly.
 *
 * **The machine layer is refused.** It comes from `.env`, it is where every secret
 * lives, and writing it here would put a credential in a row that gets backed up and
 * exported. The refusal is a `Result`, not a silent no-op: a caller that tried is
 * confused and should be told.
 */

import type { IsoInstant } from '@rv/contracts';
import type {
  SettingValues,
  SettingsLayer,
  SettingsRepository,
  SettingsScopeRef,
  SettingsStackRef,
  StoredSetting,
} from '@rv/settings';
import {
  UNIT,
  type Unit,
  ValidationError,
  type AppError,
  type Result,
  err,
  ok,
  toAppError,
} from '@rv/shared-kernel';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { DatabaseHandle, RivayatDatabase } from '../database/database';
import { type SettingRow, settings } from '../schema/index';

/**
 * The global layer has one instance, so it has no id.
 *
 * Flattened to `''` rather than left `NULL`, because `NULL` is not equal to itself in a
 * SQLite primary key and the uniqueness of "the" global row is exactly what the resolver
 * relies on.
 */
const NO_SCOPE_ID = '';

/** SQLite's older bound-parameter limit is 999; 400 keys per statement clears it. */
const MAX_KEYS_PER_STATEMENT = 400;

export class DrizzleSettingsRepository implements SettingsRepository {
  readonly #db: RivayatDatabase;

  constructor(handle: DatabaseHandle) {
    this.#db = handle.db;
  }

  loadLayer(ref: SettingsScopeRef): Promise<Result<SettingsLayer>> {
    return Promise.resolve(
      attempt(`Could not read the ${ref.scope} settings layer`, () => ({
        scope: ref.scope,
        scopeId: ref.scopeId,
        values: toValues(this.#rowsFor(ref)),
      })),
    );
  }

  loadStack(ref: SettingsStackRef): Promise<Result<readonly SettingsLayer[]>> {
    return Promise.resolve(
      attempt('Could not read the settings stack', () => {
        const refs: SettingsScopeRef[] = [{ scope: 'global', scopeId: null }];
        if (ref.projectId !== null) refs.push({ scope: 'project', scopeId: ref.projectId });
        if (ref.runId !== null) refs.push({ scope: 'run', scopeId: ref.runId });

        // One transaction, so the three layers are a consistent snapshot. A stack read
        // across a concurrent save could otherwise show a project value the run
        // override that accompanied it has not landed for yet.
        return this.#db.transaction((tx) =>
          refs.map((each) => ({
            scope: each.scope,
            scopeId: each.scopeId,
            values: toValues(
              tx.select().from(settings).where(matches(each)).orderBy(asc(settings.key)).all(),
            ),
          })),
        );
      }),
    );
  }

  save(ref: SettingsScopeRef, values: SettingValues, now: IsoInstant): Promise<Result<Unit>> {
    const rejection = refuseMachineLayer(ref);
    if (rejection !== null) return Promise.resolve(err(rejection));

    const entries = Object.entries(values);
    if (entries.length === 0) return Promise.resolve(ok(UNIT));

    return Promise.resolve(
      attempt(`Could not save the ${ref.scope} settings layer`, () => {
        this.#db.transaction(
          (tx) => {
            for (const [key, value] of entries) {
              tx.insert(settings)
                .values({
                  scope: ref.scope,
                  scopeId: ref.scopeId ?? NO_SCOPE_ID,
                  key,
                  value: { value },
                  updatedAt: now,
                })
                .onConflictDoUpdate({
                  target: [settings.scope, settings.scopeId, settings.key],
                  set: { value: { value }, updatedAt: now },
                })
                .run();
            }
          },
          { behavior: 'immediate' },
        );
        return UNIT;
      }),
    );
  }

  clear(ref: SettingsScopeRef, keys: readonly string[]): Promise<Result<Unit>> {
    const rejection = refuseMachineLayer(ref);
    if (rejection !== null) return Promise.resolve(err(rejection));
    if (keys.length === 0) return Promise.resolve(ok(UNIT));

    return Promise.resolve(
      attempt(`Could not clear ${ref.scope} settings`, () => {
        this.#db.transaction(
          (tx) => {
            for (let start = 0; start < keys.length; start += MAX_KEYS_PER_STATEMENT) {
              const chunk = keys.slice(start, start + MAX_KEYS_PER_STATEMENT);
              tx.delete(settings)
                .where(and(matches(ref), inArray(settings.key, [...chunk])))
                .run();
            }
          },
          { behavior: 'immediate' },
        );
        return UNIT;
      }),
    );
  }

  list(ref: SettingsScopeRef): Promise<Result<readonly StoredSetting[]>> {
    return Promise.resolve(
      attempt(`Could not list ${ref.scope} settings`, () =>
        this.#rowsFor(ref).map((row): StoredSetting => ({
          scope: row.scope,
          // Restored to `null` on the way out, so a caller never has to know that
          // storage spells "no id" as an empty string.
          scopeId: row.scopeId === NO_SCOPE_ID ? null : row.scopeId,
          key: row.key,
          value: row.value.value,
          updatedAt: row.updatedAt,
        })),
      ),
    );
  }

  #rowsFor(ref: SettingsScopeRef): SettingRow[] {
    return this.#db.select().from(settings).where(matches(ref)).orderBy(asc(settings.key)).all();
  }
}

function matches(ref: SettingsScopeRef): ReturnType<typeof and> {
  return and(eq(settings.scope, ref.scope), eq(settings.scopeId, ref.scopeId ?? NO_SCOPE_ID));
}

function toValues(rows: readonly SettingRow[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  // Unwrapped here and nowhere else: see `SettingValueEnvelope` for why the column
  // holds `{ value }` rather than the value itself.
  for (const row of rows) values[row.key] = row.value.value;
  return values;
}

/** The machine layer is `.env`, and `.env` is where every secret lives. */
function refuseMachineLayer(ref: SettingsScopeRef): AppError | null {
  if (ref.scope !== 'machine') return null;
  return new ValidationError({
    message:
      'The machine layer comes from the environment and is never stored: persisting it would put a secret in an exportable row.',
    context: { scope: ref.scope },
  });
}

/**
 * Runs a synchronous better-sqlite3 call and converts anything thrown into a `Result`.
 *
 * The conversion happens exactly once, here at the boundary, which is the rule for
 * adapters: nothing above this line ever sees a driver exception.
 */
function attempt<T>(message: string, body: () => T): Result<T> {
  try {
    return ok(body());
  } catch (caught) {
    return err(toAppError(caught, message));
  }
}
