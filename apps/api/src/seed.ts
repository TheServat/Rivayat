/**
 * `pnpm --filter @rv/api seed` - the demo, written through the real application.
 *
 * A separate entry point rather than a flag on `main.ts`, for two reasons the brief for
 * this asked for directly: it must be **explicit**, and it must **never happen on every
 * boot**. An env var would have been the obvious alternative and is the wrong one here -
 * every `RV_*` name the process sees is checked against the settings registry, so a
 * `RV_SEED_DEMO` nothing declares would be reported to the operator as a typo on the
 * settings screen. A command you type has no such side effect.
 *
 * It boots the whole application rather than reaching for a database handle, so the
 * seeded records go through the same use-cases, the same repositories and the same
 * schemas a request would. That is the point of seeding at all: a hand-written JSON blob
 * that happens to parse teaches nothing, and the first thing worth knowing about a demo
 * is that the real write path can produce it.
 *
 * Running it twice is a no-op. `seedDemo` uses fixed ids and conflict-safe inserts, so
 * this is a command an operator can run whenever they are not sure whether they ran it.
 */

import 'reflect-metadata';

import { isErr, type Clock, type Logger } from '@rv/shared-kernel';
import type { DatabaseHandle } from '@rv/persistence';

import { createApp } from './bootstrap';
import type {
  ProjectRepository,
  RunRepository,
  SeriesRepository,
} from './application/ports/repository.ports';
import { seedDemo, type DemoSeedReport } from './infrastructure/seed/demo-seed';
import {
  CLOCK,
  DATABASE,
  LOGGER,
  PROJECT_REPOSITORY,
  RUN_REPOSITORY,
  SERIES_REPOSITORY,
} from './tokens';

async function main(): Promise<void> {
  const { app, config } = await createApp({ quiet: true });

  try {
    const report = await seedDemo({
      database: app.get<DatabaseHandle>(DATABASE),
      projects: app.get<ProjectRepository>(PROJECT_REPOSITORY),
      series: app.get<SeriesRepository>(SERIES_REPOSITORY),
      runs: app.get<RunRepository>(RUN_REPOSITORY),
      clock: app.get<Clock>(CLOCK),
      logger: app.get<Logger>(LOGGER),
      workspaceDir: config.paths.workspaceDir,
    });

    if (isErr(report)) {
      // The message, not the stack: a seeder failure is almost always a missing file or
      // a schema that moved, and both are named in the message.
      console.error(`seed failed: ${report.error.message}`);
      process.exitCode = 1;
      return;
    }

    const { value } = report;
    // `process.stdout`, not `console.log`: this is a command's report to whoever ran it,
    // which is exactly the output stream, and it keeps the report out of the structured
    // log where a machine would have to parse prose back out of it.
    reportLines(value);
  } finally {
    await app.close();
  }
}

/** The report, on stdout, one field per line. */
function reportLines(value: DemoSeedReport): void {
  const lines = value.alreadySeeded
    ? ['demo already present; nothing to write']
    : [
        'demo seeded',
        `  project      ${value.projectId}`,
        `  series       ${value.seriesId}`,
        `  style bible  ${value.styleBibleId} (locked)`,
        `  entities     ${String(value.entityIds.length)}`,
        `  relations    ${String(value.relationIds.length)}`,
        `  artifacts    ${value.artifacts.map((artifact) => artifact.path).join(', ')}`,
      ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((caught: unknown) => {
  console.error(caught);
  process.exitCode = 1;
});
