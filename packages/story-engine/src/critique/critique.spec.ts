/**
 * The critique pass, tested for the failure it exists to prevent: being a rubber stamp.
 *
 * A critic that returns four scores out of five, or that only ever returns 0.8, costs money
 * and buys nothing. So the tests cover the schema refusing an incomplete report, a
 * deliberately weak draft producing a blocking finding, and the findings coming back joined
 * to the questions that produced them rather than as prose.
 */

import { describe, expect, it } from 'vitest';
import { isErr } from '@rv/shared-kernel';

import { FakeStructuredBackend, respondError, respondJson } from '../__fixtures__/fakes';
import { testDeps } from '../__fixtures__/builders';
import { ART_DIRECTOR, SCREENWRITER, buildRole } from '../roles/index';
import { SCREENWRITER_PROMPT } from '../roles/prompts';
import {
  CritiqueDraftUseCase,
  STORY_BIBLE_RUBRIC,
  critiqueReportSchema,
  toFindings,
} from './critique-draft';

function score(key: string, value: number): Record<string, unknown> {
  return {
    key,
    score: value,
    verdict: `The draft scores ${String(value)} on ${key}.`,
    evidence: [`Act two spends nine pages on the ferry crossing.`],
    revisionNote: value < 0.6 ? 'Cut the crossing and start at the quay.' : 'no change needed',
  };
}

function report(scores: readonly number[]): Record<string, unknown> {
  return {
    scores: STORY_BIBLE_RUBRIC.map((dimension, index) =>
      score(dimension.key, scores[index] ?? 0.8),
    ),
    strongest: 'The premise is legible in one sentence.',
    weakest: 'Nothing in act two is caused by act one.',
  };
}

const DRAFT = 'A lighthouse keeper. Then a boat. Then a voice. Then the end.';

function critique(body: Record<string, unknown>): {
  backend: FakeStructuredBackend;
  run: () => ReturnType<CritiqueDraftUseCase['execute']>;
} {
  const backend = new FakeStructuredBackend({ script: [respondJson(body)] });
  const useCase = new CritiqueDraftUseCase(testDeps(backend));
  return {
    backend,
    run: () =>
      useCase.execute({
        role: SCREENWRITER,
        rubric: STORY_BIBLE_RUBRIC,
        subjectLabel: 'series bible',
        draft: DRAFT,
        context: 'The style bible is locked to gouache.',
      }),
  };
}

