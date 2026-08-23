/**
 * The projects list, assembled from the four places its facts actually live.
 *
 * A list row is not a projection of one row. `name` and `styleBibleId` come from the
 * project, `styleLocked` from the style bible, `episodeCount` from the episodes of the
 * project's series, and `spentNanoUsd` from the run ledger. Answering it by widening the
 * `Project` aggregate would mean four denormalised columns kept in step by hand, and the
 * first one to go stale would be the spend - which is the one a user checks.
 *
 * So this is a read model: one class, four ports, and a `strictObject` at the end that
 * refuses to emit a row it could not fill.
 */

import { Injectable } from '@nestjs/common';
import type { Locale, ProjectId } from '@rv/contracts';
import { isErr, ok, type Result } from '@rv/shared-kernel';

import type {
  EpisodeRepository,
  ProjectRepository,
  RunRepository,
  SeriesRepository,
  StyleBibleReader,
} from '../../application/ports/repository.ports';
import type { Project } from '../../application/resources';

import { ProjectSummary, type ProjectList } from './projects.contracts';

export interface ProjectSummaryDeps {
  readonly projects: ProjectRepository;
  readonly series: SeriesRepository;
  readonly episodes: EpisodeRepository;
  readonly runs: RunRepository;
  readonly styles: StyleBibleReader;
}

/**
 * The interface language, until a project can choose one.
 *
 * **Report:** `Project` has no `locale`, so every row claims the studio default. That is
 * honest today - nothing in the pipeline reads a per-project locale - and it is a real
 * gap the moment a Persian series and an English one share an installation. It belongs
 * on `Project` in `@rv/contracts`, alongside the `Project` schema that does not exist
 * yet.
 */
const ASSUMED_LOCALE: Locale = 'fa';

@Injectable()
export class ProjectSummaryService {
  readonly #deps: ProjectSummaryDeps;

  constructor(deps: ProjectSummaryDeps) {
    this.#deps = deps;
  }

  async list(): Promise<Result<ProjectList>> {
    const projects = await this.#deps.projects.list();
    if (isErr(projects)) return projects;

    const summaries: ProjectSummary[] = [];
    for (const project of projects.value) {
      const summary = await this.#summarise(project);
      if (isErr(summary)) return summary;
      summaries.push(summary.value);
    }
    return ok({ projects: summaries });
  }

  async #summarise(project: Project): Promise<Result<ProjectSummary>> {
    const episodeCount = await this.#episodeCount(project.id);
    if (isErr(episodeCount)) return episodeCount;

    const spent = await this.#spent(project.id);
    if (isErr(spent)) return spent;

    const locked =
      project.styleBibleId === null
        ? ok(false)
        : await this.#deps.styles.isLocked(project.styleBibleId);
    if (isErr(locked)) return locked;

    // Parsed, not assembled: `strictObject` is what stops this read model from drifting
    // from the studio's copy of it, and a row that cannot be parsed is a bug worth a 500
    // rather than a half-rendered card.
    return ok(
      ProjectSummary.parse({
        id: project.id,
        name: project.name,
        // `description` is `Prose` and therefore never empty, but it is the whole brief
        // rather than a logline; the list shows the first 400 characters of it and the
        // detail screen shows the rest.
        logline: project.description.slice(0, 400),
        locale: ASSUMED_LOCALE,
        styleBibleId: project.styleBibleId,
        styleLocked: locked.value,
        episodeCount: episodeCount.value,
        spentNanoUsd: spent.value,
        updatedAt: project.updatedAt,
      }),
    );
  }

  async #episodeCount(projectId: ProjectId): Promise<Result<number>> {
    const series = await this.#deps.series.listByProject(projectId);
    if (isErr(series)) return series;

    let count = 0;
    for (const card of series.value) {
      const episodes = await this.#deps.episodes.listBySeries(card.id);
      if (isErr(episodes)) return episodes;
      count += episodes.value.length;
    }
    return ok(count);
  }

  /**
   * What this project has cost so far.
   *
   * Summed from the runs rather than read off the project, because a denormalised total
   * on the project row is a number that can disagree with the ledger, and the ledger is
   * the thing an invoice is checked against (non-negotiable 3).
   */
  async #spent(projectId: ProjectId): Promise<Result<number>> {
    const runs = await this.#deps.runs.listByProject(projectId);
    if (isErr(runs)) return runs;
    return ok(runs.value.reduce((total, run) => total + run.spentNanoUsd, 0));
  }
}
