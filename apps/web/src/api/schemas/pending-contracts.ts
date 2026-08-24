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
 * | `RunEvent`          | SSE run events          | `@rv/contracts` - `src/pipeline/` exists but is not exported from `src/index.ts` |
 *
 * `ProjectSummary` used to be on that list and is not any more: `@rv/contracts` now
 * exports `Project`, `ProjectSummary` and `ProjectList`, so this file re-exports them
 * and holds no copy.
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
 * `ProjectId`, `RunId`, `Prose`, `Unit01` and `IsoInstant` all come from
 * `@rv/contracts` and are composed here rather than restated. A shape that exists
 * upstream is never redeclared, even in this file.
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

// ── projects ────────────────────────────────────────────────────────────────────

/**
 * **Landed upstream.** `Project`, `ProjectSummary` and `ProjectList` now live in
 * `@rv/contracts/src/project/project.ts`, which is what the header of this file
 * promised would happen, so the copy that used to sit here is gone rather than
 * deprecated.
 *
 * They are re-exported rather than imported directly by their callers so that the
 * re-point was one edit in one file - which was the whole design of this module - and
 * so the next shape to land upstream follows the same path. A caller that reaches
 * straight for `@rv/contracts` is not wrong; a caller that keeps a third copy is.
 */
export { ProjectList, ProjectSummary } from '@rv/contracts';

// ── run events over SSE (architecture §4) ────────────────────────────

/**
 * Which unit of work a stage is on, structured.
 *
 * `detail` beside it is prose for a human; this is for the interface. "Asset 14 of 96"
 * is a counter a progress list renders as a ratio, and a sentence would have to be
 * parsed to do that - and would be the wrong language half the time.
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

const runEventBase = {
  runId: RunId,
  /** Per-run, monotonic, gap-free. The SSE id, and the `Last-Event-ID` on a reconnect. */
  seq: NonNegativeInt,
  at: IsoInstant,
};

/**
 * What a run tells a client while it is happening.
 *
 * **This replaced a schema that did not match the server**, and the mismatch is worth
 * recording because nothing in the toolchain caught it. The previous shape here was a
 * flat `{stage, status, fraction}` tick, invented from the architecture document. The
 * running API emits a union discriminated on `type` - captured live from a real run:
 *
 * ```
 * event: stage-started
 * data: {"type":"stage-started","runId":"run_01M0…","stage":"render","seq":1,…}
 * event: run-completed
 * data: {"type":"run-completed","status":"failed","errorKind":"validation",…}
 * ```
 *
 * Every frame the server sends would have failed the old schema, so a client using it
 * showed a run frozen for ever while reporting a healthy connection. Mirrors
 * `apps/api/src/events/run-event.ts`, whose own comment says these belong in
 * `@rv/contracts` - the pipeline module exists there but is not exported from the
 * barrel.
 *
 * Six members, discriminated so a client `switch` stays exhaustive.
 */
export const RunEvent = z.discriminatedUnion('type', [
  z.strictObject({ ...runEventBase, type: z.literal('stage-started'), stage: PipelineStageKey }),
  z.strictObject({
    ...runEventBase,
    type: z.literal('stage-progress'),
    stage: PipelineStageKey,
    /** 0..1 within this stage. A stage that cannot estimate reports 0 rather than lying. */
    progress: Unit01,
    detail: Prose.nullable().default(null),
    item: ProgressItem.nullable().default(null),
  }),
  z.strictObject({
    ...runEventBase,
    type: z.literal('stage-completed'),
    stage: PipelineStageKey,
    durationMs: NonNegativeInt,
    costNanoUsd: NanoUsdAmount.default(0),
  }),
  z.strictObject({
    ...runEventBase,
    type: z.literal('cost-updated'),
    stage: PipelineStageKey.nullable().default(null),
    deltaNanoUsd: NanoUsdAmount,
    totalNanoUsd: NanoUsdAmount,
    /** Headroom at the tightest ceiling, or `null` when the run is uncapped. */
    remainingNanoUsd: NanoUsdAmount.nullable().default(null),
  }),
  z.strictObject({
    ...runEventBase,
    type: z.literal('issue-raised'),
    stage: PipelineStageKey.nullable().default(null),
    severity: z.enum(['info', 'warning', 'error']),
    code: z.string(),
    message: Prose,
  }),
  z.strictObject({
    ...runEventBase,
    type: z.literal('run-completed'),
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    totalNanoUsd: NanoUsdAmount.default(0),
    /** `AppError.kind` when it failed. `null` otherwise - a client branches on this. */
    errorKind: z.string().nullable().default(null),
    errorCode: z.string().nullable().default(null),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

/**
 * The `event:` names the server puts on the wire, which are the union's own `type`s.
 *
 * They matter to a client for one reason and it is not documentation: `EventSource`
 * routes a *named* frame to `addEventListener(name, …)` and never to `onmessage`, so a
 * client has to know the names to hear anything at all. Derived from the schema rather
 * than listed, because a seventh event kind that nobody subscribed to would be a
 * silence no test would notice.
 */
export const RUN_EVENT_NAMES = RunEvent.options.map(
  (member) => member.shape.type.value,
) as readonly RunEvent['type'][];

/**
 * The server's keep-alive. Not a `RunEvent`, and deliberately still observed.
 *
 * Stage 6 can generate images for minutes without emitting anything, which reads as an
 * idle socket to a proxy and as a stalled run to a person. A heartbeat every 15 seconds
 * is the difference between "the run is quiet" and "the connection is dead", and a
 * monitor that cannot tell those apart shows a spinner after the video is ready.
 */
export const RUN_HEARTBEAT_EVENT = 'heartbeat';
