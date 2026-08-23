/**
 * S10/S11 over HTTP.
 *
 * `GET /api/render/formats` is real and useful today: `FORMAT_PRESETS` in
 * `@rv/contracts` holds the platform specs research §7 verified live, and a client
 * choosing delivery targets needs them before anything is rendered. Serving them from
 * the contract rather than from a copy is the whole reason they are data.
 *
 * `POST /api/render` is bound to a stub, because `@rv/render-engine` is scaffolded.
 */

import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { FORMAT_PRESETS, type FormatProfile } from '@rv/contracts';
import type { Result } from '@rv/shared-kernel';
import { ok } from '@rv/shared-kernel';

import type { RenderOutput, RenderPort } from '../../application/ports/engine.ports';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RENDER_PORT } from '../../tokens';
import { RenderBody } from './render.contracts';

@Controller('render')
export class RenderController {
  readonly #render: RenderPort;

  constructor(@Inject(RENDER_PORT) render: RenderPort) {
    this.#render = render;
  }

  /** The verified platform specs. No engine needed - these are data. */
  @Get('formats')
  formats(): Result<readonly FormatProfile[]> {
    return ok(Object.values(FORMAT_PRESETS));
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
