/**
 * The three writable settings layers that live in the database.
 *
 * Architecture 7b's stack is `default -> machine (.env) -> global (DB) -> project ->
 * run`. The first two are not rows: the default is in the registry and the machine
 * layer is `.env`. This table holds the other three, and the composite key
 * `(scope, scope_id, key)` is what makes them one table instead of three.
 *
 * Three decisions worth stating once:
 *
 * **`scope_id` is `''`, never `NULL`, for the global layer.** SQLite does not treat two
 * `NULL`s as equal in a primary key, so a nullable `scope_id` would happily accept a
 * second "the" global row for the same key and then resolve non-deterministically
 * between them. The empty string compares equal to itself, so the uniqueness the
 * resolver depends on is real.
 *
 * **The value is one JSON document, not a typed column.** A setting holds a boolean, an
 * integer, a string or an array of format ids depending entirely on which setting it
 * is, and the thing that knows which is the descriptor in `@rv/contracts` - not the
 * schema here. Four nullable typed columns would encode the same information worse and
 * would still need the descriptor to decide which one to read. Nothing queries *inside*
 * a settings value, so there is nothing to shred it for.
 *
 * **No secret is ever stored here.** `SettingDescriptor.secret` implies machine scope,
 * `applyPatch` refuses a secret at any other scope, and `DrizzleSettingsRepository.save`
 * refuses a machine-scope write. Three independent refusals for one rule, because this
 * table is what gets backed up and exported.
 */

import type { IsoInstant, SettingScope } from '@rv/contracts';
import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { jsonDoc } from './columns';

/**
 * A setting value, wrapped.
 *
 * The envelope is not decoration. `null` is a *real* setting value - it is how
 * `budget.perRunNanoUsd` says "no ceiling" - and Drizzle maps a bare JS `null` straight
 * to SQL `NULL` without ever calling the column's serialiser. Storing the value
 * unwrapped therefore made "no ceiling" indistinguishable from a broken row, and with a
 * `NOT NULL` column it did not store at all. Wrapping keeps the column non-null and
 * makes "a stored null is a value" structural rather than a convention two functions
 * have to remember.
 */
export interface SettingValueEnvelope {
  readonly value: unknown;
}

export const settings = sqliteTable(
  'settings',
  {
    /** Which layer. `machine` never appears: that layer is `.env`, not a row. */
    scope: text('scope').notNull().$type<SettingScope>(),
    /**
     * The project or run this override belongs to.
     *
     * `''` for the global layer, which has exactly one instance. Not nullable - see the
     * file header for why a `NULL` here would break the primary key it is part of.
     */
    scopeId: text('scope_id').notNull(),
    /** A `SettingKey`. Not constrained here: the registry is the authority, not SQLite. */
    key: text('key').notNull(),
    /** The value, wrapped, as canonical JSON. `null`, `false` and `0` are all real values. */
    value: jsonDoc<SettingValueEnvelope>()('value').notNull(),
    updatedAt: text('updated_at').notNull().$type<IsoInstant>(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.scopeId, table.key] }),
    // The read the resolver actually issues: "everything at this layer instance".
    index('settings_scope_idx').on(table.scope, table.scopeId),
    // The read an audit issues: "who overrides this key, anywhere".
    index('settings_key_idx').on(table.key),
  ],
);

export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
