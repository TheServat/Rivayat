/**
 * What a client watching a run is told, and when.
 *
 * A pipeline run is eleven stages of work that can take minutes. Polling can answer
 * "is it done", which is the one question nobody is asking at minute four - the
 * questions are which stage is running, how far into it, and how much it has cost so
 * far. Those are events, so this is the event vocabulary.
 *
 * The six kinds are RV-183's, and the union is discriminated on `type` so a client
 * `switch` stays exhaustive. `seq` is per-run and monotonic: it is what `Last-Event-ID`
 * carries on a reconnect, and without it a dropped connection silently loses whichever
 * events landed while it was down.
 *
 * These schemas live here rather than in `@rv/contracts` because the pipeline module of
 * that package is not exported from its barrel (see `application/resources.ts`). They
 * belong there.
 */

import {
  IsoInstant,
  Label,
  NanoUsdAmount,
  NonEmptyString,
  NonNegativeInt,
  PipelineStageKey,
  Prose,
  RunId,
  Unit01,
} from '@rv/contracts';
import { z } from 'zod';

/**
 * The unit of work a stage is on right now, structured.
 *
 * `detail` next to it is prose for a human; this is for the UI. "The current asset
 * within the produce stage" is a list row that has to be found, highlighted and shown
 * with a counter - none of which a client can do by parsing a sentence, and all of
 * which break the moment the sentence is translated. S6 sets `kind: 'asset'` with the
 * semantic key; S10 sets `kind: 'frame'` with the frame index. Both are "which one of
 * the N things is happening", which is the only question a progress list asks.
 */
export const ProgressItem = z.strictObject({
  kind: Label.describe('What sort of unit: "asset", "frame", "shot", "format".'),
  key: NonEmptyString.max(200).describe(
    'Identity of the unit, stable across a resume - a semantic key, a frame index, a format id.',
  ),
  /** 0-based position in the batch. `null` when the stage cannot order its work. */
  index: NonNegativeInt.nullable().default(null),
  /** Units in the batch. `null` when the stage does not know until it finishes. */
  total: NonNegativeInt.nullable().default(null),
});
export type ProgressItem = z.infer<typeof ProgressItem>;

const base = {
  runId: RunId,
  /** Per-run, monotonic, gap-free. The `Last-Event-ID` a client reconnects with. */
  seq: NonNegativeInt,
  at: IsoInstant,
};

export const StageStartedEvent = z.strictObject({
  ...base,
  type: z.literal('stage-started'),
  stage: PipelineStageKey,
});

export const StageProgressEvent = z.strictObject({
  ...base,
  type: z.literal('stage-progress'),
  stage: PipelineStageKey,
  /** 0..1. A stage that cannot estimate reports 0 rather than lying about a fraction. */
  progress: Unit01,
  detail: Prose.nullable().default(null),
  /** Which unit of work is in flight. `null` for a stage whose work is not a batch. */
  item: ProgressItem.nullable().default(null),
});

export const StageCompletedEvent = z.strictObject({
  ...base,
  type: z.literal('stage-completed'),
  stage: PipelineStageKey,
  durationMs: NonNegativeInt,
  costNanoUsd: NanoUsdAmount.default(0),
});

/**
 * Emitted as spend accrues, not at the end.
 *
 * The whole reason cost is on the stream is that "you have spent $3.40 of your $5"
 * arriving at minute four is actionable and the same sentence arriving at the end is a
 * receipt.
 */
export const CostUpdatedEvent = z.strictObject({
  ...base,
  type: z.literal('cost-updated'),
  stage: PipelineStageKey.nullable().default(null),
  deltaNanoUsd: NanoUsdAmount,
  totalNanoUsd: NanoUsdAmount,
  /** Headroom at the tightest ceiling, or `null` when the run is uncapped. */
  remainingNanoUsd: NanoUsdAmount.nullable().default(null),
});

export const IssueRaisedEvent = z.strictObject({
  ...base,
  type: z.literal('issue-raised'),
  stage: PipelineStageKey.nullable().default(null),
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string(),
  message: Prose,
});

/** The last event on the stream. The connection closes immediately after it. */
export const RunCompletedEvent = z.strictObject({
  ...base,
  type: z.literal('run-completed'),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  totalNanoUsd: NanoUsdAmount.default(0),
  /** `AppError.kind` when it failed. `null` otherwise - a client branches on this. */
  errorKind: z.string().nullable().default(null),
  errorCode: z.string().nullable().default(null),
});

export const RunEvent = z.discriminatedUnion('type', [
  StageStartedEvent,
  StageProgressEvent,
  StageCompletedEvent,
  CostUpdatedEvent,
  IssueRaisedEvent,
  RunCompletedEvent,
]);
export type RunEvent = z.infer<typeof RunEvent>;

/**
 * Everything except the two fields the bus assigns. What a publisher actually writes.
 *
 * Distributive on purpose: a plain `Omit` over a union collapses to the keys the
 * members share, which would let a `stage-started` draft carry a `severity`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RunEventDraft = DistributiveOmit<RunEvent, 'seq' | 'at'>;

export function isTerminalEvent(event: RunEvent): boolean {
  return event.type === 'run-completed';
}
