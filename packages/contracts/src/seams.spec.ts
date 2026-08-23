/**
 * Cross-file seam tests.
 *
 * Every other spec in this package tests one module. These test the joins between
 * modules - the places four people writing in parallel produce two schemas for one
 * idea, or a promise in one file that only another file can keep. A seam has no
 * natural owner, so it has no natural spec file either, and that is exactly why the
 * defects here survived: each half looked correct on its own.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { animationIr, assetSpec, rig, styleBible } from './__fixtures__/builders';
import { sceneOneShots, twoEpisodeSeriesBible } from './story/__fixtures__/two-episode-series';
import * as contracts from './index';
import { toLlmJsonSchema, type SchemaDialect } from './json-schema';
import { AnimationIR } from './anim/ir';
import { AssetSpec } from './asset/asset-spec';
import { Rig } from './asset/rig';
import { Relation } from './narrative/relation';
import { PipelineJob } from './pipeline/job';
import {
  PIPELINE_STAGE_CODES,
  PIPELINE_STAGES,
  PIPELINE_STATUSES,
  PipelineStage,
  PipelineStatus,
} from './pipeline/stage';
import { BudgetPolicy, CostEstimate } from './provider/usage';
import { PipelineStageKey, ProviderKind } from './provider/capability';
import { FORMAT_PRESETS } from './render/format';
import { RenderJob, RenderJobState } from './render/render-job';
import { INTAKE_STAGES, IntakeStage, StoryModelProvider } from './story/brief';
import { Shot } from './story/shot';
import { SeriesBible } from './story/story-bible';
import { StyleBible } from './style/style-bible';

const SRC_ROOT = import.meta.dirname;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__fixtures__') continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
      out.push(full);
    }
  };
  walk(SRC_ROOT);
  return out.sort();
}

// ── `z.toJSONSchema` drops every refinement ─────────────────────────────────

/**
 * Every object-level refinement in the package, and what keeps it honest at runtime.
 *
 * None of these reach the model. `z.toJSONSchema` emits a schema byte-identical to the
 * one it would emit with the refinement deleted, so a `StructuredCall` constrained by
 * that schema is constrained by the *shape* only, and every invariant below is a rule
 * the model has never been told. The only thing enforcing them is `schema.safeParse`
 * in the wrapper's validate step, which is why the wrapper is non-negotiable #6 rather
 * than a convenience.
 *
 * A refinement added without a line here fails the inventory test below. That is
 * deliberate: the question "and where is this checked at runtime?" should have to be
 * answered once, in writing, at the moment the refinement is written.
 */
