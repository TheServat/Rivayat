/**
 * `RunRepository` over the `runs` and `usage_records` tables in `@rv/persistence`.
 *
 * **`runs.state` now holds the canonical status, all six of it.** It used to offer
 * five - `queued | running | paused | done | failed` - so `succeeded` was written as
 * `done` and **`cancelled` was written as `failed`**, with the truth kept in
 * `metadata.status`. That fold cost the one distinction an operator most needs: the
 * indexed column that exists to answer "show me the failed runs" answered it with the
 * cancelled ones mixed in, and "I stopped this" read as "this broke". `@rv/persistence`
 * has widened the column to `PipelineStatus`, so the status is written where the index
 * can see it. {@link statusOf} still *reads* `metadata.status` first, because rows
 * written before the widening carry `done`/`failed` in the column and there is no
 * migration that can recover a `cancelled` those rows never recorded.
 *
 * **One remaining impedance mismatch.** `runs` has one `stage` column, because storage
 * modelled a run as executing one stage. A run requests a *list*. The column holds the
 * currently-executing stage (or the first requested one, before it starts) and
 * `metadata.requestedStages` holds the list.
 *
 * Everything the budget guard sums is a real column, so `SELECT sum(cost_nano_usd)`
 * never has to parse JSON - which is the property `usage_records` was designed for and
 * the one thing not worth compromising to make the mapping tidier.
 */

import type { IsoInstant, PipelineStageKey, ProjectId, RunId, UsageRecord } from '@rv/contracts';
import { canTransition } from '@rv/contracts';
import type { DatabaseHandle, RivayatDatabase } from '@rv/persistence';
import { runs, usageRecords } from '@rv/persistence';
import {
  ConflictError,
  NotFoundError,
  UNIT,
  ValidationError,
  type Result,
  type Unit,
  err,
  fromThrowable,
  isErr,
  ok,
  toAppError,
} from '@rv/shared-kernel';
import { eq } from 'drizzle-orm';

import type { RunRepository } from '../../application/ports/repository.ports';
import { RunSummary, type RunStageResult, type RunStatus } from '../../application/resources';

/**
 * `better-sqlite3` is synchronous, so a failing statement throws rather than rejecting.
 * `fromThrowable` is therefore the correct boundary conversion here; wrapping the call
 * in a promise first would let the throw escape before anything could catch it.
 */
function attempt<T>(message: string, fn: () => T): Result<T> {
  return fromThrowable(fn, (caught) => toAppError(caught, message));
}

/**
 * What a row written before the column was widened can hold.
 *
 * `done` is the only value that is not also a `RunStatus`; the rest overlap. Kept so
 * an old row still reads back as something the schema accepts instead of failing
 * validation on load, which would make every historical run un-listable.
 */
const LEGACY_COLUMN_STATES: Readonly<Record<string, RunStatus>> = { done: 'succeeded' };

/**
 * What lives in `metadata` because no column can hold it.
 *
 * `status` is written for the benefit of a *reader on an older build*, not this one:
 * the column is authoritative now. It costs a few bytes and it means a rollback does
 * not silently reinterpret every cancelled run as failed.
 */
interface RunMetadata {
  readonly status: RunStatus;
  readonly seriesId: string | null;
  readonly requestedStages: readonly PipelineStageKey[];
  readonly currentStage: PipelineStageKey | null;
  readonly stages: readonly RunStageResult[];
}

/**
 * The run's status, preferring whichever source can express `cancelled`.
 *
 * `metadata.status` first because a row written by the five-state build has the
 * canonical value there and the lossy one in the column. For every row written since,
 * the two agree.
 */
function statusOf(row: typeof runs.$inferSelect, metadata: Partial<RunMetadata>): string {
  return metadata.status ?? LEGACY_COLUMN_STATES[row.state] ?? row.state;
}

