/**
 * S10/S11 over HTTP.
 *
 * `GET /api/render/formats` is real and useful today: `FORMAT_PRESETS` in
 * `@rv/contracts` holds the platform specs research §7 verified live, and a client
 * choosing delivery targets needs them before anything is rendered. Serving them from
 * the contract rather than from a copy is the whole reason they are data.
 *
 * `POST /api/render/reframe` is real and needs no render at all. Reframing is
 * *computed, not re-authored* (architecture section 7): one composition becomes seven
 * deliverables by solving a crop per shot per format against the verified safe zones,
 * and that solve is microseconds of pure geometry. Putting it behind a run would make
 * the studio wait on an encoder to answer a question about framing.
 *
 * `POST /api/render/deliveries` starts S11. It *is* a run - `POST /api/runs` with
 * `stages: ['deliver']` says the same thing - and it exists because that sentence needs
 * two things the screen does not have: the shape of a stage payload, and the render key
 * of the master. What the screen has is a finished run and a button, so that is what
 * this takes.
 *
 * `POST /api/render` remains bound to the one-shot render port. The pipeline's S10 is
 * the real path - `POST /api/runs` with `stages: ['render']` - because that one is
 * resumable, cancellable and metered, and this one is not.
 */

import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { FORMAT_PRESETS, type FormatProfile } from '@rv/contracts';
import { NotFoundError, ValidationError, err, isErr, ok, type Result } from '@rv/shared-kernel';

import type { RenderOutput, RenderPort } from '../../application/ports/engine.ports';
import type { RunRepository } from '../../application/ports/repository.ports';
import type { RunSummary } from '../../application/resources';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { PipelineRunner } from '../../pipeline/pipeline-runner.service';
import { renderKeyOf } from '../../render/delivery.service';
import { ReframeBody, type ReframePlanSet } from '../../render/reframe.contracts';
import type { ReframeService } from '../../render/reframe.service';
import { REFRAME_SERVICE, RENDER_PORT, RUN_REPOSITORY } from '../../tokens';
import { PIPELINE_RUNNER } from '../module-tokens';
import { StartDeliveryBody } from './deliveries.contracts';
import { RenderBody } from './render.contracts';

@Controller('render')
export class RenderController {
  readonly #render: RenderPort;
  readonly #reframe: ReframeService;
  readonly #runner: PipelineRunner;
  readonly #runs: RunRepository;

  constructor(
    @Inject(RENDER_PORT) render: RenderPort,
    @Inject(REFRAME_SERVICE) reframe: ReframeService,
    @Inject(PIPELINE_RUNNER) runner: PipelineRunner,
    @Inject(RUN_REPOSITORY) runs: RunRepository,
  ) {
    this.#render = render;
    this.#reframe = reframe;
    this.#runner = runner;
    this.#runs = runs;
  }

  /** The verified platform specs. No engine needed - these are data. */
  @Get('formats')
  formats(): Result<readonly FormatProfile[]> {
    return ok(Object.values(FORMAT_PRESETS));
  }

  /**
   * A crop per shot per format, solved from the composition alone.
   *
   * Synchronous on purpose: no encoder, no disk, no provider and no money, so a run
   * would be ceremony around a pure function. The response says whether the shot list
   * was derived, because "the whole timeline as one shot" is a correct answer to a
   * composition and a misleading one to an episode.
   */
  @Post('reframe')
  reframe(@Body(new ZodValidationPipe(ReframeBody)) body: ReframeBody): Result<ReframePlanSet> {
    return this.#reframe.plan(body);
  }

  /**
   * Cuts every requested format from a master that already exists. 202, not 201.
   *
   * The run record exists when this returns and the files do not: seven transcodes of a
   * 1080p master is minutes, and a 201 would tell the client the work was done.
   *
   * `$0`. Nothing here calls a provider, so the ledger for the run this starts reads
   * zero - which is what makes "re-framing to another aspect ratio is free" a fact
   * about the bill rather than a claim about the arithmetic.
   */
  @Post('deliveries')
  @HttpCode(202)
  async deliver(
    @Body(new ZodValidationPipe(StartDeliveryBody)) body: StartDeliveryBody,
  ): Promise<Result<RunSummary>> {
    const key = await this.#renderKey(body);
    if (isErr(key)) return key;

    return this.#runner.start({
      projectId: body.projectId,
      seriesId: body.seriesId,
      stages: ['deliver'],
      seed: body.seed,
      budgetNanoUsd: body.budgetNanoUsd,
      payload: {
        deliver: {
          renderKey: key.value,
          formats: body.formats,
          checkBitrate: body.checkBitrate,
          ...(body.outputDir === undefined ? {} : { outputDir: body.outputDir }),
          ...(body.maxPanPerSecond === undefined ? {} : { maxPanPerSecond: body.maxPanPerSecond }),
        },
      },
    });
  }

  /**
   * The master this delivery is about, as a content address.
   *
   * Resolved here rather than in the stage so the caller learns *now* that the run they
   * pointed at never rendered anything, instead of learning it from a run that fails a
   * second later. The lookup is `renderKeyOf`, the same one the delivery route uses, so
   * the two cannot disagree about what a run produced.
   */
  async #renderKey(body: StartDeliveryBody): Promise<Result<string>> {
    if (body.renderKey !== undefined) return ok(body.renderKey);

    const runId = body.runId;
    if (runId === undefined) {
      return err(new ValidationError({ message: 'name the master by `runId` or by `renderKey`' }));
    }

    const found = await this.#runs.findById(runId);
    if (isErr(found)) return found;
    if (found.value === null) return err(new NotFoundError('run', runId));

    const key = renderKeyOf(found.value);
    return key === null
      ? err(
          new ValidationError({
            message: `run ${runId} has not completed a render, so it has no master to deliver`,
            context: { runId, status: found.value.status },
          }),
        )
      : ok(key);
  }

  @Post()
  start(@Body(new ZodValidationPipe(RenderBody)) body: RenderBody): Promise<Result<RenderOutput>> {
    return this.#render.render({
      ir: body.ir,
      formats: body.formats,
      outputDir: body.outputDir,
    });
  }
}
