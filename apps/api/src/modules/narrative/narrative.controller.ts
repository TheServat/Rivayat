/**
 * The narrative graph over HTTP.
 *
 * Bound to `NarrativeMemoryPort`, which is a stub: `@rv/narrative-memory` is scaffolded
 * and ADR-0004's bi-temporal graph is the single largest unbuilt piece of the system.
 * The routes are here because they are the ones the studio's continuity panel calls,
 * and a 501 that names `@rv/narrative-memory` is a better answer to a UI developer than
 * a 404.
 */

import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import {
  EpisodeId,
  Scene,
  SeriesId,
  type ContinuityIssue,
  type MemoryRetrievalResult,
} from '@rv/contracts';
import type { Result } from '@rv/shared-kernel';

import type { NarrativeMemoryPort } from '../../application/ports/engine.ports';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { NARRATIVE_MEMORY_PORT } from '../../tokens';
import { RetrieveMemoryBody } from './narrative.contracts';

@Controller('narrative')
export class NarrativeController {
  readonly #memory: NarrativeMemoryPort;

  constructor(@Inject(NARRATIVE_MEMORY_PORT) memory: NarrativeMemoryPort) {
    this.#memory = memory;
  }

  @Post('series/:seriesId/scenes')
  ingest(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
    @Body(new ZodValidationPipe(Scene)) scene: Scene,
  ): Promise<Result<readonly ContinuityIssue[]>> {
    return this.#memory.ingestScene(seriesId, scene);
  }

  @Get('episodes/:episodeId/continuity')
  continuity(
    @Param('episodeId', new ZodValidationPipe(EpisodeId)) episodeId: EpisodeId,
  ): Promise<Result<readonly ContinuityIssue[]>> {
    return this.#memory.checkContinuity(episodeId);
  }

  @Post('retrieve')
  retrieve(
    @Body(new ZodValidationPipe(RetrieveMemoryBody)) body: RetrieveMemoryBody,
  ): Promise<Result<MemoryRetrievalResult>> {
    return this.#memory.retrieve(body);
  }
}