const REFINEMENT_INVENTORY: Readonly<Record<string, string>> = {
  Act: 'sequence ordinals are 1..n',
  ActOutline: 'sequence ordinals are 1..n, on the stored projection as well as the authoring form',
  AnimationIR:
    'node ids unique, parents resolve, no cycles, tracks/behaviours/camera/overrides resolve',
  Asset:
    'currentVersionId resolves; version ordinals unique; an embedding and its model are present together (shared `checkEmbeddingPair`)',
  AssetVersion: 'bone part bindings and variant part names resolve against this version',
  BitrateRange: 'maxMbps >= minMbps',
  ContinuityIssue: 'a contradiction names both of its sides',
  CostEstimate: 'hits + misses = items; projection inside its own bracket',
  DeformMesh: 'whole triangles, indices in range, vertex weights sum to 1',
  Episode: 'act ordinals are 1..n; airedAt present exactly when aired',
  EpisodeOutline:
    'act ordinals are 1..n; airedAt present exactly when aired - same two checks as `Episode`, shared via `checkSiblingOrdinals` and `checkAirState`',
  Fact: 'validUntil >= validFrom and retractedAt >= assertedAt, via the same shared `checkBiTemporalOrder` as `Relation`; an embedding and its model are present together (shared `checkEmbeddingPair`); a summary does not cover itself',
  FrameRange: 'the range contains at least one frame',
  ModelDescriptor:
    'image capability implies image output and an image price; `:free` implies free and text-only',
  MotionStyle: 'defaultEasing and camera.panEase resolve against easings; easing names unique',
  OpenLoop: 'a paid loop records where; an abandoned loop records why',
  PipelineJob:
    'a failed job names its error; a finished job started first and finished after; a terminal job records when; attempts stay inside the retry budget',
  PipelineRun:
    'requested stages are in pipeline order with no repeats; the current stage and every checkpoint were requested; no stage is checkpointed twice; a failed run names its error; a terminal run records when',
  PropPayload: 'a riggable prop describes what articulates',
  ReframePlan: 'a plan containing a safe-area violation flags itself for review',
  Relation:
    'validUntil >= validFrom; retractedAt >= assertedAt - the shared `checkBiTemporalOrder`, the same function `Fact` uses',
  RenderArtifact: 'master and audio carry no format; a delivery carries one',
  RenderJob: 'a failed job carries an error code',
  RenderProgress: 'framesDone <= framesTotal',
  RetrievedFact:
    'an always-included fact is rank 0, score 1; a `fact`-kinded ref names the same id as factId',
  Rig: 'one root, no duplicate or cyclic bones, and every mesh/chain/anchor/constraint reference resolves',
  Scene: 'beat ordinals are 1..n',
  SceneSpace:
    'reframeTargets contains the master aspect, has no repeats, and covers every override',
  Season: 'episode ordinals are 1..n',
  Sequence: 'scene ordinals are 1..n',
  SeriesBible: 'season ordinals are 1..n',
  Shot: 'instance handles unique, paint orders unique, blocking and focus resolve against the layout',
  ShotAssetPin: 'a pin resolves only what the author left open',
  ShotCompilation: 'no instance is pinned twice',
  StructuredCallOutcome:
    'escalation names its target, failure names its code, clean means no repair',
  StyleBible: 'a forked style names its parent',
  TargetFormat: 'deliverables contains the master aspect and has no repeats',
  Track: 'keyframes strictly ordered by time',
  VisualStyle: 'a custom medium describes itself',
  WorldStateSnapshot: 'each keyed epistemic view belongs to its key and to the snapshot instant',
};

function schemasCarryingRefinements(): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(contracts)) {
    if (typeof value !== 'object') continue;
    const def = (value as { _zod?: { def?: { type?: string; checks?: unknown[] } } } | null)?._zod
      ?.def;
    if (def === undefined) continue;
    // Only composite-level checks are lost. A string's `.min()` or `.regex()` survives
    // emission as `minLength` / `pattern`, so it is not a blind spot.
    if (def.type !== 'object' && def.type !== 'array') continue;
    if (Array.isArray(def.checks) && def.checks.length > 0) names.push(name);
  }
  return names.sort();
}

const DIALECTS: readonly SchemaDialect[] = ['plain', 'ollama', 'openai-strict', 'gemini'];

describe('refinements are invisible to the model, in every dialect', () => {
  const shape = { a: z.number(), b: z.number() };
  const bare = z.object(shape);
  const refined = z.object(shape).refine((value) => value.b > value.a, 'b must exceed a');
  const superRefined = z.object(shape).superRefine((value, ctx) => {
    if (value.b <= value.a) ctx.addIssue({ code: 'custom', message: 'b must exceed a' });
  });

  it('emits a refined schema byte-identically to the same schema without the refinement', () => {
    for (const dialect of DIALECTS) {
      const expected = JSON.stringify(toLlmJsonSchema(bare, { dialect }));
      expect(JSON.stringify(toLlmJsonSchema(refined, { dialect })), dialect).toBe(expected);
      expect(JSON.stringify(toLlmJsonSchema(superRefined, { dialect })), dialect).toBe(expected);
    }
  });

  it('still rejects the violating value at parse time, which is the only backstop', () => {
    expect(refined.safeParse({ a: 2, b: 1 }).success).toBe(false);
    expect(superRefined.safeParse({ a: 2, b: 1 }).success).toBe(false);
    expect(bare.safeParse({ a: 2, b: 1 }).success).toBe(true);
  });

  it('loses a real bi-temporal invariant from the schema a model is constrained by', () => {
    const emitted = JSON.stringify(toLlmJsonSchema(Relation, { dialect: 'ollama' }));
    expect(emitted).not.toContain('precede');
    expect(emitted).not.toContain('allOf');

    const inverted = {
      id: `rel_${'0'.repeat(24)}A1`,
      seriesId: `ser_${'0'.repeat(24)}A2`,
      from: `ent_${'0'.repeat(24)}A3`,
      to: `ent_${'0'.repeat(24)}A4`,
      type: 'parent-of',
      fact: 'Aria is Kael’s mother.',
      validFrom: { ordinal: 900 },
      validUntil: { ordinal: 100 },
      assertedAt: '2026-08-23T00:00:00Z',
      sourceRef: { kind: 'author' },
    };
    // The emitted schema would happily accept it; the wrapper's validate step is what
    // does not.
    expect(Relation.safeParse(inverted).success).toBe(false);
  });

  it('accounts for every refinement in the package', () => {
    expect(schemasCarryingRefinements()).toEqual(Object.keys(REFINEMENT_INVENTORY).sort());
  });

  it('describes what each refinement enforces, so the runtime check has an owner', () => {
    for (const [name, invariant] of Object.entries(REFINEMENT_INVENTORY)) {
      expect(invariant.length, name).toBeGreaterThan(10);
    }
  });
});

