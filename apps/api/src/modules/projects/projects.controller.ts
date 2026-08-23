/**
 * The projects surface: validate, call one use-case, return.
 *
 * Nothing here maps a `Result` and nothing here maps an error - `ResultInterceptor`
 * unwraps and `AppErrorFilter` formats, globally, so a controller that forgot would be
 * the only one behaving differently and that is exactly the bug worth designing out.
 */

import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { Ids, type ProjectId } from '@rv/contracts';
import { NotFoundError, type Clock, type Result, err, isErr, ok, toIso } from '@rv/shared-kernel';

import type {
  EpisodeRepository,
  ProjectRepository,
  RunRepository,
  SeriesRepository,
  StyleBibleReader,
} from '../../application/ports/repository.ports';
import type { Project } from '../../application/resources';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CLOCK,
  EPISODE_REPOSITORY,
  IDS,
  PROJECT_REPOSITORY,
  RUN_REPOSITORY,
  SERIES_REPOSITORY,
  STYLE_BIBLE_READER,
} from '../../tokens';
import { CreateProjectUseCase } from './create-project.use-case';
import { ProjectSummaryService } from './project-summary.service';
import {
  CreateProjectRequest,
  ProjectIdParam,
  UpdateProjectRequest,
  type ProjectList,
} from './projects.contracts';

@Controller('projects')
export class ProjectsController {
  readonly #repository: ProjectRepository;
  readonly #clock: Clock;
  readonly #create: CreateProjectUseCase;
  readonly #summaries: ProjectSummaryService;

  constructor(
    @Inject(PROJECT_REPOSITORY) repository: ProjectRepository,
    @Inject(CLOCK) clock: Clock,
    @Inject(IDS) ids: Ids,
    @Inject(SERIES_REPOSITORY) series: SeriesRepository,
    @Inject(EPISODE_REPOSITORY) episodes: EpisodeRepository,
    @Inject(RUN_REPOSITORY) runs: RunRepository,
    @Inject(STYLE_BIBLE_READER) styles: StyleBibleReader,
  ) {
    this.#repository = repository;
    this.#clock = clock;
    this.#create = new CreateProjectUseCase({ repository, clock, ids });
    this.#summaries = new ProjectSummaryService({
      projects: repository,
      series,
      episodes,
      runs,
      styles,
    });
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateProjectRequest)) body: CreateProjectRequest,
  ): Promise<Result<Project>> {
    return this.#create.execute(body);
  }

  /**
   * Every project, as the list screen needs them.
   *
   * An envelope rather than a bare array, and a summary rather than the aggregate: see
   * `ProjectSummary` in `projects.contracts.ts` for why the two shapes differ and why
   * the studio's copy is the definition.
   */
  @Get()
  list(): Promise<Result<ProjectList>> {
    return this.#summaries.list();
  }

  @Get(':id')
  async findOne(
    @Param('id', new ZodValidationPipe(ProjectIdParam)) id: ProjectId,
  ): Promise<Result<Project>> {
    const found = await this.#repository.findById(id);
    if (isErr(found)) return found;
    // A repository that answers `null` is reporting absence, not failing. Turning that
    // into a 404 is the controller's job, and doing it here rather than in the
    // repository keeps "not found" out of the storage port's vocabulary.
    return found.value === null ? err(new NotFoundError('project', id)) : ok(found.value);
  }

  @Patch(':id')
  update(
    @Param('id', new ZodValidationPipe(ProjectIdParam)) id: ProjectId,
    @Body(new ZodValidationPipe(UpdateProjectRequest)) body: UpdateProjectRequest,
  ): Promise<Result<Project>> {
    return this.#repository.update(id, body, toIso(this.#clock.now()));
  }
}
