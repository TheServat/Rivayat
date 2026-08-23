/**
 * Style bibles.
 *
 * `checksum` is the column everything else in the system hangs off: it is a component
 * of every asset dedup key, so changing a style forks the whole library while leaving
 * the old one intact and re-renderable (docs/02 §5). It is indexed, not unique - two
 * bibles with identical content legitimately hash the same, and forbidding that would
 * make a fork of an unedited style fail for no reason.
 *
 * The bible's four big blocks - `visual`, `motion`, `render`, `prompts` - are stored
 * whole. They are read as a unit by the prompt assembler, hashed as a unit into
 * `checksum`, and never queried field-wise; shredding them would be about sixty
 * columns bought with nothing.
 */

import type {
  IsoInstant,
  StyleAnchor,
  StyleBible,
  StyleBibleId,
  StyleOrigin,
  Sha256Hex,
} from '@rv/contracts';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { jsonDoc } from './columns';

export const styleBibles = sqliteTable(
  'style_bibles',
  {
    id: text('id').primaryKey().$type<StyleBibleId>(),
    name: text('name').notNull(),
    /** Bumped on every edit. The previous version keeps its own row. */
    version: integer('version').notNull(),
    origin: text('origin').notNull().$type<StyleOrigin>(),
    parentId: text('parent_id').$type<StyleBibleId>(),

    visual: jsonDoc<StyleBible['visual']>()('visual').notNull(),
    motion: jsonDoc<StyleBible['motion']>()('motion').notNull(),
    render: jsonDoc<StyleBible['render']>()('render').notNull(),
    prompts: jsonDoc<StyleBible['prompts']>()('prompts').notNull(),
    anchors: jsonDoc<StyleAnchor[]>()('anchors').notNull(),

    /** Base seed for every generation made under this style. */
    seed: integer('seed').notNull(),
    /** Hash over everything above. Participates in every asset dedup key. */
    checksum: text('checksum').notNull().$type<Sha256Hex>(),
    /** `null` until locked. Generation is refused against an unlocked style. */
    lockedAt: text('locked_at').$type<IsoInstant>(),

    createdAt: text('created_at').notNull().$type<IsoInstant>(),
    notes: text('notes'),
  },
  (table) => [
    index('style_bibles_checksum_idx').on(table.checksum),
    index('style_bibles_parent_idx').on(table.parentId),
  ],
);

export type StyleBibleRow = typeof styleBibles.$inferSelect;
export type NewStyleBibleRow = typeof styleBibles.$inferInsert;