// ── defaults survive a round trip ───────────────────────────────────────────

describe('parsing is a fixed point', () => {
  const cases: readonly (readonly [string, z.ZodType, unknown])[] = [
    ['SeriesBible', SeriesBible, twoEpisodeSeriesBible],
    ['Shot', Shot, sceneOneShots[0]],
    ['StyleBible', StyleBible, styleBible()],
    ['AnimationIR', AnimationIR, animationIr()],
    ['AssetSpec', AssetSpec, assetSpec()],
    ['Rig', Rig, rig()],
  ];

  it('re-parses its own output to the identical value', () => {
    // `parse(parse(x))` has to equal `parse(x)`. Where it does not, a default is being
    // re-applied over an explicit value, or a transform is not idempotent - and every
    // artefact in this system is written, stored, read back and re-validated, so a
    // non-fixed-point schema drifts a little on every hop.
    for (const [name, schema, raw] of cases) {
      const once = schema.parse(raw);
      const twice = schema.parse(once);
      expect(twice, name).toEqual(once);
      expect(JSON.stringify(twice), name).toBe(JSON.stringify(once));
    }
  });

  it('fills defaults on the first pass and leaves them alone on the second', () => {
    const first = AssetSpec.parse(assetSpec({ tags: undefined, quality: undefined }));
    expect(first.quality).toBe('preview');
    expect(AssetSpec.parse(first).quality).toBe('preview');
  });
});

// ── one vocabulary, not several ─────────────────────────────────────────────

describe('narrowed vocabularies are subtractions, not copies', () => {
  it('takes the intake stages out of the pipeline stage list rather than re-typing them', () => {
    expect(PipelineStageKey.options).toContain('intake');
    expect(IntakeStage.options).toEqual(
      PipelineStageKey.options.filter((stage) => stage !== 'intake' && stage !== 'preview'),
    );
    expect(INTAKE_STAGES).toEqual(IntakeStage.options);
  });

  it('rejects the two stages intake may not schedule for itself', () => {
    expect(IntakeStage.safeParse('intake').success).toBe(false);
    expect(IntakeStage.safeParse('preview').success).toBe(false);
  });

  it('takes the story backends out of the provider list rather than re-typing them', () => {
    for (const provider of StoryModelProvider.options) {
      expect(ProviderKind.options, provider).toContain(provider);
    }
    expect(StoryModelProvider.safeParse('comfyui').success).toBe(false);
  });

  it('gives the pipeline the stage list the router already had, not a second copy', () => {
    // `provider/capability.ts` had to name the stages first, because routing and cost
    // accounting sit below the pipeline in the dependency graph. `PipelineStage` is that
    // same enum under the canonical name - so a `UsageRecord.stage` and a
    // `PipelineRun.currentStage` are the same value, not two that happen to agree.
    expect(PipelineStage.options).toEqual(PipelineStageKey.options);
    expect(PIPELINE_STAGES).toEqual(PipelineStageKey.options);
    expect(Object.keys(PIPELINE_STAGE_CODES).sort()).toEqual([...PipelineStageKey.options].sort());
  });

  it('gives a render job the same six states every other job has', () => {
    // A render is stage S10 and a `RenderJob` is what sits inside a `PipelineJob` there.
    // Two state vocabularies would need a mapping table between the job the scheduler
    // sees and the job the render worker sees, and that is where a cancelled render
    // starts reporting as failed.
    expect(RenderJobState.options).toEqual(PipelineStatus.options);
    expect([...PIPELINE_STATUSES]).toEqual([...RenderJobState.options]);
  });
});