describe('CritiqueDraftUseCase', () => {
  it('scores every dimension of the rubric it was given', async () => {
    const outcome = await critique(report([0.8, 0.75, 0.7, 0.8, 0.9])).run();

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.findings).toHaveLength(STORY_BIBLE_RUBRIC.length);
    expect(outcome.value.findings.map((finding) => finding.dimension.key)).toEqual(
      STORY_BIBLE_RUBRIC.map((dimension) => dimension.key),
    );
    expect(outcome.value.accepted).toBe(true);
    expect(outcome.value.blocking).toEqual([]);
  });

  it('returns structured findings, not prose', async () => {
    const outcome = await critique(report([0.8, 0.75, 0.7, 0.8, 0.9])).run();
    if (isErr(outcome)) throw new Error(outcome.error.message);

    const [first] = outcome.value.findings;
    expect(first?.evidence.length).toBeGreaterThan(0);
    expect(first?.revisionNote.length).toBeGreaterThan(0);
    expect(typeof first?.score).toBe('number');
    expect(first?.dimension.question.length).toBeGreaterThan(0);
  });

  it('blocks on a dimension below its own threshold - the critic is not a rubber stamp', async () => {
    const outcome = await critique(report([0.9, 0.9, 0.9, 0.2, 0.9])).run();

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.accepted).toBe(false);
    expect(outcome.value.blocking).toHaveLength(1);
    expect(outcome.value.blocking[0]?.dimension.key).toBe('scene-causality');
    expect(outcome.value.blocking[0]?.revisionNote).toContain('Cut the crossing');
  });

  it("honours a caller-supplied threshold over each dimension's own", async () => {
    const backend = new FakeStructuredBackend({
      script: [respondJson(report([0.7, 0.7, 0.7, 0.7, 0.7]))],
    });
    const outcome = await new CritiqueDraftUseCase(testDeps(backend)).execute({
      role: SCREENWRITER,
      rubric: STORY_BIBLE_RUBRIC,
      subjectLabel: 'series bible',
      draft: DRAFT,
      threshold: 0.95,
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.blocking).toHaveLength(STORY_BIBLE_RUBRIC.length);
    expect(backend.userPromptAt(0)).toContain('fails below 0.95');
  });

  it('reports the mean as a summary but never decides on it', async () => {
    const outcome = await critique(report([1, 1, 1, 0, 1])).run();
    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.overall).toBeCloseTo(0.8);
    // A high mean does not make a blocking dimension acceptable.
    expect(outcome.value.accepted).toBe(false);
  });

  it("falls back to the role's own rubric when none is supplied", async () => {
    const backend = new FakeStructuredBackend({
      script: [
        respondJson({
          scores: ART_DIRECTOR.rubric.map((dimension) => score(dimension.key, 0.9)),
          strongest: 'The silhouette is unmistakable.',
          weakest: "The palette is close to the antagonist's.",
        }),
      ],
    });
    const outcome = await new CritiqueDraftUseCase(testDeps(backend)).execute({
      role: ART_DIRECTOR,
      subjectLabel: 'character design',
      draft: 'A squared-off oilskin cowl.',
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.findings.map((finding) => finding.dimension.key)).toEqual(
      ART_DIRECTOR.rubric.map((dimension) => dimension.key),
    );
  });

  it('asks at temperature zero, so two runs over one draft agree', async () => {
    const { backend, run } = critique(report([0.8, 0.8, 0.8, 0.8, 0.8]));
    await run();
    expect(backend.requests[0]?.temperature).toBe(0);
  });

  it('puts the rubric, the thresholds, the context and the draft in the prompt', async () => {
    const { backend, run } = critique(report([0.8, 0.8, 0.8, 0.8, 0.8]));
    await run();

    const prompt = backend.userPromptAt(0);
    expect(prompt).toContain('premise-clarity');
    expect(prompt).toContain('fails below 0.60');
    expect(prompt).toContain('The style bible is locked to gouache.');
    expect(prompt).toContain(DRAFT);
    expect(prompt).toContain('reviewing a series bible');
  });

  it('says so when no context was supplied rather than leaving a blank heading', async () => {
    const backend = new FakeStructuredBackend({
      script: [respondJson(report([0.8, 0.8, 0.8, 0.8, 0.8]))],
    });
    await new CritiqueDraftUseCase(testDeps(backend)).execute({
      role: SCREENWRITER,
      subjectLabel: 'series bible',
      draft: DRAFT,
    });
    expect(backend.userPromptAt(0)).toContain('No additional context supplied.');
  });

  it('refuses a role that carries no rubric, before spending anything', async () => {
    const backend = new FakeStructuredBackend();
    const empty = buildRole({
      id: 'screenwriter',
      title: 'Screenwriter',
      stage: 'story',
      task: 'story-outline',
      tier: 'final',
      temperature: 0,
      template: SCREENWRITER_PROMPT,
      vars: {},
      rubric: [],
    });
    const outcome = await new CritiqueDraftUseCase(testDeps(backend)).execute({
      role: empty,
      subjectLabel: 'series bible',
      draft: DRAFT,
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'empty-rubric' });
    expect(backend.callCount).toBe(0);
  });

  it('surfaces a failed call as a Result', async () => {
    const backend = new FakeStructuredBackend({ script: [respondError(), respondError()] });
    const outcome = await new CritiqueDraftUseCase(testDeps(backend)).execute({
      role: SCREENWRITER,
      subjectLabel: 'series bible',
      draft: DRAFT,
    });
    expect(isErr(outcome)).toBe(true);
  });
});

describe('critiqueReportSchema', () => {
  it('rejects a report that skipped a dimension', () => {
    const schema = critiqueReportSchema(STORY_BIBLE_RUBRIC);
    const partial = {
      scores: STORY_BIBLE_RUBRIC.slice(0, 4).map((dimension) => score(dimension.key, 0.8)),
      strongest: 'x',
      weakest: 'y',
    };
    expect(schema.safeParse(partial).success).toBe(false);
  });

  it('rejects a dimension scored twice', () => {
    const schema = critiqueReportSchema(STORY_BIBLE_RUBRIC);
    const duplicated = {
      scores: [
        ...STORY_BIBLE_RUBRIC.slice(0, 4).map((dimension) => score(dimension.key, 0.8)),
        score('premise-clarity', 0.2),
      ],
      strongest: 'x',
      weakest: 'y',
    };
    expect(schema.safeParse(duplicated).success).toBe(false);
  });

  it('rejects a key that is not in this rubric', () => {
    const schema = critiqueReportSchema(STORY_BIBLE_RUBRIC);
    const wrong = {
      scores: [
        ...STORY_BIBLE_RUBRIC.slice(0, 4).map((dimension) => score(dimension.key, 0.8)),
        score('vibes', 0.9),
      ],
      strongest: 'x',
      weakest: 'y',
    };
    expect(schema.safeParse(wrong).success).toBe(false);
  });

  it('accepts a complete report', () => {
    expect(
      critiqueReportSchema(STORY_BIBLE_RUBRIC).safeParse(report([0.8, 0.8, 0.8, 0.8, 0.8])).success,
    ).toBe(true);
  });

  it('throws on an empty rubric, which is programmer error rather than a bad draft', () => {
    expect(() => critiqueReportSchema([])).toThrow(/at least one rubric dimension/u);
  });
});

describe('toFindings', () => {
  it('skips a dimension the report never scored rather than fabricating a zero', () => {
    const findings = toFindings(
      {
        scores: [{ key: 'stakes', score: 0.9, verdict: 'v', evidence: ['e'], revisionNote: 'n' }],
        strongest: 's',
        weakest: 'w',
      },
      STORY_BIBLE_RUBRIC,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.dimension.key).toBe('stakes');
    expect(findings[0]?.blocking).toBe(false);
  });
});
