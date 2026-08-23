/**
 * `RunRepository` over the `runs` and `usage_records` tables in `@rv/persistence`.
 *
 * **Two impedance mismatches, both deliberate and both worth reporting upstream.**
 *
 * 1. `runs.state` is `'queued' | 'running' | 'paused' | 'done' | 'failed'` - five
 *    states, where the pipeline has six. `succeeded` maps to `done` and `cancelled`
 *    maps to `failed`, which loses the distinction the UI most needs ("I stopped it"
 *    versus "it broke"). So the column keeps the mapped value, for the index it
 *    exists to serve, and `metadata.status` keeps the canonical one. When
 *    `@rv/persistence` widens the column, `metadata.status` is deleted and nothing
 *    else changes.
 * 2. `runs` has one `stage` column, because storage modelled a run as executing one
 *    stage. A run requests a *list*. The column holds the currently-executing stage
 *    (or the first requested one, before it starts) and `metadata.requestedStages`
 *    holds the list.
 *
 * Everything the budget guard sums is a real column, so `SELECT sum(cost_nano_usd)`
 * never has to parse JSON - which is the property `usage_records` was designed for and
 * the one thing not worth compromising to make the mapping tidier.
 */

import type { IsoInstant, PipelineStageKey, ProjectId, RunId, UsageRecord } from '@rv/contracts';
import type { DatabaseHandle, RivayatDatabase } from '@rv/persistence';
import { runs, usageRecords } from '@rv/persistence';
import {
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

type StoredState = 'queued' | 'running' | 'paused' | 'done' | 'failed';

/** Six pipeline states onto the five the column offers. See the file header. */
const STATE_COLUMN: Readonly<Record<RunStatus, StoredState>> = {
  queued: 'queued',
  running: 'running',
  paused: 'paused',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'failed',
};

/** What lives in `metadata` because no column can hold it. */
interface RunMetadata {
  readonly status: RunStatus;
  readonly seriesId: string | null;
  readonly requestedStages: readonly PipelineStageKey[];
  readonly currentStage: PipelineStageKey | null;
  readonly stages: readonly RunStageResult[];
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
    state: STATE_COLUMN[run.status],
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
    status: metadata.status ?? (row.state === 'done' ? 'succeeded' : row.state),
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
    const written = attempt(`Could not update run ${id}`, () =>
      this.#db.update(runs).set(toRow(next)).where(eq(runs.id, id)).run(),
    );
    return isErr(written) ? written : ok(next);
  }
}
