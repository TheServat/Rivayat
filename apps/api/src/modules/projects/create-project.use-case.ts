/**
 * Creating a project: mint an id, stamp the clock, store it.
 *
 * Small enough to inline in the controller, and deliberately not inlined. `Ids` and
 * `Clock` are injected because non-negotiable #1 does not have a size threshold - a
 * controller that reached for `Date.now()` would be the first place determinism broke,
 * and it would break somewhere nobody looks for it.
 */

import { Ids, type IsoInstant } from '@rv/contracts';
import { type Clock, type Result, isErr, ok, toIso } from '@rv/shared-kernel';

import type { ProjectRepository } from '../../application/ports/repository.ports';
import { Project } from '../../application/resources';
import type { CreateProjectRequest } from './projects.contracts';

export interface CreateProjectDeps {
  readonly repository: ProjectRepository;
  readonly clock: Clock;
  readonly ids: Ids;
}

export class CreateProjectUseCase {
  readonly #repository: ProjectRepository;
  readonly #clock: Clock;
  readonly #ids: Ids;

  constructor(deps: CreateProjectDeps) {
    this.#repository = deps.repository;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
  }

  async execute(request: CreateProjectRequest): Promise<Result<Project>> {
    const now: IsoInstant = toIso(this.#clock.now());
    const project = Project.parse({
      id: this.#ids.project(),
      name: request.name,
      description: request.description,
      // Carried from the request rather than left to the schema's default. `locale`
      // defaults to `fa` because the studio is Persian-first, and a default silently
      // overriding what a caller sent is worse than not having one: an English project
      // created through the API came back labelled Persian, and nothing in the response
      // said the field had been ignored.
      locale: request.locale,
      styleBibleId: null,
      budgetNanoUsd: request.budgetNanoUsd,
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.#repository.create(project);
    return isErr(created) ? created : ok(created.value);
  }
}
