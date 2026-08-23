/**
 * DOC, tested where it can actually fail.
 *
 * Three things are worth a test here and the rest is plumbing: that a level cannot be
 * skipped, that a two-level response is impossible rather than merely discouraged, and
 * that an expansion which is not bound to its parent is refused however well it reads.
 */

import { describe, expect, it } from 'vitest';
import { isErr } from '@rv/shared-kernel';

import {
  FakeStructuredBackend,
  respondError,
  respondJson,
  respondText,
} from '../__fixtures__/fakes';
import { outlineContext, testDeps } from '../__fixtures__/builders';
import {
  ExpandOutlineLevelUseCase,
  expandableInto,
  validateExpansion,
} from './expand-outline-level';
import { OutlineExpansion } from './expansion';

const PARENT_PLAN =
  'Take the keeper from denial to admission across six episodes, and pay the boat’s name ' +
  'off in the finale.';

const PARENT = {
  level: 'season' as const,
  title: 'Season one',
  summary: 'The keeper stops being able to explain the voice away.',
  plannedSummary: PARENT_PLAN,
};

function child(ordinal: number, title: string): Record<string, unknown> {
  return {
    ordinal,
    title,
    plannedSummary: `Episode ${String(ordinal)} must move her one step closer to saying it.`,
    summary: `She works through ${title.toLowerCase()} and loses a little more of the denial.`,
    servesParentPlanBy: 'It is one of the six steps from denial to admission.',
    movesEntityNames: ['Mahtab'],
  };
}

function goodExpansion(count = 3): Record<string, unknown> {
  return {
    parentPlanEcho: PARENT_PLAN,
    children: Array.from({ length: count }, (_, index) =>
      child(index + 1, `Episode ${String(index + 1)}`),
    ),
  };
}

