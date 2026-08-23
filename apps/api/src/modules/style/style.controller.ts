/**
 * S1 Style over HTTP.
 *
 * Every route here is wired to `StyleEnginePort`, which is bound to a stub because
 * `@rv/style-engine` exports nothing but its own name today. The routes exist anyway:
 * the request is validated against the real schemas, the 501 carries the package that
 * owes the work, and the OpenAPI document lists the endpoints a client will eventually
 * call. When the engine lands, one `useValue` in `app.module.ts` changes and this file
 * does not.
 */

import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { Slug, StyleBibleId, type StyleBible } from '@rv/contracts';
import type { Result } from '@rv/shared-kernel';

import type { StyleEnginePort } from '../../application/ports/engine.ports';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { STYLE_ENGINE_PORT } from '../../tokens';
import { DeriveStyleBody, FromPresetBody } from './style.contracts';

@Controller('style')
export class StyleController {
  readonly #engine: StyleEnginePort;

  constructor(@Inject(STYLE_ENGINE_PORT) engine: StyleEnginePort) {
    this.#engine = engine;
  }

  @Get('presets')
  presets(): Promise<Result<readonly Slug[]>> {
    return this.#engine.listPresets();
  }

  @Post('from-preset')
  fromPreset(
    @Body(new ZodValidationPipe(FromPresetBody)) body: FromPresetBody,
  ): Promise<Result<StyleBible>> {
    return this.#engine.fromPreset(body.preset);
  }

  @Post('derive')
  derive(
    @Body(new ZodValidationPipe(DeriveStyleBody)) body: DeriveStyleBody,
  ): Promise<Result<StyleBible>> {
    return this.#engine.derive({ brief: body.brief, referenceHashes: body.referenceHashes });
  }

  /**
   * Freezes the checksum.
   *
   * The single most consequential write in the system: every asset dedup key depends
   * on this value, so locking a different bible forks the entire asset library rather
   * than reusing it.
   */
  @Post(':id/lock')
  lock(
    @Param('id', new ZodValidationPipe(StyleBibleId)) id: StyleBibleId,
  ): Promise<Result<StyleBible>> {
    return this.#engine.lock(id);
  }
}
