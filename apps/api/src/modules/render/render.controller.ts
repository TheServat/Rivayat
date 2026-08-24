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
 * `POST /api/render` remains bound to the one-shot render port. The pipeline's S10 is
 * the real path - `POST /api/runs` with `stages: ['render']` - because that one is
 * resumable, cancellable and metered, and this one is not.
 */

import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { FORMAT_PRESETS, type FormatProfile } from '@rv/contracts';
import type { Result } from '@rv/shared-kernel';
import { ok } from '@rv/shared-kernel';

import type { RenderOutput, RenderPort } from '../../application/ports/engine.ports';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ReframeBody, type ReframePlanSet } from '../../render/reframe.contracts';
import type { ReframeService } from '../../render/reframe.service';
import { REFRAME_SERVICE, RENDER_PORT } from '../../tokens';
import { RenderBody } from './render.contracts';

@Controller('render')
export class RenderController {
  readonly #render: RenderPort;
  readonly #reframe: ReframeService;

  constructor(
    @Inject(RENDER_PORT) render: RenderPort,
    @Inject(REFRAME_SERVICE) reframe: ReframeService,
  ) {
    this.#render = render;
    this.#reframe = reframe;
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

  @Post()
  start(@Body(new ZodValidationPipe(RenderBody)) body: RenderBody): Promise<Result<RenderOutput>> {
    return this.#render.render({
      ir: body.ir,
      formats: body.formats,
      outputDir: body.outputDir,
    });
  }
}
