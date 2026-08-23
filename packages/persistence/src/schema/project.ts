/**
 * The two rows everything else in the database points at, and did not exist.
 *
 * `runs.project_id`, `episodes.series_id`, `settings.scope_id` and every asset the
 * studio lists are addressed by a `ProjectId` or a `SeriesId`, and until now neither
 * had a table. `apps/api` filled the hole twice - an in-memory adapter, then a
 * JSON-file decorator over it - and both headers say the same thing: the ports are
 * real, the adapters are not durable, and the swap is one binding once the migration
 * lands. This is that migration.
 *
 * Both tables are shredded from their contract schema rather than stored as documents,
 * because every field of both is either queried or listed. There is no sub-document to
 * keep whole: a project is nine scalars.
 *
 * **What is deliberately *not* here is a foreign key from `runs.project_id`.** It is
 * the obvious next constraint and it cannot land in the same change: rows already exist
 * in real workspaces whose `project_id` names a project that only ever lived in a JSON
 * file, and every test in `apps/api` that inserts a run inserts one without a project.
 * Adding the constraint before those rows have somewhere to point turns a startup into
 * a `FOREIGN KEY constraint failed` with no way forward. It is a follow-up with a
 * backfill in front of it, not an oversight.
 *
 * `projects.style_bible_id` has no foreign key for a different and permanent reason,
 * the same one that keeps image hashes from referencing `blobs`: a style bible is
 * *referenced*, never owned. A project must stay loadable when the bible it names has
 * been forked away or was never stored locally, and a constraint here would make the
 * project unreadable instead of merely unstyled.
 */

import type { IsoInstant, Locale, ProjectId, SeriesId, StyleBibleId } from '@rv/contracts';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey().$type<ProjectId>(),
    name: text('name').notNull(),
    /** The whole brief. The list shows its first 400 characters as a logline. */
    description: text('description').notNull(),
    /** This project's interface language, not the operator's. See `Project.locale`. */
    locale: text('locale').notNull().$type<Locale>(),
    /** `null` until S1 locks one. No foreign key - see the file header. */
    styleBibleId: text('style_bible_id').$type<StyleBibleId>(),
    /** `null` means the machine or workspace policy applies. It does not mean zero. */
    budgetNanoUsd: integer('budget_nano_usd'),
    createdAt: text('created_at').notNull().$type<IsoInstant>(),
    updatedAt: text('updated_at').notNull().$type<IsoInstant>(),
  },
  (table) => [
    // The projects list is ordered by recency and is the studio's landing screen.
    index('projects_updated_at_idx').on(table.updatedAt),
  ],
);

/**
 * A series before it has a bible, which is the state it is in when it is created.
 *
 * `has_bible` is a flag and not a nullable document: `SeriesBible` is a whole act tree
 * and the list screen has to answer "which of these have been planned" without loading
 * a dozen of them to find out. The bible itself is written by S2 and lives in the story
 * tables.
 */
export const series = sqliteTable(
  'series',
  {
    id: text('id').primaryKey().$type<SeriesId>(),
    projectId: text('project_id')
      .notNull()
      .$type<ProjectId>()
      .references(() => projects.id),
    title: text('title').notNull(),
    premise: text('premise').notNull(),
    hasBible: integer('has_bible', { mode: 'boolean' }).notNull(),
    createdAt: text('created_at').notNull().$type<IsoInstant>(),
  },
  (table) => [index('series_project_idx').on(table.projectId)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type SeriesRow = typeof series.$inferSelect;
export type NewSeriesRow = typeof series.$inferInsert;
