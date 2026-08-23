import { describe, expect, it } from 'vitest';
import { type z } from 'zod';

import { toLlmJsonSchema } from '../json-schema';
import {
  CreateProjectRequest,
  Project,
  ProjectList,
  ProjectSummary,
  UpdateProjectRequest,
} from './project';
import { SeriesCard } from './series-card';

const ulid = (tail: string): string => `01J9ZQ3K5M7N9P1R3T5V7X${tail}`;

const PROJECT_ID = `prj_${ulid('0001')}`;
const STYLE_ID = `sty_${ulid('0002')}`;
const CREATED = '2026-01-01T00:00:00Z';
const UPDATED = '2026-06-01T00:00:00Z';

function failurePaths<T>(result: z.ZodSafeParseResult<T>): string[] {
  if (result.success) throw new Error('expected the parse to fail, but it succeeded');
  return result.error.issues.map((issue) => issue.path.join('.'));
}

/** Keys a `strictObject` refused. Zod reports them on the object, not per key. */
function rejectedKeys<T>(result: z.ZodSafeParseResult<T>): string[] {
  if (result.success) throw new Error('expected the parse to fail, but it succeeded');
  return result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys : [],
  );
}

/** The smallest project that parses: everything optional left out. */
function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROJECT_ID,
    name: 'The Ferryman',
    description: 'A ferryman takes a fare he should have refused.',
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: PROJECT_ID, name: 'The Ferryman', updatedAt: UPDATED, ...overrides };
}

describe('Project', () => {
  it('accepts a project that has only been named and described', () => {
    const parsed = Project.parse(project());

    expect(parsed.id).toBe(PROJECT_ID);
    expect(parsed.name).toBe('The Ferryman');
  });

  it('defaults a new project to the Persian interface the studio is built around', () => {
    // Not a cosmetic default: before `locale` existed every row in the list claimed
    // `fa` because the API had nowhere else to put an answer.
    expect(Project.parse(project()).locale).toBe('fa');
    expect(Project.parse(project({ locale: 'en' })).locale).toBe('en');
  });

  it('distinguishes "no style yet" and "no ceiling" from absent fields', () => {
    const parsed = Project.parse(project());

    // Both are states a project is genuinely in, so both are `null` rather than
    // missing: `exactOptionalPropertyTypes` makes those different, and only one of
    // them is renderable.
    expect(parsed.styleBibleId).toBeNull();
    expect(parsed.budgetNanoUsd).toBeNull();

    const configured = Project.parse(
      project({ styleBibleId: STYLE_ID, budgetNanoUsd: 5_000_000_000 }),
    );
    expect(configured.styleBibleId).toBe(STYLE_ID);
    expect(configured.budgetNanoUsd).toBe(5_000_000_000);
  });

  it('refuses a project touched before it existed', () => {
    expect(failurePaths(Project.safeParse(project({ updatedAt: '2025-01-01T00:00:00Z' })))).toEqual(
      ['updatedAt'],
    );
  });

  it('accepts a project created and touched in the same instant', () => {
    // The boundary the check guards is strictly "before", not "not after": a project
    // that has never been edited has `updatedAt === createdAt`, which is every project
    // for the first second of its life.
    expect(Project.safeParse(project({ updatedAt: CREATED })).success).toBe(true);
  });

  it('refuses an id minted for something that is not a project', () => {
    expect(failurePaths(Project.safeParse(project({ id: `ser_${ulid('0001')}` })))).toEqual(['id']);
  });

  it('refuses a field nobody declared, so a typo is a failure rather than a silent drop', () => {
    expect(rejectedKeys(Project.safeParse(project({ locale2: 'en' })))).toEqual(['locale2']);
  });

  it('refuses a negative budget, because money is unsigned everywhere', () => {
    expect(failurePaths(Project.safeParse(project({ budgetNanoUsd: -1 })))).toEqual([
      'budgetNanoUsd',
    ]);
  });

  it('loses the ordering invariant from the schema a model would be constrained by', () => {
    // Same blind spot every object-level refinement in this package has, recorded here
    // for `Project` specifically: the emitted schema accepts the inverted pair.
    const emitted = JSON.stringify(toLlmJsonSchema(Project, { dialect: 'ollama' }));

    expect(emitted).not.toContain('precede');
    expect(Project.safeParse(project({ updatedAt: '2025-01-01T00:00:00Z' })).success).toBe(false);
  });

  it('re-parses its own output to the identical value', () => {
    const once = Project.parse(project());

    expect(Project.parse(once)).toEqual(once);
  });
});