describe('ExpandOutlineLevelUseCase', () => {
  it("expands exactly one level and returns the parent's children", async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(goodExpansion())] });
    const outcome = await new ExpandOutlineLevelUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      parent: PARENT,
      targetLevel: 'episode',
      parentSiblingSummaries: ['Season two picks up two winters later.'],
    });

    if (isErr(outcome)) throw new Error(`expected an expansion, got ${outcome.error.message}`);
    expect(outcome.value.level).toBe('episode');
    expect(outcome.value.parentLevel).toBe('season');
    expect(outcome.value.children).toHaveLength(3);
    expect(outcome.value.children.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
    expect(backend.callCount).toBe(1);
  });

  it('refuses to skip a level, before spending anything', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(goodExpansion())] });
    const outcome = await new ExpandOutlineLevelUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      parent: PARENT,
      // A season expands into episodes. Asking it for scenes is three levels down.
      targetLevel: 'scene',
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({
      reason: 'outline-level-skip',
      parentLevel: 'season',
      targetLevel: 'scene',
      expectedLevel: 'episode',
    });
    // The point of checking first: no model was called, so nothing was billed.
    expect(backend.callCount).toBe(0);
  });

  it('refuses to expand a beat, which has nothing below it', async () => {
    const backend = new FakeStructuredBackend();
    const outcome = await new ExpandOutlineLevelUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      parent: { ...PARENT, level: 'beat' },
      targetLevel: 'beat',
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'no-child-level' });
    expect(backend.callCount).toBe(0);
  });

  it('cannot emit a node two levels down, because there is nowhere to put one', () => {
    // The structural half of the guarantee: a grandchild key is rejected outright.
    const withGrandchildren = {
      ...goodExpansion(1),
      children: [{ ...child(1, 'Episode 1'), acts: [{ ordinal: 1, title: 'Act one' }] }],
    };
    const parsed = OutlineExpansion.safeParse(withGrandchildren);
    expect(parsed.success).toBe(false);
  });

  it("sends the parent node and its siblings' summaries, and nothing deeper", async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(goodExpansion())] });
    await new ExpandOutlineLevelUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      parent: PARENT,
      targetLevel: 'episode',
      parentSiblingSummaries: ['Season two picks up two winters later.'],
    });

    const prompt = backend.userPromptAt(0);
    expect(prompt).toContain(PARENT.title);
    expect(prompt).toContain(PARENT.summary);
    expect(prompt).toContain(PARENT_PLAN);
    expect(prompt).toContain('Season two picks up two winters later.');
    expect(prompt).toContain('Expand this season into its episode children');
    expect(prompt).toContain('Produce episode nodes and nothing below them');
  });

  it("refuses an expansion that did not quote its parent's instruction back", async () => {
    const backend = new FakeStructuredBackend({
      script: [
        respondJson({
          ...goodExpansion(),
          parentPlanEcho: 'Write six episodes about a lighthouse.',
        }),
      ],
    });
    const outcome = await new ExpandOutlineLevelUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      parent: PARENT,
      targetLevel: 'episode',
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'expansion-not-bound-to-parent' });
  });

  it('holds the expansion to the child count it asked for', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(goodExpansion(3))] });
    const outcome = await new ExpandOutlineLevelUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      parent: PARENT,
      targetLevel: 'episode',
      childCount: { min: 5, max: 8 },
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'child-count-out-of-bounds', count: 3 });
  });

  it('refuses impossible child bounds without calling anything', async () => {
    const backend = new FakeStructuredBackend();
    const outcome = await new ExpandOutlineLevelUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      parent: PARENT,
      targetLevel: 'episode',
      childCount: { min: 4, max: 2 },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'bad-child-bounds' });
    expect(backend.callCount).toBe(0);
  });

  it('binds the series root to its own summary, since it has no parent instruction', async () => {
    const rootSummary = 'Six episodes on a shoal coast where the sea has started answering back.';
    const backend = new FakeStructuredBackend({
      script: [respondJson({ ...goodExpansion(1), parentPlanEcho: rootSummary })],
    });
    const outcome = await new ExpandOutlineLevelUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      parent: { level: 'series', title: 'The Keeper', summary: rootSummary, plannedSummary: null },
      targetLevel: 'season',
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.boundTo).toBe(rootSummary);
  });

  it('repairs a malformed response rather than failing on it', async () => {
    const backend = new FakeStructuredBackend({
      enforcesSchema: false,
      script: [
        respondText('Sure! Here is the season, expanded:'),
        // Ordinals 1, 2, 2 - caught by the schema, so the repair turn gets a second go.
        respondJson({
          parentPlanEcho: PARENT_PLAN,
          children: [child(1, 'One'), child(2, 'Two'), child(2, 'Three')],
        }),
        respondJson(goodExpansion(3)),
      ],
    });
    const outcome = await new ExpandOutlineLevelUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      parent: PARENT,
      targetLevel: 'episode',
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(backend.callCount).toBe(3);
    expect(outcome.value.trace.resolution).toBe('repaired');
    expect(outcome.value.trace.repairTurns).toBe(2);
  });

  it('escalates to the next backend when the first one is down', async () => {
    const broken = new FakeStructuredBackend({ id: 'fake:broken', script: [respondError()] });
    const spare = new FakeStructuredBackend({
      id: 'fake:spare',
      script: [respondJson(goodExpansion(2))],
    });
    const outcome = await new ExpandOutlineLevelUseCase(testDeps(broken, spare)).execute({
      context: outlineContext(),
      parent: PARENT,
      targetLevel: 'episode',
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.trace.escalatedTo).toBe('fake:spare');
  });

  it('surfaces a total failure as a Result, not a throw', async () => {
    const backend = new FakeStructuredBackend({ script: [respondError(), respondError()] });
    const outcome = await new ExpandOutlineLevelUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      parent: PARENT,
      targetLevel: 'episode',
    });
    expect(isErr(outcome)).toBe(true);
  });
});

describe('validateExpansion', () => {
  it('accepts an echo that only differs in whitespace and case', () => {
    const parsed = OutlineExpansion.parse({
      ...goodExpansion(1),
      parentPlanEcho: `  TAKE the keeper from denial to admission across six episodes,\n  and pay the boat’s name off in the finale.  `,
    });
    expect(isErr(validateExpansion(parsed, PARENT_PLAN))).toBe(false);
  });
});

describe('expandableInto', () => {
  it('tells the UI what an expand button would do', () => {
    expect(expandableInto('scene')).toBe('beat');
    expect(expandableInto('beat')).toBeUndefined();
  });
});
