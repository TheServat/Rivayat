/**
 * Resumability for S6 Produce, expressed in the pipeline's own vocabulary.
 *
 * `StageCheckpoint` in `@rv/contracts` already answers the three questions a resumed
 * run asks - what ran, was it run on *this*, and where is what it produced - and its
 * `inputHash` is explicitly "the whole of cached". So produce does not invent a second
 * notion of progress; it writes `StageCheckpoint`s.
 *
 * What it cannot do is put them on `PipelineRun.checkpoints`. That array is capped at
 * one entry per pipeline stage and refuses a stage checkpointed twice, which is
 * correct for a twelve-stage run and useless for forty assets moving through eight
 * internal steps each. So the *record* is the contract's and the *key* is ours:
 * `(runId, assetKey, step, attempt)` identifies the row, `StageCheckpoint` is the row,
 * and `stage` on every one of them is `produce` because that is the stage they belong
 * to. {@link produceStageCheckpoint} folds the whole set back into the single
 * checkpoint the run itself carries.
 *
 * `attempt` is in the key rather than in the hash because the quality gate's repair
 * loop regenerates with a different prompt: without it, a repaired take overwrites the
 * record of the take it was repairing, and the ledger loses the money the first one
 * cost.
 */

import {
  type AppError,
  type Clock,
  type Result,
  type Unit,
  contentHash,
  toIso,
} from '@rv/shared-kernel';
import type {
  ArtifactRef,
  AssetKey,
  RunId,
  Sha256Hex,
  StageCheckpoint,
  PipelineStage,
} from '@rv/contracts';

/**
 * The eight things that happen to one asset, in order.
 *
 * `score` sits between `split` and `rig` because part-completeness is a measured input
 * to the rubric (RV-128) and cannot be scored before the parts exist - and because a
 * take that fails the gate must not be rigged, clipped or baked, which is most of the
 * work.
 */
export const PRODUCE_STEPS = [
  'generate',
  'matte',
  'split',
  'score',
  'rig',
  'clips',
  'bake',
  'register',
] as const;

export type ProduceStep = (typeof PRODUCE_STEPS)[number];

/** The stage every produce checkpoint belongs to. S6. */
export const PRODUCE_STAGE: PipelineStage = 'produce';

export interface ProduceCheckpointKey {
  readonly runId: RunId;
  readonly assetKey: AssetKey;
  readonly step: ProduceStep;
  /** 0 for the first take. Raised once per quality-gate repair. */
  readonly attempt: number;
}

/** A total, printable key. The obvious storage key for any implementation. */
export function checkpointKeyString(key: ProduceCheckpointKey): string {
  return `${key.runId}/${key.assetKey}/${key.step}/${String(key.attempt)}`;
}

/**
 * Where finished steps are remembered between processes.
 *
 * Two methods and no delete: a checkpoint is a statement that something happened, and
 * the way to invalidate one is to change the inputs so its `inputHash` stops matching.
 * An implementation that forgets is allowed - `read` returning `null` costs a re-run,
 * never a wrong answer.
 */
export interface ProduceCheckpointStore {
  read(key: ProduceCheckpointKey): Promise<Result<StageCheckpoint | null, AppError>>;
  write(key: ProduceCheckpointKey, checkpoint: StageCheckpoint): Promise<Result<Unit, AppError>>;
}

/**
 * "Already ran **on this**", as one hash.
 *
 * The step name and the attempt are folded in as well as the inputs, so two steps that
 * happen to consume the same bytes cannot collide and a repair attempt never matches
 * the take it is repairing.
 */
export function stepInputHash(
  step: ProduceStep,
  assetKey: AssetKey,
  attempt: number,
  inputs: unknown,
): Sha256Hex {
  return contentHash({ step, assetKey, attempt, inputs });
}

export interface StepArtifacts {
  readonly outputs: readonly ArtifactRef[];
  readonly costNanoUsd: number;
}

/** Builds the contract record. Kept here so every step writes the same shape. */
export function stageCheckpoint(
  clock: Clock,
  inputHash: Sha256Hex,
  artifacts: StepArtifacts,
): StageCheckpoint {
  return {
    stage: PRODUCE_STAGE,
    inputHash,
    outputs: [...artifacts.outputs],
    jobIds: [],
    costNanoUsd: artifacts.costNanoUsd,
    completedAt: toIso(clock.now()),
  };
}

/**
 * The whole produce stage as the one checkpoint a `PipelineRun` is allowed to carry.
 *
 * The per-asset rows above are how *this* stage resumes internally; this is how the
 * *run* knows the stage is done. `inputHash` covers the specs and the style checksum,
 * which is exactly the "editing re-runs only the downstream stages that depend on it"
 * promise: change a spec, and S6's hash moves.
 */
export function produceStageCheckpoint(input: {
  readonly clock: Clock;
  readonly specHashes: readonly Sha256Hex[];
  readonly styleChecksum: Sha256Hex;
  readonly variantKey: string | undefined;
  readonly outputs: readonly ArtifactRef[];
  readonly costNanoUsd: number;
}): StageCheckpoint {
  return stageCheckpoint(
    input.clock,
    contentHash({
      specs: [...input.specHashes].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
      styleChecksum: input.styleChecksum,
      variantKey: input.variantKey ?? null,
    }),
    { outputs: input.outputs, costNanoUsd: input.costNanoUsd },
  );
}
