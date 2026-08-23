/**
 * The index of what the content-addressed store holds.
 *
 * The filesystem is the source of truth for the *bytes*; this table is the source of
 * truth for what we know *about* them - size, media type, when we first saw them. It
 * is intentionally not a foreign-key target for the rows that reference a hash: a
 * project references assets and never owns them (ADR-0006), the store is shared across
 * every project on the machine, and deleting a row must never be able to delete a
 * file. Referential integrity here would quietly turn one of those into a lie.
 */

import type { IsoInstant, Sha256Hex } from '@rv/contracts';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const blobs = sqliteTable(
  'blobs',
  {
    /** The address. `<root>/<hash[0:2]>/<hash>` on disk. */
    hash: text('hash').primaryKey().$type<Sha256Hex>(),
    byteSize: integer('byte_size').notNull(),
    /** `null` when nothing has claimed to know what the bytes are. */
    mediaType: text('media_type'),
    createdAt: text('created_at').notNull().$type<IsoInstant>(),
  },
  (table) => [index('blobs_created_at_idx').on(table.createdAt)],
);

export type BlobRow = typeof blobs.$inferSelect;
export type NewBlobRow = typeof blobs.$inferInsert;
