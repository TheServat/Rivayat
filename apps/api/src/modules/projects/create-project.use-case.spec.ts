/**
 * A field the client sent must survive to the row.
 *
 * This file exists because one did not. `CreateProjectRequest` accepts `locale`, the
 * schema declares it, and the use case never copied it - so `Project.parse` filled in its
 * own default and an English project created through the API came back labelled Persian.
 * Nothing in the response said a field had been ignored, which is what makes this class of
 * bug survive: the request succeeded, the row was written, and the only evidence was a
 * value nobody had asked for.
 *
 * So the assertion below is deliberately about *every* author-supplied field rather than
 * about `locale` alone. Testing the field that broke would catch this bug and none of its
 * siblings.
 */

import { describe, expect, it } from 'vitest';
import { CreateProjectRequest, type Project, type ProjectId } from '@rv/contracts';
import { FixedClock, instant, ok, type Result } from '@rv/shared-kernel';

import { CreateProjectUseCase } from './create-project.use-case';
import type { ProjectRepository } from '../../application/ports/repository.ports';

function repository(): ProjectRepository & { readonly written: Project[] } {
  const written: Project[] = [];
  return {
    written,
    create: (project: Project): Promise<Result<Project>> => {
      written.push(project);
      return Promise.resolve(ok(project));
    },
  } as unknown as ProjectRepository & { readonly written: Project[] };
}

function ids() {
  let n = 0;
  return {
    project: (): ProjectId => `prj_${String(++n).padStart(26, '0')}`,
  };
}

describe('creating a project', () => {
  it('carries every field the author supplied, not just the ones with no default', async () => {
    const repo = repository();
    const useCase = new CreateProjectUseCase({
      repository: repo,
      clock: new FixedClock(instant(1_700_000_000_000)),
      ids: ids() as never,
    });

    const request = CreateProjectRequest.parse({
      name: "The Lamplighter's Debt",
      description: 'A lamplighter keeps one lamp burning that the guild ordered dark.',
      locale: 'en',
      budgetNanoUsd: 5_000_000_000,
    });

    const created = await useCase.execute(request);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // `locale` is the one that broke, and it broke *because* it has a default: the schema
    // filled `fa` in over the caller's `en` and the write looked successful.
    expect(created.value.locale).toBe('en');
    expect(created.value.name).toBe("The Lamplighter's Debt");
    expect(created.value.description).toContain('guild ordered dark');
    expect(created.value.budgetNanoUsd).toBe(5_000_000_000);

    // What was persisted, not just what was returned. A use case that answered correctly
    // and stored something else would satisfy every assertion above.
    expect(repo.written).toHaveLength(1);
    expect(repo.written[0]?.locale).toBe('en');
  });

  it('mints the fields a client must not choose', async () => {
    const repo = repository();
    const useCase = new CreateProjectUseCase({
      repository: repo,
      clock: new FixedClock(instant(1_700_000_000_000)),
      ids: ids() as never,
    });

    const created = await useCase.execute(
      CreateProjectRequest.parse({ name: 'Second', description: 'x', locale: 'fa' }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // A client that could choose an id could collide or forge a reference; one that could
    // choose `createdAt` could write itself to the top of a list sorted on it.
    expect(created.value.id).toMatch(/^prj_/u);
    expect(created.value.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(created.value.updatedAt).toBe(created.value.createdAt);
    expect(created.value.styleBibleId).toBeNull();
  });
});