function toRow(run: RunSummary): typeof runs.$inferInsert {
  const metadata: RunMetadata = {
    status: run.status,
    seriesId: run.seriesId,
    requestedStages: run.requestedStages,
    currentStage: run.currentStage,
    stages: run.stages,
  };
  // `requestedStages` is `.min(1)`, so index 0 exists; the fallback exists only to
  // satisfy `noUncheckedIndexedAccess` and is unreachable for a schema-valid run.
  const stage = run.currentStage ?? run.requestedStages[0] ?? 'intake';

  return {
    id: run.id,
    projectId: run.projectId,
    stage,
    state: run.status,
    budgetNanoUsd: run.budgetNanoUsd,
    spentNanoUsd: run.spentNanoUsd,
    seed: run.seed,
    errorCode: run.errorCode,
    metadata: metadata as unknown as Record<string, unknown>,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function fromRow(row: typeof runs.$inferSelect): Result<RunSummary> {
  const metadata = row.metadata as unknown as Partial<RunMetadata>;
  const parsed = RunSummary.safeParse({
    id: row.id,
    projectId: row.projectId,
    seriesId: metadata.seriesId ?? null,
    status: statusOf(row, metadata),
    requestedStages: metadata.requestedStages ?? [row.stage],
    currentStage: metadata.currentStage ?? null,
    stages: metadata.stages ?? [],
    seed: row.seed,
    budgetNanoUsd: row.budgetNanoUsd,
    spentNanoUsd: row.spentNanoUsd,
    errorCode: row.errorCode,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });

  return parsed.success
    ? ok(parsed.data)
    : err(
        new ValidationError({
          message: `Stored run ${row.id} no longer satisfies RunSummary`,
          context: {
            runId: row.id,
            // The path, not just the message: "expected a slug" with no field name is
            // a message that costs an hour to act on.
            issues: parsed.error.issues.map(
              (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
            ),
          },
        }),
      );
}

function toUsageRow(record: UsageRecord): typeof usageRecords.$inferInsert {
  return {
    id: record.id,
    runId: record.runId,
    jobId: record.jobId,
    stage: record.stage,
    provider: record.provider,
    model: record.model,
    task: record.task,
    tier: record.tier,
    tokensInput: record.tokens.input,
    tokensOutput: record.tokens.output,
    tokensCached: record.tokens.cached,
    tokensReasoning: record.tokens.reasoning,
    imageCount: record.images.count,
    imageResolution: record.images.resolution,
    latencyMs: record.latencyMs,
    costNanoUsd: record.costNanoUsd,
    outcome: record.outcome,
    errorCode: record.errorCode,
    cacheHit: record.cacheHit,
    at: record.at,
  };
}

function fromUsageRow(row: typeof usageRecords.$inferSelect): UsageRecord {
  return {
    id: row.id,
    runId: row.runId,
    jobId: row.jobId,
    stage: row.stage,
    provider: row.provider,
    model: row.model,
    task: row.task,
    tier: row.tier,
    tokens: {
      input: row.tokensInput,
      output: row.tokensOutput,
      cached: row.tokensCached,
      reasoning: row.tokensReasoning,
    },
    images: { count: row.imageCount, resolution: row.imageResolution },
    latencyMs: row.latencyMs,
    costNanoUsd: row.costNanoUsd,
    outcome: row.outcome,
    errorCode: row.errorCode,
    cacheHit: row.cacheHit,
    at: row.at,
  };
}

export class DrizzleRunRepository implements RunRepository {
  readonly #db: RivayatDatabase;

  constructor(handle: DatabaseHandle) {
    this.#db = handle.db;
  }

  create(run: RunSummary): Promise<Result<RunSummary>> {
    const inserted = attempt(`Could not create run ${run.id}`, () =>
      this.#db.insert(runs).values(toRow(run)).run(),
    );
    return Promise.resolve(isErr(inserted) ? inserted : ok(run));
  }

  findById(id: RunId): Promise<Result<RunSummary | null>> {
    const rows = attempt(`Could not read run ${id}`, () =>
      this.#db.select().from(runs).where(eq(runs.id, id)).all(),
    );
    if (isErr(rows)) return Promise.resolve(rows);
    const row = rows.value[0];
    return Promise.resolve(row === undefined ? ok(null) : fromRow(row));
  }

  listByProject(projectId: ProjectId): Promise<Result<readonly RunSummary[]>> {
    const rows = attempt(`Could not list runs for ${projectId}`, () =>
      this.#db.select().from(runs).where(eq(runs.projectId, projectId)).all(),
    );
    if (isErr(rows)) return Promise.resolve(rows);

    const summaries: RunSummary[] = [];
    for (const row of rows.value) {
      const parsed = fromRow(row);
      if (isErr(parsed)) return Promise.resolve(parsed);
      summaries.push(parsed.value);
    }
    return Promise.resolve(ok(summaries));
  }

  /**
   * Moves the run, and refuses a move the state machine does not have.
   *
   * `PIPELINE_STATUS_TRANSITIONS` is enforced here rather than only in the runner
   * because it is the *storage* invariant that matters: a cancelled run walked back to
   * `running` by a stage that resolved after the cancel would finish, be billed for,
   * and be reported as succeeded - and no amount of care in one caller prevents the
   * next caller from doing it. A move to the state the run is already in is allowed:
   * every job of a run re-asserts `running`, and treating that as illegal would make
   * the second stage of every run fail.
   */
  setStatus(
    id: RunId,
    status: RunStatus,
    at: IsoInstant,
    errorCode: string | null = null,
  ): Promise<Result<RunSummary>> {
    return this.#mutate(id, (run) => ({
      ...run,
      status,
      errorCode: errorCode ?? run.errorCode,
      // A terminal state is the one thing a restarted process must be able to read
      // back without replaying the queue, so the timestamp is written with the status
      // and never separately.
      finishedAt:
        status === 'succeeded' || status === 'failed' || status === 'cancelled'
          ? at
          : run.finishedAt,
    }));
  }

  async setCurrentStage(id: RunId, stage: RunSummary['currentStage']): Promise<Result<Unit>> {
    const updated = await this.#mutate(id, (run) => ({ ...run, currentStage: stage }));
    return isErr(updated) ? updated : ok(UNIT);
  }

  async recordStage(id: RunId, result: RunStageResult): Promise<Result<Unit>> {
    const updated = await this.#mutate(id, (run) => ({
      ...run,
      // Replace rather than append: a re-run of the same stage supersedes its previous
      // result, and two entries for one stage would double it in the cost breakdown.
      stages: [...run.stages.filter((entry) => entry.stage !== result.stage), result],
    }));
    return isErr(updated) ? updated : ok(UNIT);
  }

  async appendUsage(record: UsageRecord): Promise<Result<Unit>> {
    const inserted = attempt(`Could not append usage ${record.id}`, () =>
      this.#db.insert(usageRecords).values(toUsageRow(record)).run(),
    );
    if (isErr(inserted)) return inserted;

    const bumped = await this.#mutate(record.runId, (run) => ({
      ...run,
      spentNanoUsd: run.spentNanoUsd + record.costNanoUsd,
    }));
    return isErr(bumped) ? bumped : ok(UNIT);
  }

  usage(id: RunId): Promise<Result<readonly UsageRecord[]>> {
    const rows = attempt(`Could not read the ledger for ${id}`, () =>
      this.#db.select().from(usageRecords).where(eq(usageRecords.runId, id)).all(),
    );
    return Promise.resolve(isErr(rows) ? rows : ok(rows.value.map(fromUsageRow)));
  }

  /**
   * Read, apply, write.
   *
   * SQLite has a single writer and `better-sqlite3` is synchronous, so the read and
   * the write cannot interleave with another writer *inside this process*. Across
   * processes they could, which is the day this needs a real transaction; the
   * single-writer assumption is ADR-0006's and it is recorded here rather than
   * discovered later.
   */
  async #mutate(id: RunId, apply: (run: RunSummary) => RunSummary): Promise<Result<RunSummary>> {
    const current = await this.findById(id);
    if (isErr(current)) return current;
    if (current.value === null) return err(new NotFoundError('run', id));

    const next = apply(current.value);
    if (next.status !== current.value.status && !canTransition(current.value.status, next.status)) {
      return err(
        new ConflictError({
          message: `Run ${id} cannot move from ${current.value.status} to ${next.status}`,
          context: { runId: id, from: current.value.status, to: next.status },
        }),
      );
    }

    const written = attempt(`Could not update run ${id}`, () =>
      this.#db.update(runs).set(toRow(next)).where(eq(runs.id, id)).run(),
    );
    return isErr(written) ? written : ok(next);
  }
}
