/**
 * Finding and creating the project every other command operates on.
 *
 * The rule is "never guess when it matters, always guess when it does not": an explicit
 * `--project` wins, then `$RV_PROJECT`, then - only if the workspace holds exactly one
 * project - that one. Two projects and no flag is an error rather than a coin toss,
 * because the commands that follow write files and spend money.
 */

import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type AppError,
  type Clock,
  type Result,
  err,
  isErr,
  ok,
  toIso,
} from '@rv/shared-kernel';
import type { Locale, ProjectId } from '@rv/contracts';

import { DOCUMENT_VERSION, ProjectRecord } from './documents';
import { listDirectories, readJson, writeJson } from './json-file';
import { projectPaths, workspaceProjectsDir, type ProjectPaths } from './layout';

export interface LoadedProject {
  readonly record: ProjectRecord;
  readonly paths: ProjectPaths;
}

export interface CreateProjectInput {
  readonly workspaceRoot: string;
  readonly id: ProjectId;
  readonly name: string;
  readonly description: string;
  readonly locale: Locale;
  readonly clock: Clock;
}

/**
 * Writes a new project directory.
 *
 * Refuses rather than overwrites when the directory already holds a project: a second
 * `rv project new` with the same id would silently discard a locked style bible, and
 * "no asset is generated twice" depends on that checksum surviving.
 */
export async function createProject(
  input: CreateProjectInput,
): Promise<Result<LoadedProject, AppError>> {
  const paths = projectPaths(input.workspaceRoot, input.id);
  const existing = await readJson(paths.project, ProjectRecord, 'project');
  if (existing.ok) {
    return err(
      new ConflictError({
        message: `a project already exists at ${paths.root}`,
        context: { projectId: input.id, path: paths.project },
      }),
    );
  }

  const now = toIso(input.clock.now());
  const written = await writeJson(paths.project, ProjectRecord, {
    version: DOCUMENT_VERSION,
    id: input.id,
    name: input.name,
    description: input.description,
    locale: input.locale,
    styleBibleId: null,
    budgetNanoUsd: null,
    createdAt: now,
    updatedAt: now,
  });
  if (isErr(written)) return written;
  return ok({ record: written.value, paths });
}

/** Reads one project by id. */
export async function loadProject(
  workspaceRoot: string,
  projectId: ProjectId,
): Promise<Result<LoadedProject, AppError>> {
  const paths = projectPaths(workspaceRoot, projectId);
  const record = await readJson(paths.project, ProjectRecord, 'project');
  if (isErr(record)) return record;
  return ok({ record: record.value, paths });
}

/** Every project in the workspace, oldest first - ULIDs sort by creation time. */
export async function listProjects(
  workspaceRoot: string,
): Promise<Result<readonly LoadedProject[], AppError>> {
  const names = [...(await listDirectories(workspaceProjectsDir(workspaceRoot)))].sort();
  const loaded: LoadedProject[] = [];
  for (const name of names) {
    const record = await loadProject(workspaceRoot, name);
    // A directory without a valid `project.json` is not a project. Skipping it rather
    // than failing keeps one hand-edited file from breaking `rv series cost`.
    if (record.ok) loaded.push(record.value);
  }
  return ok(loaded);
}

export interface ResolveProjectOptions {
  readonly workspaceRoot: string;
  readonly explicit: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The project a command should act on.
 *
 * Fails with a message that names the alternatives, because "ambiguous project" without
 * the list is a message that forces a `ls` before it can be acted on.
 */
export async function resolveProject(
  options: ResolveProjectOptions,
): Promise<Result<LoadedProject, AppError>> {
  const named = options.explicit ?? options.env.RV_PROJECT;
  if (named !== undefined && named !== '') {
    return loadProject(options.workspaceRoot, named);
  }

  const all = await listProjects(options.workspaceRoot);
  if (isErr(all)) return all;

  const only = all.value[0];
  if (only === undefined) {
    return err(
      new NotFoundError('project', options.workspaceRoot, {
        context: { hint: 'create one with: rv project new "<name>"' },
      }),
    );
  }
  if (all.value.length > 1) {
    return err(
      new ValidationError({
        message:
          `${String(all.value.length)} projects in the workspace; say which one with ` +
          '--project <id> or $RV_PROJECT',
        context: { projects: all.value.map((project) => project.record.id) },
      }),
    );
  }
  return ok(only);
}

/** Rewrites the project record, stamping `updatedAt`. */
export async function saveProject(
  project: LoadedProject,
  changes: Partial<Omit<ProjectRecord, 'id' | 'version' | 'createdAt'>>,
  clock: Clock,
): Promise<Result<ProjectRecord, AppError>> {
  return writeJson(project.paths.project, ProjectRecord, {
    ...project.record,
    ...changes,
    updatedAt: toIso(clock.now()),
  });
}