describe('ProjectSummary', () => {
  it('fills every derived count with the honest zero of a project nothing has happened to', () => {
    const parsed = ProjectSummary.parse(summary());

    expect(parsed.episodeCount).toBe(0);
    expect(parsed.spentNanoUsd).toBe(0);
    expect(parsed.styleLocked).toBe(false);
    expect(parsed.styleBibleId).toBeNull();
    expect(parsed.locale).toBe('fa');
  });

  it('omits the logline entirely rather than carrying an empty one', () => {
    // A project can exist before an idea does. Absent and "" are different claims and
    // only the first is true of a project with no description yet.
    expect('logline' in ProjectSummary.parse(summary())).toBe(false);
    expect(failurePaths(ProjectSummary.safeParse(summary({ logline: '' })))).toEqual(['logline']);
  });

  it('caps the logline at the length a list cell can hold', () => {
    expect(ProjectSummary.parse(summary({ logline: 'x'.repeat(400) })).logline).toHaveLength(400);
    expect(failurePaths(ProjectSummary.safeParse(summary({ logline: 'x'.repeat(401) })))).toEqual([
      'logline',
    ]);
  });

  it('keeps "has a style" and "can generate" as two separate answers', () => {
    // `assertUsableForGeneration` refuses an unlocked bible, so a row carrying only
    // `styleBibleId` would tell the user a project is ready when it is not.
    const chosen = ProjectSummary.parse(summary({ styleBibleId: STYLE_ID }));

    expect(chosen.styleBibleId).toBe(STYLE_ID);
    expect(chosen.styleLocked).toBe(false);
  });

  it('refuses a fractional episode count', () => {
    expect(failurePaths(ProjectSummary.safeParse(summary({ episodeCount: 1.5 })))).toEqual([
      'episodeCount',
    ]);
  });

  it('refuses a field the list screen would silently ignore', () => {
    expect(rejectedKeys(ProjectSummary.safeParse(summary({ description: 'whole brief' })))).toEqual(
      ['description'],
    );
  });
});

describe('ProjectList', () => {
  it('answers an empty workspace with an envelope rather than nothing', () => {
    // An object, not a bare array: a top-level JSON array is the one response shape
    // that cannot grow a cursor without breaking every client.
    expect(ProjectList.parse({})).toEqual({ projects: [] });
  });

  it('carries parsed rows, not the raw ones it was handed', () => {
    const parsed = ProjectList.parse({ projects: [summary()] });

    expect(parsed.projects[0]?.spentNanoUsd).toBe(0);
  });

  it('rejects the whole list when one row is malformed', () => {
    expect(
      failurePaths(ProjectList.safeParse({ projects: [summary(), summary({ id: 'nope' })] })),
    ).toEqual(['projects.1.id']);
  });
});

describe('SeriesCard', () => {
  const card = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: `ser_${ulid('0003')}`,
    projectId: PROJECT_ID,
    title: 'The Crossing',
    premise: 'A ferryman owes a debt he cannot name.',
    createdAt: CREATED,
    ...overrides,
  });

  it('describes a series that has a title and nothing else yet', () => {
    // The state `SeriesBible` cannot describe: no season, no episode, and therefore no
    // plan - which is every series for its whole first session.
    expect(SeriesCard.parse(card()).hasBible).toBe(false);
  });

  it('records that a plan exists without carrying it', () => {
    expect(SeriesCard.parse(card({ hasBible: true })).hasBible).toBe(true);
  });

  it('refuses a series that belongs to no project', () => {
    expect(failurePaths(SeriesCard.safeParse(card({ projectId: `ser_${ulid('0003')}` })))).toEqual([
      'projectId',
    ]);
  });

  it('refuses an empty premise, because a series with no premise is a title', () => {
    expect(failurePaths(SeriesCard.safeParse(card({ premise: '   ' })))).toEqual(['premise']);
  });
});

describe('the write DTOs', () => {
  it('takes the two things only the author can supply and defaults the rest', () => {
    expect(CreateProjectRequest.parse({ name: 'The Ferryman', description: 'A brief.' })).toEqual({
      name: 'The Ferryman',
      description: 'A brief.',
      locale: 'fa',
      budgetNanoUsd: null,
    });
  });

  it('refuses a client-chosen id or timestamp on create', () => {
    // A client that could choose an id could collide with an existing project or forge
    // a reference; one that could choose `createdAt` could reorder the list screen.
    expect(
      rejectedKeys(
        CreateProjectRequest.safeParse({
          name: 'x',
          description: 'y',
          id: PROJECT_ID,
          createdAt: CREATED,
        }),
      ).sort(),
    ).toEqual(['createdAt', 'id']);
  });

  it('leaves an empty patch empty, rather than filling it with defaults nobody sent', () => {
    // The defect this schema exists to avoid: `.pick().partial()` keeps the defaults,
    // so `{}` parses to `{styleBibleId: null, budgetNanoUsd: null}` and a repository
    // that spreads the patch un-sets the project's style and its budget.
    expect(UpdateProjectRequest.parse({})).toEqual({});
  });

  it('distinguishes clearing a field from not mentioning it', () => {
    expect(UpdateProjectRequest.parse({ styleBibleId: null })).toEqual({ styleBibleId: null });
    expect(UpdateProjectRequest.parse({ styleBibleId: STYLE_ID })).toEqual({
      styleBibleId: STYLE_ID,
    });
  });

  it('covers exactly the fields a client owns, and no others', () => {
    // The assertion `.pick()` would have given for free. A field added to the project
    // must be a deliberate decision about whether a client may write it.
    const aggregate = Object.keys(Project.def.shape);
    const notWritable = ['id', 'createdAt', 'updatedAt'];

    expect(Object.keys(UpdateProjectRequest.shape).sort()).toEqual(
      aggregate.filter((key) => !notWritable.includes(key)).sort(),
    );
  });

  it('still validates each field the way the aggregate does', () => {
    expect(UpdateProjectRequest.safeParse({ name: '' }).success).toBe(false);
    expect(UpdateProjectRequest.safeParse({ budgetNanoUsd: -1 }).success).toBe(false);
    expect(UpdateProjectRequest.safeParse({ locale: 'de' }).success).toBe(false);
    expect(rejectedKeys(UpdateProjectRequest.safeParse({ createdAt: CREATED }))).toEqual([
      'createdAt',
    ]);
  });
});
