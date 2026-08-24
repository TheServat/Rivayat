/**
 * The resources this API exposes that `@rv/contracts` does not yet describe.
 *
 * **Read this before adding to it.** Non-negotiable #5 puts every shape in
 * `@rv/contracts`, and anything declared here is a gap in that package rather than a
 * licence to declare shapes locally. `Project` and `SeriesCard` were two such gaps and
 * are now closed - they are re-exported below so this file stays the one import site
 * for "the resources this API exposes", and nothing has two definitions.
 *
 * One remains. `RunSummary` is a *projection* of `PipelineRun`, not a copy: it carries
 * what a client renders and omits the resume machinery, which belongs to the run and
 * not to the wire. It also carries per-stage results, which `PipelineRun` models as
 * `checkpoints` with a different shape. Its lifecycle enum is `RenderJobState`, which
 * `@rv/contracts` builds from `PIPELINE_STATUSES` - the same six states, reached
 * through the barrel instead of retyped.
 */

import {
  IsoInstant,
  Millis,
  NanoUsdAmount,
  NonEmptyString,
  NonNegativeInt,
  PipelineStageKey,
  ProjectId,
  RenderJobState,
  RunId,
  SeriesId,
  Sha256Hex,
} from '@rv/contracts';
import { z } from 'zod';

export { Project, SeriesCard } from '@rv/contracts';

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
  /**
   * Hash of everything the stage consumed. The whole of "cached".
   *
   * `StageCheckpoint.inputHash` in `@rv/contracts` says why: "already ran" is not
   * enough to skip a stage on resume, "already ran *on this*" is. Without it a resumed
   * run happily skips a stage whose inputs were edited in between, and the symptom is
   * a render of the previous cut that nobody can explain.
   *
   * `null` only for a stage that failed before it could hash its own inputs.
   */
  inputHash: Sha256Hex.nullable().default(null),
  /**
   * Milliseconds of finished video this stage put on disk.
   *
   * Here rather than derived from the artefact because only the stage knows: S10
   * encodes a frame *range*, which may be a shard rather than the whole timeline. It
   * is the denominator of "cost per delivered minute", which is the one cost question
   * that compares two episodes of different lengths.
   */
  deliveredMs: Millis.nullable().default(null),
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

/**
 * How much finished video a run actually delivered.
 *
 * The *last* stage in pipeline order that reported a duration wins, rather than the
 * sum: S10 renders a master and S11 cuts seven deliverables from the same timeline, so
 * adding them would report eight minutes for a one-minute episode and halve every
 * cost-per-minute figure in the report.
 */
export function deliveredMsOf(run: RunSummary): number | null {
  const order = run.requestedStages;
  let best: { readonly at: number; readonly ms: number } | null = null;
  for (const stage of run.stages) {
    if (stage.deliveredMs === null) continue;
    const at = order.indexOf(stage.stage);
    if (best === null || at >= best.at) best = { at, ms: stage.deliveredMs };
  }
  return best === null ? null : best.ms;
}
