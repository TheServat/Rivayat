/**
 * The resources this API exposes that `@rv/contracts` does not yet describe.
 *
 * **Read this before adding to it.** Non-negotiable #5 puts every shape in
 * `@rv/contracts`, and every schema here is a gap in that package rather than a
 * licence to declare shapes locally. Three gaps, each named with what closes it:
 *
 * | schema        | why it is here                                                        |
 * |---------------|-----------------------------------------------------------------------|
 * | `Project`     | `ProjectId` is in the id registry; nothing says what a project *is*.  |
 * | `SeriesCard`  | `SeriesBible` requires a season with an episode - it cannot describe a series the moment it is created. |
 * | `RunSummary`  | `PipelineRun` exists at `contracts/src/pipeline/run.ts` and the barrel does not export it, so it cannot be imported without a deep import (a layering breach). |
 *
 * `RunSummary` is deliberately a *projection* rather than a copy: it carries what a
 * client renders and omits `checkpoints`, `requestedStages` ordering rules and the
 * resume machinery, which belong to the run and not to the wire. Its lifecycle enum is
 * `RenderJobState`, which `@rv/contracts` builds from `PIPELINE_STATUSES` - the same
 * six states, reached through the barrel instead of retyped.
 */

import {
  IsoInstant,
  Label,
  NanoUsdAmount,
  NonEmptyString,
  NonNegativeInt,
  PipelineStageKey,
  ProjectId,
  Prose,
  RenderJobState,
  RunId,
  SeriesId,
  StyleBibleId,
} from '@rv/contracts';
import { z } from 'zod';

/**
 * The lifecycle of a run, taken from the barrel rather than retyped.
 *
 * `RenderJobState` is `z.enum(PIPELINE_STATUSES)` in `contracts/src/render/render-job.ts`
 * - the file comment there says so - so this alias is the same six states the pipeline
 * state machine uses. Rename it to `PipelineStatus` the day the pipeline barrel is
 * exported; the values do not change.
 */
export const RunStatus = RenderJobState;
export type RunStatus = z.infer<typeof RunStatus>;

/** States with no outgoing edges. A run in one of these is finished, for good. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

// ── project ─────────────────────────────────────────────────────────────────

export const Project = z.strictObject({
  id: ProjectId,
  name: Label,
  description: Prose,
  /** The locked style, once there is one. `null` before S1 finishes. */
  styleBibleId: StyleBibleId.nullable().default(null),
  /** Ceiling for the whole project, in nano-dollars. `null` inherits the machine layer. */
  budgetNanoUsd: NanoUsdAmount.nullable().default(null),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});
export type Project = z.infer<typeof Project>;

// ── series ──────────────────────────────────────────────────────────────────

/**
 * A series before it has a bible.
 *
 * `SeriesBible` requires at least one season holding at least one episode, which is
 * correct for a planned series and impossible for one that was created ten seconds
 * ago. This is the row that exists in between.
 */
export const SeriesCard = z.strictObject({
  id: SeriesId,
  projectId: ProjectId,
  title: Label,
  premise: Prose,
  /** Set once S2 has produced a bible for it. */
  hasBible: z.boolean().default(false),
  createdAt: IsoInstant,
});
export type SeriesCard = z.infer<typeof SeriesCard>;

// ── run ─────────────────────────────────────────────────────────────────────

/** One finished stage, as a client sees it. */
export const RunStageResult = z.strictObject({
  stage: PipelineStageKey,
  status: RunStatus,
  costNanoUsd: NanoUsdAmount.default(0),
  durationMs: NonNegativeInt.default(0),
  /**
   * `kind:ref` pointers to what the stage produced.
   *
   * Not a `Slug`: the colon is load-bearing. `ArtifactRef` in `@rv/contracts` models
   * the same idea as a `{ kind, ref, contentHash }` object, and this is its flattened
   * wire form - a stage result is read far more often than it is written, and a list
   * of strings is what a UI renders.
   */
  artifacts: z
    .array(NonEmptyString.max(200))
    .max(4096)
    .default([])
    .describe('`kind:ref`, e.g. "story-bible:sbi_01J…" or "asset-demand-plan:12/4".'),
  errorCode: z.string().nullable().default(null),
});
export type RunStageResult = z.infer<typeof RunStageResult>;

export const RunSummary = z.strictObject({
  id: RunId,
  projectId: ProjectId,
  seriesId: SeriesId.nullable().default(null),
  status: RunStatus,
  requestedStages: z.array(PipelineStageKey).min(1),
  currentStage: PipelineStageKey.nullable().default(null),
  stages: z.array(RunStageResult).default([]),
  seed: NonNegativeInt,
  budgetNanoUsd: NanoUsdAmount.nullable().default(null),
  spentNanoUsd: NanoUsdAmount.default(0),
  errorCode: z.string().nullable().default(null),
  startedAt: IsoInstant,
  finishedAt: IsoInstant.nullable().default(null),
});
export type RunSummary = z.infer<typeof RunSummary>;
