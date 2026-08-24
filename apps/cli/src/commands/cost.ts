/**
 * `rv cost report --run <id>` and `rv series cost` - the ledger, read back.
 *
 * The aggregation is not reimplemented here. `CostMeter.summary()` in `@rv/providers`
 * owns the four slices - by provider, by model, by task, by stage - and this command
 * replays the stored records through it with `costNanoUsd` pinned to what was actually
 * charged. Replaying rather than re-pricing is the point: an old ledger must total what
 * it cost on the day, not what today's price list says, and `RecordCallInput` carries
 * the override for exactly that reason.
 *
 * **Where the records come from is a gap, not a design.** `usage_records` exists in
 * `packages/persistence/src/schema/ops.ts`, and the only repository over it lives in
 * `apps/api/src/infrastructure/persistence/drizzle-run.repository.ts`, which the CLI
 * cannot import - `@rv/api` has no `exports` map and a deep import across apps is a
 * layering breach `arch:check` would refuse. So the CLI writes and reads its own
 * `runs/<runId>/ledger.json`, holding the same `UsageRecord` documents. The day that
 * repository moves into `@rv/persistence`, this file changes its reader and nothing
 * else.
 */

import type { CostBucket, CostSummary, ProjectId, RunId, UsageRecord } from '@rv/contracts';
import { CostMeter } from '@rv/providers';
import { NotFoundError, formatUsd, isErr, nanoUsd, type Clock } from '@rv/shared-kernel';

import { flag, option, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, fail, usageError } from '../cli/report';
import { keyValues, table } from '../cli/text';
import { LedgerDocument } from '../store/documents';
import { listDirectories, readJsonOrNull } from '../store/json-file';
import { runPaths, type ProjectPaths } from '../store/layout';
import { listProjects, resolveProject } from '../store/project';

/**
 * Rebuilds a `CostSummary` from stored records.
 *
 * The clock is injected because `CostMeter` stamps `updatedAt` on the ledger it builds;
 * the summary itself is a pure fold over the rows.
 */
export function summariseRecords(
  records: readonly UsageRecord[],
  projectId: ProjectId,
  clock: Clock,
): CostSummary {
  const meter = new CostMeter({ clock, projectId });
  for (const record of records) {
    meter.record({
      runId: record.runId,
      jobId: record.jobId,
      stage: record.stage,
      provider: record.provider,
      model: record.model,
      task: record.task,
      tier: record.tier,
      usage: {
        tokens: record.tokens,
        images: record.images,
        latencyMs: record.latencyMs,
      },
      outcome: record.outcome,
      errorCode: record.errorCode,
      cacheHit: record.cacheHit,
      // Pinned, not re-priced: an audit of last month must not move when a price does.
      costNanoUsd: nanoUsd(record.costNanoUsd),
    });
  }
  return meter.summary();
}

async function readLedger(paths: ProjectPaths, runId: RunId): Promise<LedgerDocument | null> {
  const ledger = await readJsonOrNull(runPaths(paths, runId).ledger, LedgerDocument, 'ledger');
  return ledger.ok ? ledger.value : null;
}

function bucketRows(
  label: string,
  buckets: Readonly<Record<string, CostBucket>>,
): readonly (readonly string[])[] {
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => [
      label,
      key,
      String(bucket.calls),
      String(bucket.failures),
      String(bucket.inputTokens + bucket.outputTokens),
      String(bucket.images),
      formatUsd(nanoUsd(bucket.costNanoUsd)),
    ]);
}

