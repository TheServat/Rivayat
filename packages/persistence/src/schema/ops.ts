/**
 * Operational state: pipeline runs, the jobs inside them, and the cost ledger.
 *
 * `usage_records` is the table non-negotiable #3 rests on - "cost is metered before it
 * is spent" is only checkable if the ledger can be summed cheaply - so every number
 * the budget guard aggregates is its own integer column. `TokenUsage` and `ImageUsage`
 * are flat numeric records in the contract and are flattened here for exactly that
 * reason: `SELECT sum(cost_nano_usd) … GROUP BY provider` must never parse JSON.
 *
 * `runs` and `jobs` have **no schema in `@rv/contracts`**. `RunId` and `JobId` are in
 * the id registry and `UsageRecord`/`RenderJob` both point at them, but nothing
 * defines what a run or a generic job *is*. These two tables are therefore storage's
 * own shape, kept deliberately thin: the identifiers and lifecycle fields the queue
 * and the ledger need as columns, and whatever the stage cares about in `payload`.
 * `RenderJob` fits inside `payload`/`result` unchanged.
 */

import type {
  CallOutcome,
  IsoInstant,
  JobId,
  PipelineStageKey,
  ProjectId,
  ProviderKind,
  QualityTier,
  RunId,
  Size,
  TaskKind,
  UsageId,
} from '@rv/contracts';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { jsonDoc } from './columns';

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey().$type<RunId>(),
    projectId: text('project_id').notNull().$type<ProjectId>(),
    /** Which stage of the pipeline this run is executing. */
    stage: text('stage').notNull().$type<PipelineStageKey>(),
    state: text('state').notNull().$type<'queued' | 'running' | 'paused' | 'done' | 'failed'>(),
    /** `null` for an unbudgeted run. The guard treats that as "ask before every spend". */
    budgetNanoUsd: integer('budget_nano_usd'),
    /** Denormalised sum of this run's usage records, so the guard is one read. */
    spentNanoUsd: integer('spent_nano_usd').notNull(),
    /**
     * Seed for every deterministic decision in the run.
     *
     * Stored so a replay reproduces the run bit-for-bit (non-negotiable #1); a run
     * that cannot name its seed cannot be replayed.
     */
    seed: integer('seed').notNull(),
    errorCode: text('error_code'),
    metadata: jsonDoc<Record<string, unknown>>()('metadata').notNull(),
    startedAt: text('started_at').notNull().$type<IsoInstant>(),
    finishedAt: text('finished_at').$type<IsoInstant>(),
  },
  (table) => [
    index('runs_project_idx').on(table.projectId),
    index('runs_state_idx').on(table.state),
  ],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey().$type<JobId>(),
    runId: text('run_id')
      .notNull()
      .$type<RunId>()
      .references(() => runs.id),
    stage: text('stage').notNull().$type<PipelineStageKey>(),
    state: text('state')
      .notNull()
      .$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>(),
    attempt: integer('attempt').notNull(),
    /** The stage's own request. A `RenderJob` lives here unchanged. */
    payload: jsonDoc<Record<string, unknown>>()('payload').notNull(),
    /** `null` until the job finishes. Checkpoints and artefacts live here. */
    result: jsonDoc<Record<string, unknown>>()('result'),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull().$type<IsoInstant>(),
    updatedAt: text('updated_at').notNull().$type<IsoInstant>(),
  },
  (table) => [
    index('jobs_run_idx').on(table.runId),
    index('jobs_state_idx').on(table.state),
    index('jobs_run_stage_idx').on(table.runId, table.stage),
  ],
);

export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: text('id').primaryKey().$type<UsageId>(),
    runId: text('run_id')
      .notNull()
      .$type<RunId>()
      .references(() => runs.id),
    /** `null` for a call made outside a queued job, e.g. an interactive retry. */
    jobId: text('job_id').$type<JobId>(),
    stage: text('stage').notNull().$type<PipelineStageKey>(),
    provider: text('provider').notNull().$type<ProviderKind>(),
    model: text('model').notNull(),
    task: text('task').notNull().$type<TaskKind>(),
    tier: text('tier').notNull().$type<QualityTier>(),

    // Flat, because the budget guard sums these and must not parse JSON to do it.
    tokensInput: integer('tokens_input').notNull(),
    tokensOutput: integer('tokens_output').notNull(),
    tokensCached: integer('tokens_cached').notNull(),
    tokensReasoning: integer('tokens_reasoning').notNull(),
    imageCount: integer('image_count').notNull(),
    /** `null` when the call produced no image. Image billing scales with the pixels. */
    imageResolution: jsonDoc<Size>()('image_resolution'),

    latencyMs: integer('latency_ms').notNull(),
    costNanoUsd: integer('cost_nano_usd').notNull(),
    outcome: text('outcome').notNull().$type<CallOutcome>(),
    errorCode: text('error_code'),
    /** True when the response came from cache and therefore cost nothing. */
    cacheHit: integer('cache_hit', { mode: 'boolean' }).notNull(),
    at: text('at').notNull().$type<IsoInstant>(),
  },
  (table) => [
    index('usage_records_run_idx').on(table.runId),
    index('usage_records_job_idx').on(table.jobId),
    index('usage_records_provider_at_idx').on(table.provider, table.at),
    index('usage_records_stage_idx').on(table.stage),
  ],
);

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type NewUsageRecordRow = typeof usageRecords.$inferInsert;
