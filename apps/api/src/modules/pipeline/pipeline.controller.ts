/**
 * Starting, watching, cancelling and auditing a run.
 *
 * The ledger routes are not an afterthought: non-negotiable #3 says cost is metered
 * before it is spent, and a meter nobody can read is a meter nobody trusts. `GET
 * /api/runs/:id/ledger` returns the per-run rows and the four summaries `CostSummary`
 * defines - by provider, by model, by task and by stage - because those are the four
 * questions that actually get asked about a bill. `GET /api/projects/:id/cost` answers
 * the fifth, which is the only one that compares two episodes fairly: cost per
 * delivered minute. Both read `usage_records` rather than the in-process meter, because
 * a bill has to outlive the process that ran up the charges - see `LedgerService`.
 *
 * The event stream lives in `events/`, not here, because it is a different transport
 * with a different lifecycle. It shares the `/api/runs/:id` prefix, which is right: it
 * is the same resource seen live.
 */

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { CostLedger, ProjectId, RunId, SeriesId } from '@rv/contracts';
import { NotFoundError, type Result, err, isErr, ok } from '@rv/shared-kernel';

import type { RunRepository } from '../../application/ports/repository.ports';
import type { RunSummary } from '../../application/resources';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { CostReport } from '../../cost/cost-report';
import type { LedgerService } from '../../cost/ledger.service';
import type { PipelineRunner } from '../../pipeline/pipeline-runner.service';
import type { RunDelivery } from '../../render/delivery.contracts';
import type { DeliveryService } from '../../render/delivery.service';
import { DELIVERY_SERVICE, LEDGER_SERVICE, RUN_REPOSITORY } from '../../tokens';
import { PIPELINE_RUNNER } from '../module-tokens';
import { CostReportQuery, ProjectIdParam, RunIdParam, StartRunBody } from './pipeline.contracts';

@Controller()
export class PipelineController {
  readonly #runner: PipelineRunner;
  readonly #runs: RunRepository;
  readonly #ledger: LedgerService;
  readonly #delivery: DeliveryService;

  constructor(
    @Inject(PIPELINE_RUNNER) runner: PipelineRunner,
    @Inject(RUN_REPOSITORY) runs: RunRepository,
    @Inject(LEDGER_SERVICE) ledger: LedgerService,
    @Inject(DELIVERY_SERVICE) delivery: DeliveryService,
  ) {
    this.#runner = runner;
    this.#runs = runs;
    this.#ledger = ledger;
    this.#delivery = delivery;
  }

  /**
   * 202, not 201.
   *
   * The run *record* exists when this returns, but the run does not - the first stage
   * is queued. 201 would tell a client the work is done, which is wrong by minutes.
   */
  @Post('runs')
  @HttpCode(202)
  start(
    @Body(new ZodValidationPipe(StartRunBody)) body: StartRunBody,
  ): Promise<Result<RunSummary>> {
    return this.#runner.start({
      projectId: body.projectId,
      seriesId: body.seriesId,
      stages: body.stages,
      seed: body.seed,
      budgetNanoUsd: body.budgetNanoUsd,
      payload: body.payload,
    });
  }

  @Get('runs/:id')
  async findOne(
    @Param('id', new ZodValidationPipe(RunIdParam)) id: RunId,
  ): Promise<Result<RunSummary>> {
    const found = await this.#runs.findById(id);
    if (isErr(found)) return found;
    return found.value === null ? err(new NotFoundError('run', id)) : ok(found.value);
  }

  @Get('projects/:projectId/runs')
  listForProject(
    @Param('projectId', new ZodValidationPipe(ProjectIdParam)) projectId: ProjectId,
  ): Promise<Result<readonly RunSummary[]>> {
    return this.#runs.listByProject(projectId);
  }

  /** The per-run ledger, as `CostLedger` from `@rv/contracts`. */
  @Get('runs/:id/ledger')
  async ledger(
    @Param('id', new ZodValidationPipe(RunIdParam)) id: RunId,
  ): Promise<Result<CostLedger>> {
    const run = await this.#runs.findById(id);
    if (isErr(run)) return run;
    if (run.value === null) return err(new NotFoundError('run', id));
    return this.#ledger.forRun(run.value.projectId, id);
  }

  /**
   * What this project - or one series inside it - has cost, and per delivered minute.
   *
   * The series filter is a query parameter rather than a route under `/series/:id`
   * because it narrows the same report rather than producing a different one, and
   * because `rv series cost` and the project cost screen must not be able to disagree
   * about how a total is computed.
   */
  @Get('projects/:projectId/cost')
  costReport(
    @Param('projectId', new ZodValidationPipe(ProjectIdParam)) projectId: ProjectId,
    @Query(new ZodValidationPipe(CostReportQuery)) query: CostReportQuery,
  ): Promise<Result<CostReport>> {
    const seriesId: SeriesId | null = query.seriesId ?? null;
    return this.#ledger.forProject(projectId, seriesId);
  }

  /**
   * What the run actually put on disk, measured.
   *
   * Separate from the run resource because it is a different question with a different
   * cost: `RunSummary` is polled by every open progress bar and carries `kind:ref`
   * strings, while this carries the probe of each file - size, duration, codec, pixel
   * format, frame rate and the verdict against the platform spec. A screen cannot tell
   * a user their deliverable is in spec from an id.
   *
   * 404 when the run has not finished a render: a run with no files is not the same
   * thing as a run that does not exist, and the body says which.
   */
  @Get('runs/:id/delivery')
  delivery(
    @Param('id', new ZodValidationPipe(RunIdParam)) id: RunId,
  ): Promise<Result<RunDelivery>> {
    return this.#delivery.forRun(id);
  }

  @Post('runs/:id/cancel')
  @HttpCode(202)
  cancel(@Param('id', new ZodValidationPipe(RunIdParam)) id: RunId): Promise<Result<RunSummary>> {
    return this.#runner.cancel(id);
  }

  /**
   * 202: the run is re-queued, not finished.
   *
   * Resume is a *separate* verb from start because it is a different guarantee. Start
   * says "do this work"; resume says "do only the part of this work that is not already
   * checkpointed", and the run id in the path is what makes the second sentence
   * meaningful.
   */
  @Post('runs/:id/resume')
  @HttpCode(202)
  resume(@Param('id', new ZodValidationPipe(RunIdParam)) id: RunId): Promise<Result<RunSummary>> {
    return this.#runner.resume(id);
  }
}
