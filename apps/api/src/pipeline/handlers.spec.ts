/**
 * The two stages that actually do something, and the ten that honestly do not.
 *
 * S0's whole job is to guarantee that every stage after it receives a `Brief`. A run
 * that started with something else has to fail *here*, not eight stages later with a
 * shape error nobody can trace back - so the interesting test is the malformed brief,
 * not the good one.
 *
 * S5's whole job is to produce an approvable estimate without spending anything, so
 * the interesting test is that it refuses to run before S1 and S4 rather than quietly
 * resolving zero specs and reporting a $0 plan.
 */

import type { AssetSpec, PipelineStageKey, RunId } from '@rv/contracts';
import { ResolveAssetDemandUseCase, FlatRateAssetCostEstimator } from '@rv/asset-registry';
import type { AssetRepository } from '@rv/asset-registry';
import { ok, isErr, toIso, instant, type Result } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { RunSummary } from '../application/resources';
import { IntakeStageHandler, ResolveStageHandler, STAGE_OWNER, StubStageHandler } from './handlers';
import type { StageContext, StageProgress } from './stage';

const RUN = 'run_01J0000000000000000000000A' as RunId;
const STYLE_CHECKSUM = 'a'.repeat(64);

const IDEA_BRIEF = {
  kind: 'idea',
  language: 'fa',
  targetAudience: 'Persian-speaking adults',
  toneWords: ['melancholy'],
  targetEpisodeDurationMs: 480_000,
  episodes: { seasons: 1, episodesPerSeason: 6, openEnded: false },
  constraints: { mustNotAppear: [], ratingCeiling: 'teen' },
  references: [],
  idea: 'A fox learns the city rearranges itself.',
};

const SPEC: AssetSpec = {
  semanticKey: 'flora/oak-tree/mature',
  archetype: 'tree',
  subjectClass: 'foliage',
  label: 'Mature oak',
  description: 'A gnarled old oak with a split trunk.',
  tags: [],
  canvas: { width: 1024, height: 1024 },
  nominalHeight: 512,
  parts: [
    {
      name: 'trunk',
      role: 'root',
      description: 'A split trunk',
      zOrder: 0,
      deformable: false,
      optional: false,
    },
  ],
  variants: [],
  references: [],
  quality: 'preview',
  requireAlpha: true,
};

/** Answers "nothing is in the library", which is the miss path every estimate takes. */
const emptyRepository = {
  findManyByKeys: () => Promise.resolve(ok(new Map())),
} as unknown as AssetRepository;

function context(
  stage: PipelineStageKey,
  payload: Record<string, unknown>,
): {
  readonly context: StageContext;
  readonly progress: { progress: number; detail?: string }[];
} {
  const progress: StageProgress[] = [];
  const run = RunSummary.parse({
    id: RUN,
    projectId: 'prj_01J0000000000000000000000A',
    seriesId: null,
    status: 'running',
    requestedStages: [stage],
    currentStage: stage,
    stages: [],
    seed: 1,
    budgetNanoUsd: null,
    spentNanoUsd: 0,
    errorCode: null,
    startedAt: toIso(instant(0)),
    finishedAt: null,
  });

  return {
    progress,
    context: {
      run,
      job: {
        id: 'job_01J0000000000000000000000A',
        runId: RUN,
        stage,
        payload,
        attempt: 1,
      },
      reportProgress: (update) => {
        progress.push(update);
      },
      signal: new AbortController().signal,
    },
  };
}

describe('IntakeStageHandler', () => {
  it('accepts a well-formed brief and names what it accepted', async () => {
    const { context: ctx, progress } = context('intake', { brief: IDEA_BRIEF });
    const outcome = await new IntakeStageHandler().execute(ctx);

    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;
    expect(outcome.value.artifacts).toEqual(['brief:idea']);
    expect(progress.at(-1)?.progress).toBe(1);
  });

  it('fails on a brief that does not validate, with the field named', async () => {
    const { context: ctx } = context('intake', { brief: { kind: 'idea' } });
    const outcome = await new IntakeStageHandler().execute(ctx);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    const issues = outcome.error.context.issues as { path: string }[];
    // Every failing field, by path - not just the first, and not just a message.
    expect(issues.map((issue) => issue.path)).toContain('targetAudience');
    expect(issues.length).toBeGreaterThan(1);
  });

  it('fails on a payload with no brief at all', async () => {
    const { context: ctx } = context('intake', {});
    expect(isErr(await new IntakeStageHandler().execute(ctx))).toBe(true);
  });
});

describe('ResolveStageHandler', () => {
  const useCase = new ResolveAssetDemandUseCase({
    repository: emptyRepository,
    estimator: new FlatRateAssetCostEstimator(),
  });

  it('prices the misses and reports the hit/miss split', async () => {
    const { context: ctx, progress } = context('resolve', {
      specs: [SPEC],
      styleBibleId: 'sty_01J0000000000000000000000A',
      styleChecksum: STYLE_CHECKSUM,
    });

    const outcome = await new ResolveStageHandler(useCase).execute(ctx);

    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;
    expect(outcome.value.artifacts).toEqual(['asset-demand-plan:0/1']);
    expect(progress.at(-1)?.detail).toContain('to generate');
  });

  it('refuses before S1 and S4 rather than reporting a $0 plan for nothing', async () => {
    const { context: ctx } = context('resolve', {});
    const outcome = await new ResolveStageHandler(useCase).execute(ctx);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    // A plan over zero specs costs nothing and means nothing, and a user would approve
    // it. The refusal names the stages that have to run first.
    expect(outcome.error.kind).toBe('unsupported');
    expect(outcome.error.message).toContain('S1 and S4');
  });

  it('passes the run budget through, so an over-budget spec is blocked in the plan', async () => {
    const { context: ctx } = context('resolve', {
      specs: [SPEC],
      styleBibleId: 'sty_01J0000000000000000000000A',
      styleChecksum: STYLE_CHECKSUM,
    });
    const budgeted: StageContext = { ...ctx, run: { ...ctx.run, budgetNanoUsd: 1 } };

    const outcome = await new ResolveStageHandler(useCase).execute(budgeted);
    if (isErr(outcome)) throw outcome.error;
    // Blocked, not counted: the plan reports 0 misses because the one spec would have
    // taken it past the ceiling.
    expect(outcome.value.artifacts).toEqual(['asset-demand-plan:0/0']);
  });
});

describe('StubStageHandler', () => {
  it('names the package that owes each unimplemented stage', async () => {
    const stages: readonly PipelineStageKey[] = [
      'style',
      'story',
      'cast',
      'world',
      'produce',
      'sequence',
      'choreograph',
      'preview',
      'render',
      'deliver',
    ];

    for (const stage of stages) {
      const { context: ctx } = context(stage, {});
      const outcome: Result<unknown> = await new StubStageHandler(stage).execute(ctx);

      expect(isErr(outcome), stage).toBe(true);
      if (!isErr(outcome)) continue;
      expect(outcome.error.kind, stage).toBe('unsupported');
      expect(outcome.error.context.provider, stage).toBe(STAGE_OWNER[stage]);
    }
  });

  it('has an owner recorded for every stage in the pipeline', () => {
    expect(Object.keys(STAGE_OWNER)).toHaveLength(12);
  });
});
