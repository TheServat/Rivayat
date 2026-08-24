/**
 * Projects and series, on disk, because they have no table.
 *
 * **This is a stopgap with a date on it, not a design.** `@rv/persistence` has no
 * `projects` and no `series` table - `runs.project_id` is a bare column with no
 * referent - and `apps/api` may not add a migration to a package another workstream
 * owns. In-memory adapters were the honest placeholder while nothing had been created;
 * they stopped being honest the moment there was a demo to seed, because a seeder that
 * runs in one process cannot populate a `Map` living in another, and a list that empties
 * itself on every restart is indistinguishable from a list that never worked.
 *
 * So: the same adapters, wrapped, with the whole collection flushed to one JSON file
 * under the workspace directory after every successful write. Two properties make that
 * defensible rather than merely expedient.
 *
 * **It is a decorator, not a second implementation.** Every rule about conflicting ids,
 * patch merging and `updatedAt` still lives in exactly one place - the in-memory
 * adapter - and this adds durability and nothing else. When the migration lands, this
 * file and its binding are deleted together and no rule moves.
 *
 * **The write is atomic.** A temp file and a rename, because the alternative is a
 * truncated JSON document as the only copy of a user's projects, produced by a `ctrl-c`
 * at the wrong moment. A rename within a directory is atomic on both filesystems this
 * runs on.
 *
 * A file that cannot be parsed is **reported and then ignored**, not fatal. The same
 * reasoning as a settings layer that no longer validates: refusing to start leaves the
 * operator with no application in which to fix the thing that is broken.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { IsoInstant, ProjectId, SeriesId } from '@rv/contracts';
import { isErr, type Logger, type Result } from '@rv/shared-kernel';
import { z } from 'zod';

import type {
  ProjectPatch,
  ProjectRepository,
  SeriesPatch,
  SeriesRepository,
} from '../../application/ports/repository.ports';
import { Project, SeriesCard } from '../../application/resources';

import { InMemoryProjectRepository, InMemorySeriesRepository } from './in-memory.repositories';

export interface JsonFileStoreOptions {
  /** Absolute or process-relative workspace root. The files live directly under it. */
  readonly workspaceDir: string;
  readonly logger: Logger;
}

/**
 * Reads a collection back, dropping any record that no longer parses.
 *
 * Per-record rather than all-or-nothing: one project written by an older build must not
 * take the other five with it.
 */
function readCollection<T>(path: string, schema: z.ZodType<T>, logger: Logger): readonly T[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Absent is the normal state on a fresh checkout, not a failure.
    return [];
  }

  const parsed = z.array(z.unknown()).safeParse(safeJson(raw));
  if (!parsed.success) {
    logger.warn('stored collection is not an array; ignoring it', { path });
    return [];
  }

  const records: T[] = [];
  for (const [index, candidate] of parsed.data.entries()) {
    const record = schema.safeParse(candidate);
    if (record.success) {
      records.push(record.data);
      continue;
    }
    logger.warn('stored record no longer parses; skipping it', {
      path,
      index,
      issues: record.error.issues.map((issue) => issue.path.join('.')),
    });
  }
  return records;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Temp file, then rename. See the file header. */
function writeCollection(path: string, records: readonly unknown[], logger: Logger): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const staging = `${path}.tmp`;
    writeFileSync(staging, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    renameSync(staging, path);
  } catch (cause) {
    // Reported, not thrown: the write already succeeded in memory, so failing the
    // request now would tell the caller their change did not happen when it did.
    logger.error('could not persist a collection', { path, cause: String(cause) });
  }
}

export class JsonFileProjectRepository implements ProjectRepository {
  readonly #inner = new InMemoryProjectRepository();
  readonly #path: string;
  readonly #logger: Logger;

  constructor(options: JsonFileStoreOptions) {
    this.#path = join(options.workspaceDir, 'projects.json');
    this.#logger = options.logger.child({ component: 'projects-store' });
    for (const project of readCollection(this.#path, Project, this.#logger)) {
      // Through `create`, so the id-conflict rule applies to a file someone hand-edited
      // exactly as it applies to a request.
      void this.#inner.create(project);
    }
  }

  async create(project: Project): Promise<Result<Project>> {
    const created = await this.#inner.create(project);
    if (isErr(created)) return created;
    await this.#flush();
    return created;
  }

  findById(id: ProjectId): Promise<Result<Project | null>> {
    return this.#inner.findById(id);
  }

  list(): Promise<Result<readonly Project[]>> {
    return this.#inner.list();
  }

  async update(id: ProjectId, patch: ProjectPatch, now: IsoInstant): Promise<Result<Project>> {
    const updated = await this.#inner.update(id, patch, now);
    if (isErr(updated)) return updated;
    await this.#flush();
    return updated;
  }

  async #flush(): Promise<void> {
    const all = await this.#inner.list();
    if (isErr(all)) return;
    writeCollection(this.#path, all.value, this.#logger);
  }
}

export class JsonFileSeriesRepository implements SeriesRepository {
  readonly #inner = new InMemorySeriesRepository();
  readonly #path: string;
  readonly #logger: Logger;
  readonly #known = new Map<SeriesId, SeriesCard>();

  constructor(options: JsonFileStoreOptions) {
    this.#path = join(options.workspaceDir, 'series.json');
    this.#logger = options.logger.child({ component: 'series-store' });
    for (const card of readCollection(this.#path, SeriesCard, this.#logger)) {
      void this.#inner.create(card);
      this.#known.set(card.id, card);
    }
  }

  async create(series: SeriesCard): Promise<Result<SeriesCard>> {
    const created = await this.#inner.create(series);
    if (isErr(created)) return created;
    this.#flush(created.value);
    return created;
  }

  findById(id: SeriesId): Promise<Result<SeriesCard | null>> {
    return this.#inner.findById(id);
  }

  listByProject(projectId: ProjectId): Promise<Result<readonly SeriesCard[]>> {
    return this.#inner.listByProject(projectId);
  }

  async update(id: SeriesId, patch: SeriesPatch, now: IsoInstant): Promise<Result<SeriesCard>> {
    const updated = await this.#inner.update(id, patch, now);
    if (isErr(updated)) return updated;
    this.#flush(updated.value);
    return updated;
  }

  /**
   * Keyed by id rather than appended.
   *
   * An append-only list re-wrote the whole collection on every `create`, which was
   * correct only because nothing could change a row. An update can, and a second copy
   * of the same series in the file would be read back as a create conflict on the next
   * boot - silently dropping the edit that caused it.
   */
  #flush(card: SeriesCard): void {
    this.#known.set(card.id, card);
    writeCollection(this.#path, [...this.#known.values()], this.#logger);
  }
}

/** Everything stored, for a test that wants to assert the file rather than the port. */
export function readStoredProjects(workspaceDir: string, logger: Logger): readonly Project[] {
  return readCollection(join(workspaceDir, 'projects.json'), Project, logger);
}

/** The same, for series. */
export function readStoredSeries(workspaceDir: string, logger: Logger): readonly SeriesCard[] {
  return readCollection(join(workspaceDir, 'series.json'), SeriesCard, logger);
}
