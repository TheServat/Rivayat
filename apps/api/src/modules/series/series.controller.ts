/**
 * Series live under a project and are listed by it, so the create and list routes are
 * nested and the fetch route is not.
 *
 * That asymmetry is deliberate rather than sloppy: `POST /api/projects/:id/series`
 * makes the parent part of the request, which is the only way a client can create one
 * without inventing a `projectId` field that could disagree with the URL. Once it
 * exists it has a global id, so `GET /api/series/:id` needs no parent.
 */

import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { Ids, type ProjectId, type SeriesId } from '@rv/contracts';
import { NotFoundError, type Clock, type Result, err, isErr, ok, toIso } from '@rv/shared-kernel';

import type { ProjectRepository, SeriesRepository } from '../../application/ports/repository.ports';
import { SeriesCard } from '../../application/resources';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CLOCK, IDS, PROJECT_REPOSITORY, SERIES_REPOSITORY } from '../../tokens';
import { CreateSeriesRequest, ProjectIdParam, SeriesIdParam } from './series.contracts';

@Controller()
export class SeriesController {
  readonly #series: SeriesRepository;
  readonly #projects: ProjectRepository;
  readonly #clock: Clock;
  readonly #ids: Ids;

  constructor(
    @Inject(SERIES_REPOSITORY) series: SeriesRepository,
    @Inject(PROJECT_REPOSITORY) projects: ProjectRepository,
    @Inject(CLOCK) clock: Clock,
    @Inject(IDS) ids: Ids,
  ) {
    this.#series = series;
    this.#projects = projects;
    this.#clock = clock;
    this.#ids = ids;
  }

  @Post('projects/:projectId/series')
  async create(
    @Param('projectId', new ZodValidationPipe(ProjectIdParam)) projectId: ProjectId,
    @Body(new ZodValidationPipe(CreateSeriesRequest)) body: CreateSeriesRequest,
  ): Promise<Result<SeriesCard>> {
    // Checked before creating rather than relying on a foreign key: `runs.project_id`
    // and `episodes.series_id` are bare columns in `@rv/persistence` with no referent,
    // so nothing below this line would catch an orphan.
    const parent = await this.#projects.findById(projectId);
    if (isErr(parent)) return parent;
    if (parent.value === null) return err(new NotFoundError('project', projectId));

    return this.#series.create(
      SeriesCard.parse({
        id: this.#ids.series(),
        projectId,
        title: body.title,
        premise: body.premise,
        hasBible: false,
        createdAt: toIso(this.#clock.now()),
      }),
    );
  }

  @Get('projects/:projectId/series')
  list(
    @Param('projectId', new ZodValidationPipe(ProjectIdParam)) projectId: ProjectId,
  ): Promise<Result<readonly SeriesCard[]>> {
    return this.#series.listByProject(projectId);
  }

  @Get('series/:id')
  async findOne(
    @Param('id', new ZodValidationPipe(SeriesIdParam)) id: SeriesId,
  ): Promise<Result<SeriesCard>> {
    const found = await this.#series.findById(id);
    if (isErr(found)) return found;
    return found.value === null ? err(new NotFoundError('series', id)) : ok(found.value);
  }
}
