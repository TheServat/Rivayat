/**
 * Per-step resume points for S6 Produce.
 *
 * ## Why this is a table and not a field on the run
 *
 * `PipelineRun.checkpoints` holds one `StageCheckpoint` per pipeline stage and refuses
 * a stage checkpointed twice. That is exactly right for twelve stages and cannot
 * describe produce, which is forty assets moving through eight steps each, with a
 * repair attempt on some of them. `@rv/asset-engine` resolves that by keeping the
 * contract's *record* - a `StageCheckpoint`, `stage: 'produce'` - and giving it a key
 * of its own: `(runId, assetKey, step, attempt)`. `produceStageCheckpoint` folds the
 * whole set back into the single entry the run carries.
 *
 * That fold is the right shape and this table is what makes it honest rather than a
 * workaround. The two levels answer two different questions with two different
 * `inputHash`es. The run-level one covers the asset specs and the style checksum -
 * *does S6 need to run at all*, which is the "editing re-runs only the downstream
 * stages that depend on it" promise. The unit-level one covers what one step of one
 * asset consumed - *does this step need to run*. Merging them would give one field two
 * meanings, make `remainingStages` ambiguous for a stage that is 300 units of 320 done,
 * and grow the run document - loaded on every status poll - without bound in the number
 * of assets.
 *
 * What the fold used to cost is that the run could not answer "which asset was I on"
 * without a side store. It still consults a store; the difference is that the store is
 * now a table whose key is four columns, so that question is
 * `WHERE run_id = ? ORDER BY completed_at DESC LIMIT 1` rather than a scan of a JSON
 * document. Progress over a produce run is a projection of this table, which is what it
 * always was - it just had nowhere to be projected from.
 *
 * ## The key, spelled out
 *
 * `checkpointKeyString` in `@rv/asset-engine` flattens the key to
 * `runId/assetKey/step/attempt` and the file-backed stopgap in `apps/cli` used exactly
 * that string as its map key. Four columns rather than one string, because every
 * component is something a reader filters or aggregates on - per-run progress, per-asset
 * history, per-step timing, cost of resumed work - and re-splitting a composite string
 * in SQL to get at them is how a key becomes unqueryable.
 *
 * `attempt` is part of the identity rather than part of the hash because the quality
 * gate's repair loop regenerates with a different prompt: without it, a repaired take
 * overwrites the record of the take it was repairing and the ledger loses the money the
 * first one cost.
 *
 * ## No foreign key to `runs`
 *
 * A produce run driven from the CLI mints a `RunId` and has no `runs` row - that is the
 * documented way the resume demo works today. A constraint here would make the only
 * thing that exercises this table impossible to run, so the reference is by value and
 * an orphaned checkpoint costs a re-run and nothing else.
 */

import type {
  ArtifactRef,
  IsoInstant,
  JobId,
  PipelineStage,
  RunId,
  Sha256Hex,
} from '@rv/contracts';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { jsonDoc } from './columns';

export const produceCheckpoints = sqliteTable(
  'produce_checkpoints',
  {
    runId: text('run_id').notNull().$type<RunId>(),
    /** The registry dedup key of the asset this step belongs to. */
    assetKey: text('asset_key').notNull(),
    /** One of `PRODUCE_STEPS`: generate, matte, split, score, rig, clips, bake, register. */
    step: text('step').notNull(),
    /** 0 for the first take. Raised once per quality-gate repair. */
    attempt: integer('attempt').notNull(),

    // ── the `StageCheckpoint` record itself ──
    stage: text('stage').notNull().$type<PipelineStage>(),
    /**
     * "Already ran **on this**".
     *
     * The whole of resumability: a stored checkpoint whose hash no longer matches what
     * the step would consume is ignored rather than trusted, which is what stops an
     * edited input from being skipped over.
     */
    inputHash: text('input_hash').notNull().$type<Sha256Hex>(),
    /** What the step produced, by reference. The bytes are in the blob store. */
    outputs: jsonDoc<ArtifactRef[]>()('outputs').notNull(),
    jobIds: jsonDoc<JobId[]>()('job_ids').notNull(),
    /** Its own column so the resumed spend of a run is a `sum`, not a JSON walk. */
    costNanoUsd: integer('cost_nano_usd').notNull(),
    completedAt: text('completed_at').notNull().$type<IsoInstant>(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.assetKey, table.step, table.attempt] }),
    // "Which asset was I on" and per-run progress. The primary key already serves
    // `WHERE run_id = ?`; this orders it without a sort.
    index('produce_checkpoints_run_completed_idx').on(table.runId, table.completedAt),
  ],
);

export type ProduceCheckpointRow = typeof produceCheckpoints.$inferSelect;
export type NewProduceCheckpointRow = typeof produceCheckpoints.$inferInsert;
