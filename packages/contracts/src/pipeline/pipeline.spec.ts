import { describe, expect, it } from 'vitest';
import { type z } from 'zod';

import { toLlmJsonSchema } from '../json-schema';
import { PipelineStageKey } from '../provider/capability';
import { PipelineJob } from './job';
import { PipelineError, PipelineRun, StageCheckpoint, remainingStages } from './run';
import {
  ArtifactRef,
  PIPELINE_STAGE_CODES,
  PIPELINE_STAGES,
  PIPELINE_STATUSES,
  PIPELINE_STATUS_TRANSITIONS,
  PipelineStage,
  PipelineStatus,
  canTransition,
  isStoppedStatus,
  pipelineStageIndex,
} from './stage';

// ── fixtures ────────────────────────────────────────────────────────────────

const ulid = (tail: string): string => `01J9ZQ3K5M7N9P1R3T5V7X${tail}`;

const RUN_ID = `run_${ulid('0001')}`;
const JOB_ID = `job_${ulid('0002')}`;
const OTHER_JOB_ID = `job_${ulid('0003')}`;
const PROJECT_ID = `prj_${ulid('0004')}`;
const SERIES_ID = `ser_${ulid('0005')}`;
const EPISODE_ID = `ep_${ulid('0006')}`;
const HASH = 'a'.repeat(64);
const STARTED = '2026-06-01T00:00:00Z';
const LATER = '2026-06-01T01:00:00Z';
const EARLIER = '2026-05-31T00:00:00Z';

function failurePaths<T>(result: z.ZodSafeParseResult<T>): string[] {
  if (result.success) throw new Error('expected the parse to fail, but it succeeded');
  return result.error.issues.map((issue) => issue.path.join('.'));
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    seriesId: SERIES_ID,
    episodeId: EPISODE_ID,
    requestedStages: ['story', 'cast', 'world'],
    status: 'running',
    currentStage: 'cast',
    seed: 42,
    startedAt: STARTED,
    ...overrides,
  };
}

function checkpoint(
  stage: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { stage, inputHash: HASH, completedAt: STARTED, ...overrides };
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    runId: RUN_ID,
    stage: 'produce',
    status: 'running',
    queuedAt: STARTED,
    startedAt: STARTED,
    ...overrides,
  };
}

// ── the stage vocabulary is derived, not re-declared ────────────────────────

describe('PipelineStage', () => {
  it('is the same enum `provider/capability.ts` already had, not a second list', () => {
    // The point of the derivation. Two hand-written lists of twelve strings agree until
    // one is renamed, and the failure is silent: a `UsageRecord` filed under a stage the
    // run does not have simply never appears in the breakdown someone is reading.
    expect(PipelineStage.options).toEqual(PipelineStageKey.options);
    expect(PIPELINE_STAGES).toEqual(PipelineStageKey.options);
  });

  it('covers S0 Intake through S11 Deliver, in order', () => {
    expect(PIPELINE_STAGES.map((stage) => PIPELINE_STAGE_CODES[stage])).toEqual(
      PIPELINE_STAGES.map((_stage, index) => `S${String(index)}`),
    );
    expect(PIPELINE_STAGES).toHaveLength(12);
    expect(PIPELINE_STAGES.at(0)).toBe('intake');
    expect(PIPELINE_STAGES.at(-1)).toBe('deliver');
  });

  it('gives every stage a code, and no code a stage that does not exist', () => {
    expect(Object.keys(PIPELINE_STAGE_CODES).sort()).toEqual([...PIPELINE_STAGES].sort());
  });

  it('reports a position for every stage, ordered the way the pipeline runs', () => {
    expect(PIPELINE_STAGES.map(pipelineStageIndex)).toEqual(PIPELINE_STAGES.map((_s, i) => i));
    expect(pipelineStageIndex('story')).toBeLessThan(pipelineStageIndex('render'));
  });

  it('reports -1 for a string that is not a stage, rather than pretending it is first', () => {
    // Reachable from untrusted input: the index feeds an ordering comparison, and 0
    // would silently sort an unknown stage to the front of the pipeline.
    expect(pipelineStageIndex('nonsense' as PipelineStage)).toBe(-1);
  });
});

// ── the lifecycle ───────────────────────────────────────────────────────────

