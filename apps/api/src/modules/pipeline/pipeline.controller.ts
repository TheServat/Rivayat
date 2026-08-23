/**
 * Starting, watching, cancelling and auditing a run.
 *
 * The ledger route is not an afterthought: non-negotiable #3 says cost is metered
 * before it is spent, and a meter nobody can read is a meter nobody trusts. `GET
 * /api/runs/:id/ledger` returns the per-run rows and the four summaries `CostSummary`
 * defines - by provider, by model, by task and by stage - because those are the four
 * questions that actually get asked about a bill.
 *
 * The event stream lives in `events/`, not here, because it is a different transport
 * with a different lifecycle. It shares the `/api/runs/:id` prefix, which is right: it
 * is the same resource seen live.
 */

import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { CostLedger, ProjectId, RunId } from '@rv/contracts';
import { NotFoundError, type Result, err, isErr, ok } from '@rv/shared-kernel';

import type { RunRepository } from '../../application/ports/repository.ports';
import type { RunSummary } from '../../application/resources';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { CostService } from '../../cost/cost.service';
import type { PipelineRunner } from '../../pipeline/pipeline-runner.service';
import { COST_SERVICE, RUN_REPOSITORY } from '../../tokens';
import { PIPELINE_RUNNER } from '../module-tokens';
import { ProjectIdParam, RunIdParam, StartRunBody } from './pipeline.contracts';

@Controller()
export class PipelineController {
  readonly #runner: PipelineRunner;
  readonly #runs: RunRepository;
  readonly #cost: CostService;

  constructor(
    @Inject(PIPELINE_RUNNER) runner: PipelineRunner,
    @Inject(RUN_REPOSITORY) runs: RunRepository,
    @Inject(COST_SERVICE) cost: CostService,
  ) {
    this.#runner = runner;
    this.#runs = runs;
    this.#cost = cost;
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
    return ok(this.#cost.ledger(run.value.projectId, id));
  }

  @Post('runs/:id/cancel')
  @HttpCode(202)
  cancel(@Param('id', new ZodValidationPipe(RunIdParam)) id: RunId): Promise<Result<RunSummary>> {
    return this.#runner.cancel(id);
  }
}
