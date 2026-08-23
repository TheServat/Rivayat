/**
 * The files a render actually produced.
 *
 * They used to live inside `jobs.result` as a JSON array, which is defensible for a
 * payload nobody queries and wrong for this one. Three questions are asked of a
 * deliverable and none of them can be answered by a document: *did we already encode
 * these exact bytes* (`sha256`), *which formats has this episode shipped* (`format`),
 * and *does this file still exist and still match its hash* - the verification pass
 * that a delivery report is built from. All three are scans plus a JSON parse against
 * `jobs.result`, and all three are index lookups here.
 *
 * **The key is `(job_id, path)`, not a minted id.** `RenderArtifact` in `@rv/contracts`
 * has no id field, and that is correct rather than an omission: an artefact *is* a file,
 * its path is relative to the workspace root, and the rest of the system already
 * addresses it that way - `RunStageResult.artifacts` carries `render-artifact:<path>`.
 * Minting a surrogate id would create a second name for a file that already has one,
 * and the two would be free to disagree the first time a render is resumed.
 *
 * `size` is flattened into two integer columns rather than kept as a `Size` document,
 * because the dimensions are exactly what a per-platform spec probe checks: "list every
 * delivery that is not 1080x1920" is a real query and must not parse JSON to answer.
 * `encode` stays whole - nothing filters on a CRF.
 *
 * The rows are attached to the **job**, not to the run. A run may render twice; each
 * render is a job, and its outputs belong to the attempt that produced them. Listing a
 * run's deliverables is a join through `jobs`, which is one index hit, and the
 * alternative - a denormalised `run_id` beside `job_id` - is a second copy of a fact
 * `jobs` already owns.
 */

import type {
  EncodeSettings,
  FormatProfileId,
  IsoInstant,
  JobId,
  RenderArtifactKind,
  Sha256Hex,
} from '@rv/contracts';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { jsonDoc } from './columns';
import { jobs } from './ops';

export const renderArtifacts = sqliteTable(
  'render_artifacts',
  {
    jobId: text('job_id')
      .notNull()
      .$type<JobId>()
      .references(() => jobs.id),
    /** Relative to the workspace root. Never absolute - workspaces move. */
    path: text('path').notNull(),
    kind: text('kind').notNull().$type<RenderArtifactKind>(),
    /** `null` for a master or an audio stem, which belong to no single format. */
    format: text('format').$type<FormatProfileId>(),
    sha256: text('sha256').notNull().$type<Sha256Hex>(),
    bytes: integer('bytes').notNull(),
    durationMs: integer('duration_ms').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    frameCount: integer('frame_count').notNull(),
    encode: jsonDoc<EncodeSettings>()('encode').notNull(),
    createdAt: text('created_at').notNull().$type<IsoInstant>(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.path] }),
    // "Have we already encoded these bytes?" - the question that makes a re-delivery
    // free, and the one a JSON column could not be asked.
    index('render_artifacts_sha256_idx').on(table.sha256),
    index('render_artifacts_format_idx').on(table.format),
  ],
);

export type RenderArtifactRow = typeof renderArtifacts.$inferSelect;
export type NewRenderArtifactRow = typeof renderArtifacts.$inferInsert;