export const costReportCommand: Command = {
  path: ['cost', 'report'],
  summary: 'per-provider, per-stage cost breakdown for one run',
  usage: ['rv cost report --run <runId> [--project <id>] [--json]'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const runId = option(args, 'run');
    if (runId === undefined) {
      return usageError(context.io, 'Which run? e.g. rv cost report --run run_01J…', json);
    }

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const ledger = await readLedger(project.value.paths, runId);
    if (ledger === null) {
      return fail(
        context.io,
        new NotFoundError('run ledger', runId, {
          context: { hint: 'runs are listed by: rv series cost --json' },
        }),
        { json },
      );
    }

    const summary = summariseRecords(ledger.records, project.value.record.id, context.clock);

    if (json) {
      emitJson(context.io, {
        runId,
        projectId: project.value.record.id,
        recordCount: ledger.records.length,
        summary,
      });
      return EXIT.ok;
    }

    context.io.out();
    for (const line of keyValues([
      ['run', runId],
      ['calls', String(summary.total.calls)],
      ['failures', String(summary.total.failures)],
      ['tokens', String(summary.total.inputTokens + summary.total.outputTokens)],
      ['images', String(summary.total.images)],
      ['total', formatUsd(nanoUsd(summary.total.costNanoUsd))],
    ])) {
      context.io.out(line);
    }

    const rows = [
      ...bucketRows('provider', summary.byProvider),
      ...bucketRows('stage', summary.byStage),
      ...bucketRows('model', summary.byModel),
      ...bucketRows('task', summary.byTask),
    ];

    if (rows.length > 0) {
      context.io.out();
      for (const line of table({
        columns: [
          { header: 'slice' },
          { header: 'key' },
          { header: 'calls', align: 'right' },
          { header: 'fail', align: 'right' },
          { header: 'tokens', align: 'right' },
          { header: 'images', align: 'right' },
          { header: 'cost', align: 'right' },
        ],
        indent: '  ',
        rows,
      })) {
        context.io.out(line);
      }
    }
    context.io.out();
    return EXIT.ok;
  },
};

export const seriesCostCommand: Command = {
  path: ['series', 'cost'],
  summary: 'total spend across every run of every project, and cost per delivered minute',
  usage: ['rv series cost [--project <id>] [--json]'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const explicit = option(args, 'project');

    const projects =
      explicit === undefined
        ? await listProjects(context.workspaceRoot)
        : await resolveProject({
            workspaceRoot: context.workspaceRoot,
            explicit,
            env: context.env,
          }).then((one) => (one.ok ? { ok: true as const, value: [one.value] } : one));
    if (isErr(projects)) return fail(context.io, projects.error, { json });

    const rows: {
      projectId: string;
      runId: string;
      calls: number;
      costNanoUsd: number;
      /** False when the run wrote no ledger, i.e. it never called a paid provider. */
      metered: boolean;
    }[] = [];

    for (const project of projects.value) {
      const runIds = await listDirectories(project.paths.runsDir);
      for (const runId of [...runIds].sort()) {
        const ledger = await readLedger(project.paths, runId);
        // A run with no ledger is a run that made no metered provider call - a render
        // and a delivery both do exactly that. Skipping it would report `runs: 0`
        // immediately after a successful free-lane run, which reads as "nothing
        // happened" and is the opposite of the $0 proof this command exists to show.
        const summary =
          ledger === null
            ? null
            : summariseRecords(ledger.records, project.record.id, context.clock);
        rows.push({
          projectId: project.record.id,
          runId,
          calls: summary?.total.calls ?? 0,
          costNanoUsd: summary?.total.costNanoUsd ?? 0,
          metered: summary !== null,
        });
      }
    }

    const totalNanoUsd = rows.reduce((sum, row) => sum + row.costNanoUsd, 0);

    if (json) {
      emitJson(context.io, {
        projects: projects.value.length,
        runs: rows.length,
        totalNanoUsd,
        totalUsd: formatUsd(nanoUsd(totalNanoUsd)),
        byRun: rows,
      });
      return EXIT.ok;
    }

    context.io.out();
    if (rows.length === 0) {
      context.io.out('  No runs yet.');
      context.io.out();
      return EXIT.ok;
    }
    for (const line of table({
      columns: [
        { header: 'project' },
        { header: 'run' },
        { header: 'calls', align: 'right' },
        { header: 'cost', align: 'right' },
      ],
      indent: '  ',
      rows: rows.map((row) => [
        row.projectId,
        row.runId,
        row.metered ? String(row.calls) : '-',
        formatUsd(nanoUsd(row.costNanoUsd)),
      ]),
    })) {
      context.io.out(line);
    }
    context.io.out();
    context.io.out(`  total  ${formatUsd(nanoUsd(totalNanoUsd))}`);
    context.io.out();
    return EXIT.ok;
  },
};
