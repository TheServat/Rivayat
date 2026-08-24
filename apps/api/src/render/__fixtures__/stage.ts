/**
 * A stage context, as the runner builds one.
 *
 * Shared by the four stage specs because the interesting part of each is never the
 * context: it is the payload, the run's own artefacts, and what the handler does with
 * them. `stages` is a parameter because the seam between S8 and everything downstream
 * *is* the run record - a later stage finds the composition an earlier one produced by
 * reading it - so a test of that seam has to be able to put something there.
 */

import type { PipelineStageKey } from '@rv/contracts';
import { instant, toIso } from '@rv/shared-kernel';

import { RunStageResult, RunSummary, type RunStatus } from '../../application/resources';
import type { StageContext, StageProgress } from '../../pipeline/stage';

export const RUN_ID = 'run_01J0000000000000000000000A';

export interface StageHarness {
  readonly context: StageContext;
  readonly progress: StageProgress[];
  readonly controller: AbortController;
}

export function succeeded(stage: PipelineStageKey, artifacts: readonly string[]): RunStageResult {
  return RunStageResult.parse({ stage, status: 'succeeded', artifacts: [...artifacts] });
}

export function stageContext(options: {
  readonly stage: PipelineStageKey;
  readonly payload: Record<string, unknown>;
  readonly stages?: readonly RunStageResult[];
  readonly seed?: number;
}): StageHarness {
  const progress: StageProgress[] = [];
  const controller = new AbortController();

  const run = RunSummary.parse({
    id: RUN_ID,
    projectId: 'prj_01J0000000000000000000000A',
    seriesId: null,
    status: 'running' satisfies RunStatus,
    requestedStages: [options.stage],
    currentStage: options.stage,
    stages: options.stages ?? [],
    seed: options.seed ?? 11,
    budgetNanoUsd: null,
    spentNanoUsd: 0,
    errorCode: null,
    startedAt: toIso(instant(0)),
    finishedAt: null,
  });

  return {
    progress,
    controller,
    context: {
      run,
      job: {
        id: 'job_01J0000000000000000000000A',
        runId: run.id,
        stage: options.stage,
        payload: options.payload,
        attempt: 1,
      },
      reportProgress: (update) => {
        progress.push(update);
      },
      signal: controller.signal,
    },
  };
}