// ── a render job is a pipeline job with a render inside it ──────────────────

describe('RenderJob fits inside a PipelineJob unchanged', () => {
  const runId = `run_${'0'.repeat(24)}R1`;
  const jobId = `job_${'0'.repeat(24)}J1`;

  const renderJob = RenderJob.parse({
    id: jobId,
    runId,
    request: {
      projectId: `prj_${'0'.repeat(24)}P1`,
      animationId: `anm_${'0'.repeat(24)}A1`,
      formats: [FORMAT_PRESETS['yt-1080p'].id],
      quality: 'final',
    },
    state: 'running',
    checkpoint: { updatedAt: '2026-08-23T00:00:00Z' },
    createdAt: '2026-08-23T00:00:00Z',
    updatedAt: '2026-08-23T00:00:00Z',
  });

  const wrapped = PipelineJob.parse({
    id: jobId,
    runId,
    stage: 'render',
    status: renderJob.state,
    queuedAt: renderJob.createdAt,
    startedAt: renderJob.createdAt,
    payload: renderJob,
  });

  it('survives the round trip through `payload` byte for byte', () => {
    // The whole justification for an opaque payload. If the generic job record mangled
    // the stage's own document - dropped a default, reordered a key, stripped a null -
    // then either every stage payload has to be enumerated here or the render worker
    // reads something the scheduler did not write.
    expect(wrapped.payload).toEqual(renderJob);
    expect(JSON.stringify(wrapped.payload)).toBe(JSON.stringify(renderJob));
    expect(RenderJob.parse(wrapped.payload)).toEqual(renderJob);
  });

  it('shares its identity with the job that carries it, rather than being a second job', () => {
    expect(wrapped.id).toBe(renderJob.id);
    expect(wrapped.runId).toBe(renderJob.runId);
  });

  it('needs no translation for its state, because the vocabularies are one list', () => {
    for (const state of RenderJobState.options) {
      expect(PipelineStatus.safeParse(state).success, state).toBe(true);
    }
    expect(wrapped.status).toBe(renderJob.state);
  });

  it('places itself at the stage the architecture numbers S10', () => {
    expect(PIPELINE_STAGE_CODES[wrapped.stage]).toBe('S10');
  });
});

// ── non-negotiable #3: a caller can check before it spends ──────────────────

