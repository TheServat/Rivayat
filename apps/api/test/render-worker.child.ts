/**
 * A real, separate, killable Rivayat process.
 *
 * `resume.e2e-spec.ts` claims that a render killed mid-flight resumes to a
 * **byte-identical** master. That is a determinism claim, and the only way to test it
 * honestly is to kill something: an `AbortController` inside the test process proves
 * the abort path, not the crash path, and it leaves every in-memory structure - the
 * checkpoint, the run record, the payload - intact and available to the "resumed" run.
 * A `SIGKILL` leaves exactly what a crash leaves, which is whatever reached the disk.
 *
 * So this file boots the whole application - the same `AppModule`, the same composition
 * root, the same SQLite file, the same in-process queue - drives one run through
 * `PipelineRunner`, and prints machine-readable lines the parent reads off stdout. The
 * parent watches the frame directory and kills it with no warning.
 *
 * It uses `PipelineRunner` directly rather than HTTP because the property under test is
 * durability across a process boundary, and an HTTP server adds a port handshake to a
 * test whose whole difficulty is timing. The HTTP surface over the same methods is
 * covered by `cancellation.e2e-spec.ts` and `pipeline.e2e-spec.ts`.
 *
 * Run as: `node --conditions=development --import tsx render-worker.child.ts <json>`
 * where `<json>` is a path to `{ mode, workspace, database, payloadFile, runId? }`.
 */

import { readFileSync } from 'node:fs';

import { NestFactory } from '@nestjs/core';
import { isErr } from '@rv/shared-kernel';

import { AppModule } from '../src/app.module';
import type { RunRepository } from '../src/application/ports/repository.ports';
import type { PipelineRunner } from '../src/pipeline/pipeline-runner.service';
import type { JobQueue } from '../src/queue/job-queue.port';
import { JOB_QUEUE, RUN_REPOSITORY } from '../src/tokens';
import { PIPELINE_RUNNER } from '../src/modules/module-tokens';

interface ChildRequest {
  readonly mode: 'start' | 'resume';
  readonly workspace: string;
  readonly database: string;
  readonly payloadFile: string;
  readonly projectId: string;
  readonly runId?: string;
}

/** One line, one JSON object. The parent parses stdout line by line. */
function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<number> {
  const configPath = process.argv[2];
  if (configPath === undefined) throw new Error('usage: render-worker.child.ts <config.json>');
  const request = JSON.parse(readFileSync(configPath, 'utf8')) as ChildRequest;

  const context = await NestFactory.createApplicationContext(
    AppModule.forRoot({
      env: {
        NODE_ENV: 'test',
        RV_LOG_LEVEL: 'error',
        RV_DB_URL: request.database,
        RV_WORKSPACE_DIR: request.workspace,
        RV_ASSET_STORE_DIR: `${request.workspace}/assets`,
        RV_API_PREFIX: 'api',
        REDIS_URL: '',
        RV_QUEUE_CONCURRENCY: '1',
        RV_SEED: '42',
        OLLAMA_HOST: '',
        GEMINI_API_KEY: '',
        OPENROUTER_API_KEY: '',
        COMFYUI_HOST: '',
        RV_COMFYUI_ENABLED: 'false',
      },
    }),
    { logger: false },
  );

  const runner = context.get<PipelineRunner>(PIPELINE_RUNNER);
  const queue = context.get<JobQueue>(JOB_QUEUE);
  const runs = context.get<RunRepository>(RUN_REPOSITORY);

  const started =
    request.mode === 'start'
      ? await runner.start({
          projectId: request.projectId,
          seriesId: null,
          stages: ['render'],
          seed: 42,
          budgetNanoUsd: null,
          payload: { render: JSON.parse(readFileSync(request.payloadFile, 'utf8')) as unknown },
        })
      : await runner.resume(request.runId ?? '');

  if (isErr(started)) {
    emit({ event: 'error', code: started.error.code, message: started.error.message });
    await context.close();
    return 1;
  }

  // Printed before the work, so the parent has the run id in hand when it kills us.
  emit({ event: 'accepted', runId: started.value.id, status: started.value.status });

  const drained = await queue.drain(120_000);
  if (isErr(drained)) emit({ event: 'error', code: drained.error.code });

  const finished = await runs.findById(started.value.id);
  emit({ event: 'finished', run: isErr(finished) ? null : finished.value });

  await context.close();
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((caught: unknown) => {
    emit({ event: 'crashed', message: String(caught) });
    process.exit(2);
  });
