/**
 * Storage ports this app declares, because `@rv/persistence` does not yet cover them.
 *
 * `AssetRepository` and `BlobStore` are declared by `@rv/asset-registry` and adapted in
 * `@rv/persistence`; these four are the same pattern one layer out. Architecture §1
 * allows exactly this - "adapted in `packages/providers` **or**
 * `apps/api/src/infrastructure`" - and the adapters live there.
 *
 * The point of the ports is not abstraction for its own sake. `ProjectRepository` and
 * `SeriesRepository` have no table behind them today (see `resources.ts`), so they run
 * on an in-memory adapter while `EpisodeRepository` and `RunRepository` run on real
 * Drizzle tables. Nothing above the port can tell, which is what makes the swap a
 * one-line change in the composition root when the migration lands.
 */

import type {
  EpisodeId,
  EpisodeOutline,
  IsoInstant,
  ProjectId,
  RunId,
  SeriesId,
  StyleBibleId,
  UsageRecord,
} from '@rv/contracts';
import type { Result, Unit } from '@rv/shared-kernel';

import type { Project, RunStageResult, RunSummary, RunStatus, SeriesCard } from '../resources';

/**
 * A patch, spelled out rather than `Partial<Project>`.
 *
 * `exactOptionalPropertyTypes` makes `{ name?: string }` and `{ name?: string |
 * undefined }` different types, and a JSON body parsed by Zod produces the second: an
 * omitted optional field is genuinely `undefined`. `Partial<T>` produces the first, so
 * passing a parsed body to it is a compile error - correctly, and unhelpfully.
 */
export type ProjectPatch = { [K in keyof Project]?: Project[K] | undefined };

export interface ProjectRepository {
  create(project: Project): Promise<Result<Project>>;
  findById(id: ProjectId): Promise<Result<Project | null>>;
  list(): Promise<Result<readonly Project[]>>;
  update(id: ProjectId, patch: ProjectPatch, now: IsoInstant): Promise<Result<Project>>;
}

export interface SeriesRepository {
  create(series: SeriesCard): Promise<Result<SeriesCard>>;
  findById(id: SeriesId): Promise<Result<SeriesCard | null>>;
  listByProject(projectId: ProjectId): Promise<Result<readonly SeriesCard[]>>;
}

export interface EpisodeRepository {
  findById(id: EpisodeId): Promise<Result<EpisodeOutline | null>>;
  listBySeries(seriesId: SeriesId): Promise<Result<readonly EpisodeOutline[]>>;
}

/**
 * The run's durable state.
 *
 * `recordStage` and `finish` are separate from `update` because they are the two
 * writes that must survive a crash between them: a stage checkpoint written without
 * the run being marked finished is recoverable (the resumed run skips the stage), and
 * the reverse is not.
 */
export interface RunRepository {
  create(run: RunSummary): Promise<Result<RunSummary>>;
  findById(id: RunId): Promise<Result<RunSummary | null>>;
  listByProject(projectId: ProjectId): Promise<Result<readonly RunSummary[]>>;
  setStatus(
    id: RunId,
    status: RunStatus,
    at: IsoInstant,
    errorCode?: string | null,
  ): Promise<Result<RunSummary>>;
  setCurrentStage(id: RunId, stage: RunSummary['currentStage']): Promise<Result<Unit>>;
  recordStage(id: RunId, result: RunStageResult): Promise<Result<Unit>>;
  /** Appends to the per-run ledger and bumps the denormalised `spentNanoUsd`. */
  appendUsage(record: UsageRecord): Promise<Result<Unit>>;
  usage(id: RunId): Promise<Result<readonly UsageRecord[]>>;
}

/**
 * The one question the projects list asks of a style bible.
 *
 * A whole `StyleBibleRepository` would be the obvious thing and the wrong one: nothing
 * in this app reads, writes or forks a bible yet, and a port with five methods and one
 * caller invites an adapter that implements four of them badly. `styleLocked` is the
 * only fact a list row needs, and "generation is refused against an unlocked style" is
 * why it needs it - a project with a chosen-but-unlocked bible cannot produce anything,
 * and a list that showed only "has a style" would say it can.
 */
export interface StyleBibleReader {
  /** `false` for a bible that is not locked, and for one that does not exist. */
  isLocked(id: StyleBibleId): Promise<Result<boolean>>;
}