describe('cost can be checked before it is spent', () => {
  const estimate = {
    items: 12,
    cacheHits: 9,
    cacheMisses: 3,
    projectedNanoUsd: 4_200_000,
    lowNanoUsd: 3_000_000,
    highNanoUsd: 6_000_000,
    assumptions: ['1024px output at the Gemini image-output rate verified 2026-08-23'],
    requiresConfirmation: false,
    computedAt: '2026-08-23T00:00:00Z',
  };

  it('gives the guard an upper bound, not just a guess, to compare against a ceiling', () => {
    const parsed = CostEstimate.parse(estimate);
    const policy = BudgetPolicy.parse({ perRunNanoUsd: 5_000_000 });
    // The check the guard performs, expressed as the data it needs: worst case against
    // the ceiling. Comparing the *projection* would approve a run that can overspend.
    expect(policy.perRunNanoUsd).not.toBeNull();
    expect(parsed.highNanoUsd > (policy.perRunNanoUsd ?? 0)).toBe(true);
    expect(parsed.projectedNanoUsd < (policy.perRunNanoUsd ?? 0)).toBe(true);
  });

  it('answers "does this need a human" from the estimate and the policy alone', () => {
    const parsed = CostEstimate.parse(estimate);
    const policy = BudgetPolicy.parse({ confirmAboveNanoUsd: 1_000_000 });
    expect(parsed.highNanoUsd > (policy.confirmAboveNanoUsd ?? Infinity)).toBe(true);
  });

  it('defaults to no ceiling and an abort, so an unconfigured project cannot spend quietly past a limit it has', () => {
    const policy = BudgetPolicy.parse({});
    expect(policy.onExceed).toBe('abort');
    expect([
      policy.perRunNanoUsd,
      policy.perDayNanoUsd,
      policy.perProjectNanoUsd,
      policy.confirmAboveNanoUsd,
    ]).toEqual([null, null, null, null]);
  });

  it('refuses an estimate whose cache arithmetic does not add up, so a plan cannot under-report misses', () => {
    expect(CostEstimate.safeParse({ ...estimate, cacheMisses: 1 }).success).toBe(false);
  });

  it('represents the $0 second run the dedup architecture exists to produce', () => {
    const free = CostEstimate.parse({
      ...estimate,
      cacheHits: 12,
      cacheMisses: 0,
      projectedNanoUsd: 0,
      lowNanoUsd: 0,
      highNanoUsd: 0,
    });
    expect(free.highNanoUsd).toBe(0);
    expect(free.requiresConfirmation).toBe(false);
  });
});

// ── non-negotiable #5: Zod is the single source of truth ────────────────────

describe('every domain type is inferred from a schema', () => {
  /**
   * Type declarations that are not domain shapes, with the reason each is allowed.
   *
   * The rule is that no shape an LLM fills, a database stores or the API exposes may be
   * written by hand beside its schema. These are none of those: they configure the
   * emitter itself, and they have no schema to be inferred from.
   */
  const ALLOWED_HAND_WRITTEN: Readonly<Record<string, string>> = {
    SchemaDialect: 'json-schema.ts: which provider dialect to emit, not a domain shape',
    LlmSchemaOptions: 'json-schema.ts: arguments to the emitter, not a domain shape',
    SettingDescriptor:
      'settings/descriptor.ts: carries a live Zod schema and a default typed by it, neither of which a schema can describe. Its serialisable half IS a schema - `SettingDescriptorMeta` - and registry.spec.ts parses every declaration through it.',
    AnySettingDescriptor: 'settings/descriptor.ts: `SettingDescriptor<unknown>`, same reason',
  };

  /** Derivations of a schema-inferred type are still schema-derived. */
  const DERIVED = /z\.infer<|Extract<|keyof typeof|\['kind'\]/;

  it('declares no hand-written type or interface for a domain shape', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        const match = /^export (?:type|interface) (\w+)/.exec(line);
        if (match === null) return;
        const name = match[1] ?? '';
        if (name in ALLOWED_HAND_WRITTEN) return;
        if (DERIVED.test(line)) return;
        offenders.push(
          `${relative(SRC_ROOT, file).split(sep).join('/')}:${String(index + 1)} ${name}`,
        );
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the exemption list honest - a stale exemption is itself a defect', () => {
    const source = sourceFiles()
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const name of Object.keys(ALLOWED_HAND_WRITTEN)) {
      // A word boundary rather than a trailing space: a generic declaration is followed
      // by `<`, so the space form could never see one and would report every exempted
      // generic as stale. `\b` also keeps `SettingDescriptor` from matching
      // `SettingDescriptorMeta`, which is what the space was buying.
      const declared = new RegExp(`export (?:type|interface) ${name}\\b`).test(source);
      expect(declared, `${name} is exempted but no longer declared`).toBe(true);
    }
  });

  it('catches a hand-written domain shape planted beside a schema', () => {
    // The scanner above is only worth having if it fires. This is the same predicate
    // run over a planted line, so a refactor that silently defeats the regex fails here
    // rather than passing an empty scan.
    const planted = 'export interface CharacterSheet {';
    const match = /^export (?:type|interface) (\w+)/.exec(planted);
    expect(match?.[1]).toBe('CharacterSheet');
    expect(DERIVED.test(planted)).toBe(false);
    expect('CharacterSheet' in ALLOWED_HAND_WRITTEN).toBe(false);
  });
});