describe('PIPELINE_STATUS_TRANSITIONS', () => {
  it('names a legal-move list for every status and no status that does not exist', () => {
    expect(Object.keys(PIPELINE_STATUS_TRANSITIONS).sort()).toEqual([...PIPELINE_STATUSES].sort());
  });

  it('only ever moves to a status that exists', () => {
    for (const [from, targets] of Object.entries(PIPELINE_STATUS_TRANSITIONS)) {
      for (const to of targets) {
        expect(PipelineStatus.options, `${from} -> ${to}`).toContain(to);
      }
    }
  });

  it('lets a failed run or job be re-queued, which is what "resumable" and "retry" are', () => {
    expect(canTransition('failed', 'queued')).toBe(true);
  });

  it('never leaves a finished or cancelled one, because a replay is a new run', () => {
    expect(PIPELINE_STATUS_TRANSITIONS.succeeded).toEqual([]);
    expect(PIPELINE_STATUS_TRANSITIONS.cancelled).toEqual([]);
    expect(canTransition('succeeded', 'running')).toBe(false);
  });

  it('lets anything still in flight be cancelled - the "cancellable" of architecture 4', () => {
    for (const status of PIPELINE_STATUSES) {
      if (isStoppedStatus(status)) continue;
      expect(canTransition(status, 'cancelled'), status).toBe(true);
    }
  });

  it('separates "has stopped" from "will never move again", because failed is both and neither', () => {
    // The distinction that decides whether `finishedAt` is required. A failed run has
    // stopped - it must record when - and it is not final, because resuming it is the
    // entire point of a checkpoint.
    expect(PIPELINE_STATUSES.filter(isStoppedStatus)).toEqual(['succeeded', 'failed', 'cancelled']);
    expect(
      PIPELINE_STATUSES.filter((status) => PIPELINE_STATUS_TRANSITIONS[status].length === 0),
    ).toEqual(['succeeded', 'cancelled']);
    expect(isStoppedStatus('failed')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(true);
  });

  it('does not call a queued or paused run stopped', () => {
    expect(isStoppedStatus('queued')).toBe(false);
    expect(isStoppedStatus('paused')).toBe(false);
  });
});

// ── artefact references ─────────────────────────────────────────────────────

describe('ArtifactRef', () => {
  it('addresses an artefact and records what its bytes hashed to', () => {
    const parsed = ArtifactRef.parse({
      kind: 'story-bible',
      ref: SERIES_ID,
      contentHash: HASH,
    });
    expect(parsed.contentHash).toBe(HASH);
  });

  it('defaults the hash to null for the artefacts that genuinely have none', () => {
    expect(ArtifactRef.parse({ kind: 'render-master', ref: 'out/master.mov' }).contentHash).toBe(
      null,
    );
  });

  it('insists the kind is a slug, so it stays usable as a grouping key', () => {
    expect(ArtifactRef.safeParse({ kind: 'Story Bible', ref: 'x' }).success).toBe(false);
  });
});

// ── the run ─────────────────────────────────────────────────────────────────

describe('PipelineRun', () => {
  it('accepts a run of a non-contiguous slice of the pipeline', () => {
    // "Re-render and deliver" is a real request and is two stages with eight missing
    // between them - which is why `requestedStages` is a list rather than a range.
    const parsed = PipelineRun.parse(
      run({ requestedStages: ['render', 'deliver'], currentStage: 'render' }),
    );
    expect(parsed.requestedStages).toEqual(['render', 'deliver']);
  });

  it('defaults to no episode, no checkpoint, no budget, nothing spent and no error', () => {
    const parsed = PipelineRun.parse(run({ episodeId: undefined, currentStage: undefined }));
    expect(parsed.episodeId).toBeNull();
    expect(parsed.currentStage).toBeNull();
    expect(parsed.checkpoints).toEqual([]);
    expect(parsed.budgetNanoUsd).toBeNull();
    expect(parsed.spentNanoUsd).toBe(0);
    expect(parsed.error).toBeNull();
    expect(parsed.finishedAt).toBeNull();
  });

  it('refuses a run with no seed, because a run that cannot be replayed is not a run', () => {
    expect(failurePaths(PipelineRun.safeParse(run({ seed: undefined })))).toEqual(['seed']);
  });

  it('refuses stages listed out of pipeline order', () => {
    const result = PipelineRun.safeParse(
      run({ requestedStages: ['render', 'story'], currentStage: 'story' }),
    );
    expect(failurePaths(result)).toContain('requestedStages');
  });

  it('refuses a repeated stage, which would double that stage of the estimate', () => {
    const result = PipelineRun.safeParse(
      run({ requestedStages: ['story', 'story'], currentStage: 'story' }),
    );
    expect(failurePaths(result)).toContain('requestedStages');
  });

  it('refuses a current stage this run never asked for', () => {
    expect(failurePaths(PipelineRun.safeParse(run({ currentStage: 'render' })))).toEqual([
      'currentStage',
    ]);
  });

  it('refuses a checkpoint for a stage this run never asked for', () => {
    const result = PipelineRun.safeParse(run({ checkpoints: [checkpoint('render')] }));
    expect(failurePaths(result)).toEqual(['checkpoints.0.stage']);
  });

  it('refuses the same stage checkpointed twice, which makes the skip list ambiguous', () => {
    const result = PipelineRun.safeParse(
      run({ checkpoints: [checkpoint('story'), checkpoint('story')] }),
    );
    expect(failurePaths(result)).toEqual(['checkpoints.1.stage']);
  });

  it('refuses a failed run that cannot say what failed', () => {
    const result = PipelineRun.safeParse(
      run({ status: 'failed', finishedAt: LATER, currentStage: null }),
    );
    expect(failurePaths(result)).toEqual(['error']);
  });

  it('refuses a finished run that does not record when it finished', () => {
    const result = PipelineRun.safeParse(run({ status: 'succeeded', currentStage: null }));
    expect(failurePaths(result)).toEqual(['finishedAt']);
  });

  it('accepts a failed run that names the stage and the job it died in', () => {
    const parsed = PipelineRun.parse(
      run({
        status: 'failed',
        currentStage: null,
        finishedAt: LATER,
        error: {
          code: 'provider.rate_limit',
          message: 'Gemini returned 429 four times; the failover chain was exhausted.',
          stage: 'cast',
          jobId: JOB_ID,
          at: LATER,
        },
      }),
    );
    expect(parsed.error?.stage).toBe('cast');
    expect(parsed.error?.jobId).toBe(JOB_ID);
  });

  it('defaults a pipeline error to naming no single job, for a failure between them', () => {
    const parsed = PipelineError.parse({
      code: 'budget.exceeded',
      message: 'The projected cost of S6 crosses the per-run ceiling.',
      stage: 'produce',
      at: LATER,
    });
    expect(parsed.jobId).toBeNull();
  });
});

describe('StageCheckpoint', () => {
  it('records what the stage ran on, what it produced and what it cost', () => {
    const parsed = StageCheckpoint.parse(
      checkpoint('story', {
        outputs: [{ kind: 'story-bible', ref: SERIES_ID, contentHash: HASH }],
        jobIds: [JOB_ID],
        costNanoUsd: 2_500_000,
      }),
    );
    expect(parsed.inputHash).toBe(HASH);
    expect(parsed.outputs).toHaveLength(1);
    expect(parsed.costNanoUsd).toBe(2_500_000);
  });

  it('insists on an input hash, because "already ran" is not the same as "already ran on this"', () => {
    const result = StageCheckpoint.safeParse({ stage: 'story', completedAt: STARTED });
    expect(failurePaths(result)).toEqual(['inputHash']);
  });
});

describe('remainingStages', () => {
  it('is what a resumed run executes: requested, minus checkpointed, in pipeline order', () => {
    const parsed = PipelineRun.parse(
      run({ checkpoints: [checkpoint('story')], currentStage: 'cast' }),
    );
    expect(remainingStages(parsed)).toEqual(['cast', 'world']);
  });

  it('is empty once every requested stage has a checkpoint', () => {
    const parsed = PipelineRun.parse(
      run({
        status: 'succeeded',
        currentStage: null,
        finishedAt: LATER,
        checkpoints: [checkpoint('story'), checkpoint('cast'), checkpoint('world')],
      }),
    );
    expect(remainingStages(parsed)).toEqual([]);
  });

  it('is the whole request before anything has run', () => {
    expect(remainingStages(PipelineRun.parse(run()))).toEqual(['story', 'cast', 'world']);
  });
});

// ── the job ─────────────────────────────────────────────────────────────────

describe('PipelineJob', () => {
  it('defaults to a first attempt inside a three-attempt budget, with nothing spent', () => {
    const parsed = PipelineJob.parse(job());
    expect([parsed.attempt, parsed.maxAttempts, parsed.costNanoUsd]).toEqual([1, 3, 0]);
    expect(parsed.inputs).toEqual([]);
    expect(parsed.outputs).toEqual([]);
    expect(parsed.payload).toEqual({});
    expect([parsed.finishedAt, parsed.durationMs, parsed.errorCode]).toEqual([null, null, null]);
  });

  it('carries the artefacts it read and produced', () => {
    const parsed = PipelineJob.parse(
      job({
        status: 'succeeded',
        finishedAt: LATER,
        durationMs: 3_600_000,
        inputs: [{ kind: 'asset-spec', ref: HASH, contentHash: HASH }],
        outputs: [{ kind: 'asset-version', ref: `asv_${ulid('0007')}` }],
      }),
    );
    expect(parsed.inputs.at(0)?.kind).toBe('asset-spec');
    expect(parsed.outputs.at(0)?.contentHash).toBeNull();
  });

  it('refuses a failed job that cannot name its error', () => {
    const result = PipelineJob.safeParse(job({ status: 'failed', finishedAt: LATER }));
    expect(failurePaths(result)).toEqual(['errorCode']);
  });

  it('refuses a job that finished without ever starting', () => {
    const result = PipelineJob.safeParse(
      job({ status: 'succeeded', startedAt: null, finishedAt: LATER }),
    );
    expect(failurePaths(result)).toEqual(['startedAt']);
  });

  it('lets a queued job be cancelled without pretending it ran', () => {
    const parsed = PipelineJob.parse(
      job({ status: 'cancelled', startedAt: null, finishedAt: LATER }),
    );
    expect(parsed.startedAt).toBeNull();
  });

  it('refuses a job that finished before it started', () => {
    const result = PipelineJob.safeParse(
      job({ status: 'succeeded', startedAt: LATER, finishedAt: STARTED }),
    );
    expect(failurePaths(result)).toEqual(['finishedAt']);
  });

  it('refuses a terminal job with no finish time', () => {
    expect(failurePaths(PipelineJob.safeParse(job({ status: 'succeeded' })))).toEqual([
      'finishedAt',
    ]);
  });

  it('refuses an attempt past the retry budget, which nothing would ever schedule or fail', () => {
    const result = PipelineJob.safeParse(job({ attempt: 4, maxAttempts: 3 }));
    expect(failurePaths(result)).toEqual(['attempt']);
  });

  it('accepts the last attempt inside the budget', () => {
    expect(PipelineJob.safeParse(job({ attempt: 3, maxAttempts: 3 })).success).toBe(true);
  });

  it('keeps a retry attributable: the attempt count rises and the cost accumulates', () => {
    const parsed = PipelineJob.parse(
      job({
        status: 'failed',
        attempt: 2,
        finishedAt: LATER,
        errorCode: 'provider.timeout',
        costNanoUsd: 900_000,
      }),
    );
    expect(parsed.attempt).toBe(2);
    // The two failed tries burned real tokens; a ledger that only counted the eventual
    // success would under-report the run.
    expect(parsed.costNanoUsd).toBe(900_000);
  });

  it('accepts a job queued but not yet picked up', () => {
    const parsed = PipelineJob.parse(job({ status: 'queued', startedAt: null }));
    expect(parsed.startedAt).toBeNull();
  });

  it('rejects an unknown field rather than dropping it', () => {
    expect(PipelineJob.safeParse(job({ shard: { index: 0, count: 4 } })).success).toBe(false);
  });

  it('takes an arbitrary stage request in `payload` and hands it back unchanged', () => {
    const payload = { formats: ['youtube-1080p'], nested: { crf: 18 }, list: [1, 2, 3] };
    expect(PipelineJob.parse(job({ payload })).payload).toEqual(payload);
  });
});

// ── what a caller filling one in is told ────────────────────────────────────

describe('the emitted JSON Schema', () => {
  it('closes both records so a stray field is a parse error rather than a dropped one', () => {
    for (const schema of [PipelineRun, PipelineJob, StageCheckpoint]) {
      const json = toLlmJsonSchema(schema, { dialect: 'ollama' });
      expect(json.type).toBe('object');
      expect(json.additionalProperties).toBe(false);
    }
  });

  it('drops the ordering guard on requestedStages, which is why parse is the backstop', () => {
    const emitted = JSON.stringify(toLlmJsonSchema(PipelineRun, { dialect: 'ollama' }));
    // The *description* survives and says "in pipeline order, no repeats" - which is
    // advice the model may ignore. The refinement's own wording is what does not
    // survive, and it is the only thing that actually rejects a bad list.
    expect(emitted).toContain('in pipeline order, no repeats');
    expect(emitted).not.toContain('must be in pipeline order');
    expect(
      PipelineRun.safeParse(run({ requestedStages: ['deliver', 'intake'], currentStage: 'intake' }))
        .success,
    ).toBe(false);
  });
});

// ── a checkpointed instant is still an instant ──────────────────────────────

describe('timestamps', () => {
  it('refuses a checkpoint completed with a malformed instant', () => {
    expect(
      StageCheckpoint.safeParse(checkpoint('story', { completedAt: '2026-06-01' })).success,
    ).toBe(false);
  });

  it('accepts a run whose finish precedes nothing, because a run has no such guard to trip', () => {
    // `PipelineRun` deliberately does not compare `startedAt` and `finishedAt`: a run
    // spans process restarts and clock corrections, and rejecting the record would lose
    // the only evidence of what happened. The job, which is one worker and one machine,
    // does compare them - see above.
    expect(
      PipelineRun.safeParse(run({ status: 'cancelled', currentStage: null, finishedAt: EARLIER }))
        .success,
    ).toBe(true);
  });

  it('keeps the two jobs of one run distinguishable', () => {
    expect(PipelineJob.parse(job({ id: OTHER_JOB_ID })).id).not.toBe(JOB_ID);
  });
});
