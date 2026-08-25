/**
 * S1 Style over HTTP - the five requests the Style Lab makes, in the order it makes them.
 *
 * `GET /presets` → `POST /from-preset` (or `POST /derive`) → `POST /:id/probe` →
 * `POST /:id/lock`. That order is the product decision and it is not the order
 * `GenerateStyleProbeUseCase` was written for; `style/probe-seal.ts` holds the whole of
 * why, and this controller is deliberately ignorant of it.
 *
 * The one thing worth noticing here is what each route *costs*. `presets` is a pure
 * projection of a module-level constant. `from-preset` and `lock` are one row each.
 * `probe` is four image generations - free on the local lane, real money on the paid one
 * - and `derive` is a vision call over up to sixteen references. A client that treats
 * them as interchangeable will be surprised, so the two expensive ones are POSTs with
 * bodies rather than GETs a browser might prefetch.
 */

import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { StyleBibleId, type StyleBible } from '@rv/contracts';
import type { Result } from '@rv/shared-kernel';

import type { StyleEnginePort } from '../../application/ports/engine.ports';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { STYLE_ENGINE_PORT } from '../../tokens';
import {
  DeriveStyleBody,
  FromPresetBody,
  ProbeStyleBody,
  type StylePresetList,
  type StyleProbeSheet,
} from './style.contracts';

@Controller('style')
export class StyleController {
  readonly #engine: StyleEnginePort;

  constructor(@Inject(STYLE_ENGINE_PORT) engine: StyleEnginePort) {
    this.#engine = engine;
  }

  /**
   * The shelf, with enough of each preset to choose between them.
   *
   * Free and cacheable: `STYLE_PRESETS` is compiled at module load, so this reads no
   * row and calls no provider.
   */
  @Get('presets')
  presets(): Promise<Result<StylePresetList>> {
    return this.#engine.listPresets();
  }

  /**
   * One bible by id, so a project can show the style it already locked.
   *
   * A GET among four POSTs, and correctly so: it reads one row, changes nothing, and is
   * safe for a browser to prefetch - which is exactly what the neighbouring `probe` is
   * not.
   */
  @Get(':id')
  find(
    @Param('id', new ZodValidationPipe(StyleBibleId)) id: StyleBibleId,
  ): Promise<Result<StyleBible>> {
    return this.#engine.find(id);
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
   * Four tiles, so a human can say yes before anything is committed to.
   *
   * Declared before `:id/lock` for no routing reason - both are two-segment - but read
   * in the order the screen calls them. On the free lane this is four 512px ComfyUI
   * draws at $0.00, which is what makes rejecting six candidate styles cost nothing.
   */
  @Post(':id/probe')
  probe(
    @Param('id', new ZodValidationPipe(StyleBibleId)) id: StyleBibleId,
    @Body(new ZodValidationPipe(ProbeStyleBody)) body: ProbeStyleBody,
  ): Promise<Result<StyleProbeSheet>> {
    return this.#engine.probe({ styleBibleId: id, lane: body.lane });
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
