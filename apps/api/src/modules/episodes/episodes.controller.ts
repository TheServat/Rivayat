/**
 * Episodes, read-only, over the real `episodes` table.
 *
 * There is no write route because nothing can legitimately produce an episode yet: S2
 * Story is bound to a stub, and an endpoint that let a client POST one would let the
 * narrative graph and the episode tree diverge on day one - which non-negotiable #7,
 * "aired canon is immutable", has no way to recover from.
 *
 * What is served is `EpisodeOutline`, not `Episode`: the acts carry scene *ids* rather
 * than scene bodies. An episode with its scenes inlined is a several-hundred-kilobyte
 * document for a list view, and `@rv/contracts` already models the projection.
 */

import { Controller, Get, Inject, Param } from '@nestjs/common';
import { EpisodeId, SeriesId, type EpisodeOutline } from '@rv/contracts';
import { NotFoundError, type Result, err, isErr, ok } from '@rv/shared-kernel';

import type { EpisodeRepository } from '../../application/ports/repository.ports';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { EPISODE_REPOSITORY } from '../../tokens';

@Controller()
export class EpisodesController {
  readonly #episodes: EpisodeRepository;

  constructor(@Inject(EPISODE_REPOSITORY) episodes: EpisodeRepository) {
    this.#episodes = episodes;
  }

  @Get('series/:seriesId/episodes')
  list(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
  ): Promise<Result<readonly EpisodeOutline[]>> {
    return this.#episodes.listBySeries(seriesId);
  }

  @Get('episodes/:id')
  async findOne(
    @Param('id', new ZodValidationPipe(EpisodeId)) id: EpisodeId,
  ): Promise<Result<EpisodeOutline>> {
    const found = await this.#episodes.findById(id);
    if (isErr(found)) return found;
    return found.value === null ? err(new NotFoundError('episode', id)) : ok(found.value);
  }
}
