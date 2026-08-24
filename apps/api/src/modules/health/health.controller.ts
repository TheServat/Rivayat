/**
 * `GET /api/health` - what is wired, what is reachable, and what is missing.
 *
 * RV-180 asks for provider availability and database status. Both are here, and so are
 * two things the backlog does not name but an operator asks within a minute of the
 * first two: which queue driver is running (because "why is nothing processing" is
 * usually "there is no Redis and you thought there was"), and which pipeline stages
 * this build can actually execute (because most of them cannot, and finding out by
 * starting a run is a poor way to learn it).
 *
 * The check is *cheap* on purpose. It touches the database with a `select 1` and reads
 * in-memory registries; it does not call a provider. A health endpoint that dials four
 * external services is a health endpoint that gets polled by a load balancer and turns
 * into a bill.
 */

import { Controller, Get, Inject } from '@nestjs/common';
import type { DatabaseHandle } from '@rv/persistence';
import { fromThrowable, isErr } from '@rv/shared-kernel';

import type { AppConfig } from '../../config/app-config';
import type { AdapterSet } from '../../infrastructure/providers/build-adapters';
import type { PipelineRunner } from '../../pipeline/pipeline-runner.service';
import type { JobQueue } from '../../queue/job-queue.port';
import { APP_CONFIG, CAPABILITY_MATRIX, DATABASE, JOB_QUEUE } from '../../tokens';
import { ADAPTER_SET, PIPELINE_RUNNER } from '../module-tokens';
import type { HealthReport } from './health.contracts';

@Controller('health')
export class HealthController {
  readonly #config: AppConfig;
  readonly #database: DatabaseHandle;
  readonly #queue: JobQueue;
  readonly #adapters: AdapterSet;
  readonly #runner: PipelineRunner;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(DATABASE) database: DatabaseHandle,
    @Inject(JOB_QUEUE) queue: JobQueue,
    @Inject(ADAPTER_SET) adapters: AdapterSet,
    @Inject(PIPELINE_RUNNER) runner: PipelineRunner,
    // Injected but unread: resolving the matrix here is what makes a broken provider
    // registration fail the health check rather than the first generation request.
    @Inject(CAPABILITY_MATRIX) _matrix: unknown,
  ) {
    this.#config = config;
    this.#database = database;
    this.#queue = queue;
    this.#adapters = adapters;
    this.#runner = runner;
  }

  @Get()
  check(): HealthReport {
    const probe = fromThrowable(
      () => this.#database.sqlite.prepare('select 1 as ok').get(),
      (caught) => String(caught),
    );

    return {
      status: isErr(probe) ? 'degraded' : 'ok',
      env: this.#config.env,
      database: {
        location: this.#database.location,
        reachable: !isErr(probe),
        ...(isErr(probe) ? { error: probe.error } : {}),
      },
      queue: {
        driver: this.#queue.driver,
        concurrency: this.#config.queue.concurrency,
        peakConcurrency: this.#queue.peakConcurrency,
      },
      providers: {
        // `provider:model`, because two models on one provider are two different
        // cost/latency propositions and "gemini is up" answers neither question.
        registered: this.#adapters.adapters.map((adapter) => adapter.modelRef),
        skipped: this.#adapters.skipped.map((entry) => ({ ...entry })),
      },
      pipeline: {
        implementedStages: [...this.#runner.implementedStages()],
        stubbedStages: [...this.#runner.stubbedStages()],
        registeredStages: [...this.#runner.registeredStages()],
      },
    };
  }
}
