/**
 * Shapes the studio needs that `@rv/contracts` does not export yet.
 *
 * **This is the one file to re-point.** Everything here is written to the shape
 * documented in `docs/01-architecture.md` §7b (the setting registry) and §4 (the
 * pipeline), and every one of them belongs upstream in `@rv/contracts`. When they land,
 * this file becomes a re-export and nothing else in `apps/web` changes: no component,
 * store or client imports a shape from anywhere but here.
 *
 * What is missing upstream today, and why the studio cannot simply wait:
 *
 * | shape               | why the studio needs it | where it belongs                                                                |
 * |---------------------|-------------------------|---------------------------------------------------------------------------------|
 * | `ProjectSummary`    | the projects list       | `@rv/contracts` - there is a `ProjectId` and no `Project`                       |
 * | `RunProgressEvent`  | SSE run progress        | `@rv/contracts` - `src/pipeline/` exists but is not exported from `src/index.ts` |
 *
 * The settings row of that table is **done**. `@rv/contracts` now exports the whole
 * registry - `SETTINGS_REGISTRY`, `SettingDescriptorMeta`, `SettingControl`,
 * `SettingScope`, `SettingOrigin` and the rules that follow from a descriptor - so the
 * settings shapes that used to be guessed here have moved to
 * `./settings.ts`, which composes the real ones into the wire envelope. They are
 * deliberately **not** re-exported from here: an importer that still reaches for
 * `SettingDescriptor` should fail to compile and be re-pointed, rather than silently
 * keep the old shape alive behind an alias.
 *
 * Note what is *not* here: `Locale`, `Label`, `PipelineStageKey`, `NanoUsdAmount`,
 * `ProjectId`, `RunId`, `JobId`, `IsoInstant`, `StyleBibleId` and `RenderJobState` all
 * come from `@rv/contracts` and are composed here rather than restated. A shape that
 * exists upstream is never redeclared, even in this file.
 */

import {
  IsoInstant,
  JobId,
  Label,
  Locale,
  NanoUsdAmount,
  NonEmptyString,
  PipelineStageKey,
  ProjectId,
  RenderJobState,
  RunId,
  StyleBibleId,
  Unit01,
} from '@rv/contracts';
import { z } from 'zod';

// ── projects ────────────────────────────────────────────────────────────────

/**
 * A project as the list screen needs it.
 *
 * `@rv/contracts` has a `ProjectId` and no `Project`: every schema that references a
 * project references the id. This is the smallest honest summary - enough to list,
 * sort and open one - and it is deliberately not a full aggregate, because inventing
 * one here would be exactly the redeclaration the working agreement forbids.
 */
export const ProjectSummary = z.strictObject({
  id: ProjectId,
  name: Label,
  /** Author's own one-line description. Optional: a project can exist before an idea does. */
  logline: NonEmptyString.max(400).optional(),
  locale: Locale.default('fa'),
  styleBibleId: StyleBibleId.nullable().default(null),
  styleLocked: z.boolean().default(false),
  episodeCount: z.number().int().nonnegative().default(0),
  spentNanoUsd: NanoUsdAmount.default(0),
  updatedAt: IsoInstant,
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ProjectList = z.strictObject({
  projects: z.array(ProjectSummary).default([]),
});
export type ProjectList = z.infer<typeof ProjectList>;

// ── run progress over SSE (architecture §4) ─────────────────────────────────

/**
 * One progress tick for a pipeline run.
 *
 * Composed from the exported halves rather than invented: the stage list is
 * `PipelineStageKey`, and the lifecycle is `RenderJobState`, which
 * `contracts/src/render/render-job.ts` documents as *being* the shared
 * `PIPELINE_STATUSES` list rather than a narrowing of it. The pipeline's own
 * `PipelineStatus` would be the better name and it is not reachable:
 * `contracts/src/pipeline/index.ts` exists but `contracts/src/index.ts` does not
 * re-export it.
 */
export const RunProgressEvent = z.strictObject({
  runId: RunId,
  stage: PipelineStageKey,
  status: RenderJobState,
  /** Completion across the whole run, not the current stage. */
  fraction: Unit01,
  jobId: JobId.nullable().default(null),
  spentNanoUsd: NanoUsdAmount.default(0),
  message: Label.optional(),
  at: IsoInstant,
});
export type RunProgressEvent = z.infer<typeof RunProgressEvent>;

/** The named SSE events a run stream emits. */
export const RUN_STREAM_EVENTS = ['progress', 'stage', 'done', 'error'] as const;
export const RunStreamEventName = z.enum(RUN_STREAM_EVENTS);
export type RunStreamEventName = z.infer<typeof RunStreamEventName>;
