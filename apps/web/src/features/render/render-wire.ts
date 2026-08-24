/**
 * The four wire shapes this screen reads that `@rv/contracts` does not publish.
 *
 * Non-negotiable #5 puts every shape in `@rv/contracts`, and each schema below is a
 * gap in that package rather than a licence to invent one. Every field is composed
 * from a contract primitive - `RunId`, `PipelineStageKey`, `NanoUsdAmount`,
 * `RenderJobState`, `CostSummary` - so the parts that *are* published are never
 * restated, only the envelopes around them.
 *
 * | schema       | what it mirrors                                        | why it is not upstream |
 * |--------------|--------------------------------------------------------|------------------------|
 * | `RunSummary` | `apps/api/src/application/resources.ts`                 | `PipelineRun` exists in `@rv/contracts` but is a different shape: the API sends a *projection* with per-stage results and no checkpoints. |
 * | `RunEvent`   | `apps/api/src/events/run-event.ts`                      | The SSE vocabulary is declared in the API app, with a comment saying it belongs in contracts. |
 * | `CostReport` | `apps/api/src/cost/cost-report.ts`                      | Same - the per-delivered-minute report is an API-local schema today. |
 * | `FormatProfileList` | `GET /api/render/formats`                        | Only the array wrapper is local; `FormatProfile` itself is the contract's. |
 *
 * They live in the feature rather than in `src/api/schemas/pending-contracts.ts`
 * because three other screens are being built against that file at the same time and
 * a shared file is a shared merge conflict. Fold them in when the work settles, or
 * better, delete them when the API's own module moves to `@rv/contracts`.
 *
 * `RunEvent` used to be declared here as well, because `pending-contracts.ts` held a
 * `{stage, status, fraction}` tick that no frame the server sends would satisfy. That
 * is fixed upstream now and this file re-exports it, which is the arrangement that
 * should have existed all along: one definition of a wire format, in the one adapter
 * the working agreement names.
 */

import {
  CostBucket,
  CostSummary,
  FormatProfile,
  IsoInstant,
  Millis,
  NanoUsdAmount,
  NonEmptyString,
  NonNegativeInt,
  PipelineStageKey,
  ProjectId,
  ProviderKind,
  RenderJobState,
  RunId,
  SeriesId,
  Sha256Hex,
} from '@rv/contracts';
import { z } from 'zod';

// ── formats ─────────────────────────────────────────────────────────────────

/** `GET /api/render/formats`. The array is local; every element is the contract's. */
export const FormatProfileList = z.array(FormatProfile);
export type FormatProfileList = z.infer<typeof FormatProfileList>;

// ── runs ────────────────────────────────────────────────────────────────────

/** The lifecycle a run and its stages share. Six states, from the contract. */
export const RunStatus = RenderJobState;
export type RunStatus = z.infer<typeof RunStatus>;

export const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** A run that could still do something, so the stream is worth holding open. */
export function isLiveRunStatus(status: RunStatus): boolean {
  return status === 'queued' || status === 'running';
}

export const RunStageResult = z.strictObject({
  stage: PipelineStageKey,
  status: RunStatus,
  costNanoUsd: NanoUsdAmount.default(0),
  durationMs: NonNegativeInt.default(0),
  /** `kind:ref` pointers, e.g. `render-artifact:demo/grove-16x9.mp4`. */
  artifacts: z.array(NonEmptyString.max(200)).max(4096).default([]),
  errorCode: z.string().nullable().default(null),
  /** Hash of everything the stage consumed. Present means the stage is resumable. */
  inputHash: Sha256Hex.nullable().default(null),
  /** Milliseconds of finished video this stage put on disk. The per-minute denominator. */
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

export const RunSummaryList = z.array(RunSummary);
export type RunSummaryList = z.infer<typeof RunSummaryList>;

/**
 * How much finished video a run delivered.
 *
 * The **last** stage in pipeline order that reported a duration wins, never the sum:
 * S10 renders a master and S11 cuts seven deliverables from the same timeline, so
 * adding them reports eight minutes for a one-minute episode and divides every
 * cost-per-minute figure on this screen by eight. Mirrors `deliveredMsOf` in the API.
 */
export function deliveredMsOf(run: RunSummary): number | null {
  let best: { readonly at: number; readonly ms: number } | null = null;
  for (const stage of run.stages) {
    if (stage.deliveredMs === null) continue;
    const at = run.requestedStages.indexOf(stage.stage);
    if (best === null || at >= best.at) best = { at, ms: stage.deliveredMs };
  }
  return best === null ? null : best.ms;
}

// ── the event stream ───────────────────────────────────────────

/**
 * Re-exported, not redeclared.
 *
 * `RunEvent` was defined here while `pending-contracts.ts` still held a shape that did
 * not match the server. It matches now, and two definitions of one wire format is how
 * the mismatch happened in the first place - so this screen reads the same schema every
 * other screen does, and the arrow points at the single adapter the working agreement
 * names.
 */
export { ProgressItem, RunEvent } from '../../api/schemas/pending-contracts';

// ── cost ────────────────────────────────────────────────────────────────────

export const RunCostRow = z.strictObject({
  runId: RunId,
  seriesId: SeriesId.nullable().default(null),
  status: RenderJobState,
  startedAt: IsoInstant,
  finishedAt: IsoInstant.nullable().default(null),
  deliveredMs: Millis.nullable().default(null),
  costNanoUsd: NanoUsdAmount.default(0),
  /** `null` when the run delivered nothing: that is not the same fact as "free". */
  nanoUsdPerDeliveredMinute: NanoUsdAmount.nullable().default(null),
  /**
   * Where the money went, stage by stage. The same `partialRecord` the API emits.
   *
   * Typed rather than left as an opaque bag even though this screen renders the
   * per-stage figures from the run record instead: a loose schema here would parse a
   * server that had quietly changed the shape, and validating at the boundary is only
   * worth anything if the boundary is as narrow as the thing behind it.
   */
  byStage: z.partialRecord(PipelineStageKey, CostBucket).default({}),
  byProvider: z.partialRecord(ProviderKind, CostBucket).default({}),
});
export type RunCostRow = z.infer<typeof RunCostRow>;

/**
 * `GET /api/projects/:projectId/cost`.
 *
 * `nanoUsdPerDeliveredMinute` is the field this screen exists to show. Cost per *run*
 * cannot be compared across episodes of different lengths, and "is this show
 * affordable at series length" is a question only the per-minute figure answers.
 */
export const CostReport = z.strictObject({
  projectId: ProjectId,
  seriesId: SeriesId.nullable().default(null),
  runs: z.array(RunCostRow).default([]),
  summary: CostSummary,
  deliveredMs: Millis.default(0),
  nanoUsdPerDeliveredMinute: NanoUsdAmount.nullable().default(null),
  updatedAt: IsoInstant,
});
export type CostReport = z.infer<typeof CostReport>;
