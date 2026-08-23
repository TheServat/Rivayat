/**
 * The pipeline vocabulary: which stages exist, what state a run or a job can be in,
 * and which moves between those states are legal.
 *
 * Architecture §4 says every stage is "idempotent, cached, resumable, cancellable".
 * Three of those four are properties of *state kept outside the queue*: BullMQ can
 * redeliver a message, but it cannot tell you that S2 already produced a story bible
 * from these exact inputs, and it cannot tell a paused run from a dead worker. So the
 * state machine lives here, as data, and the queue stays a transport.
 *
 * Nothing in this file knows what a stage *does*. That is deliberate - `core-domain`
 * registers an implementation per stage in a map, and the union stays exhaustive via
 * `assertNever` (CLAUDE.md §2: no `switch` on a stage name in core).
 */

import { z } from 'zod';

import { NonEmptyString, Sha256Hex, Slug } from '../primitives/common';
import { PipelineStageKey } from '../provider/capability';

// ── the twelve stages ───────────────────────────────────────────────────────

/**
 * The stages of architecture §4, S0 Intake through S11 Deliver.
 *
 * **Derived, not re-declared.** `provider/capability.ts` had to name these first -
 * routing and cost accounting both key off a stage and both sit below the pipeline in
 * the dependency graph - and it named them `PipelineStageKey`, leaving the canonical
 * name free for the pipeline itself. This is that name, and it is the *same enum*: a
 * second list of twelve strings is a second list to forget to update, and the failure
 * mode is silent, because a `UsageRecord` filed under a stage the run does not have
 * simply never shows up in the breakdown the operator is reading.
 */
export const PipelineStage = PipelineStageKey.describe(
  'Which stage of the pipeline this is, S0 Intake through S11 Deliver.',
);
export type PipelineStage = z.infer<typeof PipelineStage>;

/** The stages in execution order. Index in this array is the stage's position. */
export const PIPELINE_STAGES = PipelineStage.options;

/**
 * The `S<n>` labels the architecture doc and every UI use.
 *
 * Data rather than string arithmetic over the index, because the numbering is a
 * published identifier: "S5 Resolve is where you approve the spend" appears in the docs
 * and on screen, and it must survive someone inserting a stage without silently
 * renumbering everything after it.
 */
export const PIPELINE_STAGE_CODES: Readonly<Record<PipelineStage, string>> = {
  intake: 'S0',
  style: 'S1',
  story: 'S2',
  cast: 'S3',
  world: 'S4',
  resolve: 'S5',
  produce: 'S6',
  sequence: 'S7',
  choreograph: 'S8',
  preview: 'S9',
  render: 'S10',
  deliver: 'S11',
};

const STAGE_INDEX: ReadonlyMap<PipelineStage, number> = new Map(
  PIPELINE_STAGES.map((stage, index) => [stage, index]),
);

/**
 * Position of a stage in the pipeline. Total by construction.
 *
 * Exported because "is this list of stages in pipeline order?" and "which stages are
 * still downstream of the failure?" are both questions about position, and both are
 * asked outside this file. `indexOf` at each call site is the same answer computed in
 * O(n) by code that has to remember the array is ordered.
 */
export function pipelineStageIndex(stage: PipelineStage): number {
  return STAGE_INDEX.get(stage) ?? -1;
}

// ── lifecycle ───────────────────────────────────────────────────────────────

export const PIPELINE_STATUSES = [
  'queued',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
] as const;

/**
 * One lifecycle for runs and for jobs.
 *
 * They genuinely have the same states, and giving them two vocabularies would mean
 * translating at the boundary between a run and its own jobs - which is where a
 * `cancelled` run quietly becomes a `failed` job and the operator is told the wrong
 * thing. `paused` covers both a human pause and a budget hold: `BudgetPolicy.onExceed`
 * offers `pause`, and a run stopped for an explicit human yes is stopped, not failed.
 *
 * `render/render-job.ts` narrows nothing from this - `RenderJobState` *is* this list -
 * so a `RenderJob` slots into a `PipelineJob` without a mapping table.
 */
export const PipelineStatus = z
  .enum(PIPELINE_STATUSES)
  .describe('Where this run or job is in its lifecycle.');
export type PipelineStatus = z.infer<typeof PipelineStatus>;

/**
 * The legal moves, as data rather than as a `switch`.
 *
 * Modelled on `EPISODE_STATUS_TRANSITIONS` for the same reasons: a table can be
 * asserted total in a test, rendered in the UI and shipped to the client, while a
 * `switch` in a use-case can do none of those and grows a `default` branch the first
 * time someone adds a state.
 *
 * Two edges are worth explaining. `failed -> queued` is retry and resume: a failed job
 * is re-queued with its attempt count raised, and a failed run is re-queued to pick up
 * from its last `StageCheckpoint` - which is what "resumable" means in architecture §4.
 * `succeeded` and `cancelled` have no outgoing edges at all, because re-running
 * finished work is a *new* run: the old one is the record of what actually happened,
 * and a replay that overwrites it cannot be compared against it.
 */
export const PIPELINE_STATUS_TRANSITIONS: Readonly<
  Record<PipelineStatus, readonly PipelineStatus[]>
> = {
  queued: ['running', 'cancelled'],
  running: ['paused', 'succeeded', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  succeeded: [],
  failed: ['queued'],
  cancelled: [],
};

/** True once nothing more will happen. The three states with no outgoing edges. */
export function isTerminalStatus(status: PipelineStatus): boolean {
  return PIPELINE_STATUS_TRANSITIONS[status].length === 0;
}

/**
 * Whether the state machine permits this move.
 *
 * A function over the table rather than a method on anything, so the domain layer
 * validates a transition without owning one - and so the same answer is available to
 * the API, which has to reject an illegal transition before it reaches a use-case.
 */
export function canTransition(from: PipelineStatus, to: PipelineStatus): boolean {
  return PIPELINE_STATUS_TRANSITIONS[from].includes(to);
}

// ── what a stage consumed and produced ──────────────────────────────────────

/**
 * A pointer to something a stage read or wrote.
 *
 * Deliberately not a union of every artefact type in the system. A run has to be
 * resumable across a process restart and across a schema change, and a checkpoint that
 * embeds the artefacts themselves is a checkpoint that stops loading the day one of
 * those schemas gains a field. A reference plus a hash survives both.
 *
 * `contentHash` is the half that makes caching real. "S2 already ran" is not enough to
 * skip S2 - S2 already ran *on these inputs* is, and the only way to know that after
 * the fact is to have recorded what the inputs hashed to.
 */
export const ArtifactRef = z.strictObject({
  kind: Slug.describe(
    'What sort of artefact, e.g. "story-bible", "asset-version", "animation-ir", "render-master". A slug rather than an enum: stages are pluggable and a new one brings its own artefacts.',
  ),
  ref: NonEmptyString.max(200).describe(
    'How to address it - a prefixed id for anything with a row, a content hash for anything in the blob store.',
  ),
  contentHash: Sha256Hex.nullable()
    .default(null)
    .describe(
      'Hash of the bytes. `null` only where the artefact genuinely has none. Without it a resumed run cannot tell "already done" from "done, then edited".',
    ),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;
