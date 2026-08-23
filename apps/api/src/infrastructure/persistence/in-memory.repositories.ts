/**
 * Project and series storage, in memory, until they have tables.
 *
 * **This is a gap, not a design.** `@rv/persistence` has no `projects` and no `series`
 * table - `runs.project_id` is a bare column with no referent, and `episodes.series_id`
 * likewise - and `apps/api` may not add migrations to a package another workstream
 * owns. So the ports are real, the adapters behind them are not durable, and the swap
 * is one line in `app.module.ts` once the migration lands.
 *
 * Settings are no longer among them: they have a real `settings` table and a real
 * `DrizzleSettingsRepository` behind the `SettingsRepository` port `@rv/settings`
 * declares.
 *
 * They are written as if they were durable - `Result`-returning, id-conflict aware,
 * clock-injected - so the swap is a swap and not a rewrite of every caller.
 */

import type { IsoInstant, ProjectId, SeriesId } from '@rv/contracts';
import { ConflictError, NotFoundError, type Result, err, ok } from '@rv/shared-kernel';

import type {
  ProjectPatch,
  ProjectRepository,
  SeriesRepository,
} from '../../application/ports/repository.ports';
import type { Project, SeriesCard } from '../../application/resources';

export class InMemoryProjectRepository implements ProjectRepository {
  readonly #byId = new Map<ProjectId, Project>();

  create(project: Project): Promise<Result<Project>> {
    if (this.#byId.has(project.id)) {
      return Promise.resolve(
        err(
          new ConflictError({
            message: `Project ${project.id} already exists`,
            context: { projectId: project.id },
          }),
        ),
      );
    }
    this.#byId.set(project.id, project);
    return Promise.resolve(ok(project));
  }

  findById(id: ProjectId): Promise<Result<Project | null>> {
    return Promise.resolve(ok(this.#byId.get(id) ?? null));
  }

  list(): Promise<Result<readonly Project[]>> {
    return Promise.resolve(ok([...this.#byId.values()]));
  }

  update(id: ProjectId, patch: ProjectPatch, now: IsoInstant): Promise<Result<Project>> {
    const current = this.#byId.get(id);
    if (current === undefined) return Promise.resolve(err(new NotFoundError('project', id)));

    // An absent key and a key set to `undefined` mean the same thing here - "do not
    // change it" - so the undefined entries are dropped before the spread. Spreading
    // them would blank a field the client did not mention.
    // Narrowed to `Partial<Project>` because the filter above has removed every
    // `undefined`, which is exactly the difference between the two types.
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<Project>;

    // `id` and `createdAt` are re-applied after the patch: a patch that could change
    // either would let a client move a project's identity, and every reference to it
    // would silently point at nothing.
    const next: Project = {
      ...current,
      ...changes,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now,
    };
    this.#byId.set(id, next);
    return Promise.resolve(ok(next));
  }
}

export class InMemorySeriesRepository implements SeriesRepository {
  readonly #byId = new Map<SeriesId, SeriesCard>();

  create(series: SeriesCard): Promise<Result<SeriesCard>> {
    if (this.#byId.has(series.id)) {
      return Promise.resolve(
        err(
          new ConflictError({
            message: `Series ${series.id} already exists`,
            context: { seriesId: series.id },
          }),
        ),
      );
    }
    this.#byId.set(series.id, series);
    return Promise.resolve(ok(series));
  }

  findById(id: SeriesId): Promise<Result<SeriesCard | null>> {
    return Promise.resolve(ok(this.#byId.get(id) ?? null));
  }

  listByProject(projectId: ProjectId): Promise<Result<readonly SeriesCard[]>> {
    return Promise.resolve(
      ok([...this.#byId.values()].filter((series) => series.projectId === projectId)),
    );
  }
}
