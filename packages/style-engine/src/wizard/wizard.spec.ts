import { MotionStyle, StyleBibleDraft, VisualStyle } from '@rv/contracts';
import { createRng, isErr, isOk, stableStringify } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { STYLE_PRESETS, motionDistance } from '../presets/index';
import { compilePromptFragments } from '../prompts/compile';
import { checkStyleCoherence } from './coherence';
import { composeStyleDraft } from './compose';
import {
  BASE_QUESTION_ID,
  WIZARD_QUESTIONS,
  type WizardAnswers,
  defaultAnswers,
  nextQuestion,
  visibleQuestions,
} from './questions';

const BASES = STYLE_PRESETS.map((preset) => preset.id);

/**
 * Every reachable leaf of the tree.
 *
 * A "leaf" is one option of one question, reached from a base for which that question
 * is actually visible - `light` and `shimmer` are hidden for some media on purpose, so
 * enumerating options against a single fixed base would silently skip them. Every other
 * question is answered with its first option, which keeps the case count linear instead
 * of the ~1.5 million a full cartesian would be.
 */
function leaves(): readonly (readonly [string, WizardAnswers])[] {
  const out: (readonly [string, WizardAnswers])[] = [];
  for (const base of BASES) {
    const baseline = defaultAnswers(base);
    for (const question of visibleQuestions(baseline)) {
      for (const option of question.options) {
        if (question.id === BASE_QUESTION_ID) continue;
        out.push([
          `${base} / ${question.id}=${option.id}`,
          { ...baseline, [question.id]: option.id },
        ]);
      }
    }
    out.push([`${base} / defaults`, baseline]);
  }
  return out;
}

describe('the wizard question tree', () => {
  it('asks about movement as much as it asks about looks', () => {
    // A wizard that only asks about looks composes a bible whose motion block is
    // whatever the preset happened to have - the exact failure the architecture is
    // built to avoid.
    const motionQuestions = WIZARD_QUESTIONS.filter((question) =>
      question.options.every((option) => option.patch.motion !== undefined),
    );
    expect(motionQuestions.length).toBeGreaterThanOrEqual(4);
    expect(motionQuestions.map((question) => question.id)).toEqual(
      expect.arrayContaining(['movement-feel', 'cadence', 'scene-life', 'pace']),
    );
  });

  it('localises every question and every option', () => {
    for (const question of WIZARD_QUESTIONS) {
      expect(question.prompt.fa.length, question.id).toBeGreaterThan(0);
      expect(question.prompt.en, question.id).toBeDefined();
      expect(question.help.fa.length, question.id).toBeGreaterThan(0);
      expect(question.options.length, question.id).toBeGreaterThanOrEqual(3);
      for (const option of question.options) {
        expect(option.label.fa.length, `${question.id}/${option.id}`).toBeGreaterThan(0);
        expect(option.label.en, `${question.id}/${option.id}`).toBeDefined();
        expect(option.description.fa.length, `${question.id}/${option.id}`).toBeGreaterThan(0);
      }
      expect(new Set(question.options.map((option) => option.id)).size).toBe(
        question.options.length,
      );
    }
  });

  it('offers every preset as a starting point', () => {
    const look = WIZARD_QUESTIONS.find((question) => question.id === BASE_QUESTION_ID);
    expect(look?.options.map((option) => option.presetId)).toEqual(BASES);
  });

  it('hides questions that would be controls doing nothing', () => {
    // Boil on a strict pixel lattice is an artefact, and a flat-shaded medium has no
    // shadow to point in any direction.
    const pixel = visibleQuestions({ [BASE_QUESTION_ID]: 'pixel-art' }).map((q) => q.id);
    expect(pixel).not.toContain('shimmer');
    const flat = visibleQuestions({ [BASE_QUESTION_ID]: 'flat-vector' }).map((q) => q.id);
    expect(flat).not.toContain('light');
    const watercolour = visibleQuestions({ [BASE_QUESTION_ID]: 'watercolour' }).map((q) => q.id);
    expect(watercolour).toContain('shimmer');
    expect(watercolour).toContain('light');
  });

  it('walks from nothing to a complete answer set and then stops', () => {
    const answers: Record<string, string> = {};
    let steps = 0;
    for (;;) {
      const question = nextQuestion(answers);
      if (question === null) break;
      const first = question.options[0];
      expect(first).toBeDefined();
      answers[question.id] = first?.id ?? '';
      steps += 1;
      expect(steps).toBeLessThan(50);
    }
    expect(nextQuestion(answers)).toBeNull();
    expect(answers[BASE_QUESTION_ID]).toBeDefined();
  });

  it('shows a dependent question only once its dependency is answered', () => {
    // Before `look` is answered there is nothing to depend on, so the gated questions
    // must not appear at all rather than defaulting to visible.
    const ids = visibleQuestions({}).map((question) => question.id);
    expect(ids).not.toContain('shimmer');
    expect(ids).not.toContain('light');
    expect(ids[0]).toBe(BASE_QUESTION_ID);
  });
});

describe('composeStyleDraft', () => {
  it.each(leaves())('reaches a complete, parseable draft from %s', (_label, answers) => {
    const result = composeStyleDraft({ answers, name: 'Wizard style', seed: 5150 });

    expect(isOk(result), stableStringify(isErr(result) ? result.error.message : '')).toBe(true);
    if (!isOk(result)) return;

    // "No field left at a placeholder" (RV-043): the draft parses, and re-parsing its
    // two blocks proves nothing was left half-patched.
    expect(() => StyleBibleDraft.parse(result.value)).not.toThrow();
    expect(() => VisualStyle.parse(result.value.visual)).not.toThrow();
    expect(() => MotionStyle.parse(result.value.motion)).not.toThrow();
    expect(result.value.origin).toBe('wizard');
    expect(result.value.seed).toBe(5150);
    expect(result.value.prompts.positive.length).toBeGreaterThan(50);
  });

  it('reaches a valid draft from a seeded sample of full answer combinations', () => {
    // The tree has over a million complete paths; the per-leaf enumeration above covers
    // every option once, and this covers interactions between them. Seeded, so a
    // failure is reproducible (CLAUDE.md §1).
    const rng = createRng('wizard-combinations');
    for (let trial = 0; trial < 200; trial += 1) {
      const base = rng.pick(BASES);
      const answers: Record<string, string> = { [BASE_QUESTION_ID]: base };
      for (const question of visibleQuestions(answers)) {
        if (question.id === BASE_QUESTION_ID) continue;
        answers[question.id] = rng.pick(question.options).id;
      }
      const result = composeStyleDraft({ answers, name: 'Sampled', seed: 1 });
      expect(isOk(result), stableStringify(answers)).toBe(true);
    }
  });

  it('needs no model call and is byte-identical between runs', () => {
    // Composition is a pure function - there is no dependency to inject, which is a
    // stronger guarantee than RV-043 asked for.
    const answers = defaultAnswers('watercolour');
    const first = composeStyleDraft({ answers, name: 'Twice', seed: 3 });
    const second = composeStyleDraft({ answers, name: 'Twice', seed: 3 });
    if (!isOk(first) || !isOk(second)) throw new Error('expected ok');
    expect(stableStringify(first.value)).toBe(stableStringify(second.value));
  });

  it('derives the prompt fragments from the composed fields', () => {
    const result = composeStyleDraft({
      answers: defaultAnswers('ink-comic'),
      name: 'Derived prompts',
      seed: 1,
    });
    if (!isOk(result)) throw new Error('expected ok');
    expect(compilePromptFragments({ visual: result.value.visual })).toEqual(result.value.prompts);
  });

  it('makes the movement answer actually change the movement', () => {
    const base = defaultAnswers('watercolour');
    const springy = composeStyleDraft({
      answers: { ...base, 'movement-feel': 'springy' },
      name: 'A',
      seed: 1,
    });
    const heavy = composeStyleDraft({
      answers: { ...base, 'movement-feel': 'heavy' },
      name: 'A',
      seed: 1,
    });
    if (!isOk(springy) || !isOk(heavy)) throw new Error('expected ok');

    expect(motionDistance(springy.value.motion, heavy.value.motion)).toBeGreaterThan(0.05);
    expect(springy.value.motion.principles.weight).toBeLessThan(
      heavy.value.motion.principles.weight,
    );
    // ...and must not silently change the look while doing it.
    expect(stableStringify(springy.value.visual)).toBe(stableStringify(heavy.value.visual));
  });

  it('makes the cadence answer change the frame stepping', () => {
    const base = defaultAnswers('gouache-storybook');
    const smooth = composeStyleDraft({
      answers: { ...base, cadence: 'smooth' },
      name: 'A',
      seed: 1,
    });
    const chunky = composeStyleDraft({
      answers: { ...base, cadence: 'chunky' },
      name: 'A',
      seed: 1,
    });
    if (!isOk(smooth) || !isOk(chunky)) throw new Error('expected ok');
    expect(smooth.value.motion.stepMode).toBe('smooth');
    expect(chunky.value.motion.stepMode).toBe('on-2s');
    expect(chunky.value.motion.fps).toBe(12);
  });

  it('makes the mood answer replace the palette', () => {
    const base = defaultAnswers('felt-craft');
    const warm = composeStyleDraft({
      answers: { ...base, mood: 'warm-earth' },
      name: 'A',
      seed: 1,
    });
    const stark = composeStyleDraft({
      answers: { ...base, mood: 'stark-graphic' },
      name: 'A',
      seed: 1,
    });
    if (!isOk(warm) || !isOk(stark)) throw new Error('expected ok');
    expect(warm.value.visual.palette.harmony).toBe('earthy');
    expect(stark.value.visual.palette.harmony).toBe('high-contrast');
    expect(stark.value.prompts.positive).not.toBe(warm.value.prompts.positive);
  });

  it('accumulates negatives instead of letting the last answer win', () => {
    const result = composeStyleDraft({
      answers: { ...defaultAnswers('felt-craft'), mood: 'stark-graphic', detail: 'very-simple' },
      name: 'A',
      seed: 1,
    });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.visual.negative).toEqual(expect.arrayContaining(['pastel colours']));
    expect(result.value.visual.negative).toEqual(
      expect.arrayContaining(['busy background clutter']),
    );
    // Still a set - a prohibition listed twice is a wasted token in a 77-token window.
    expect(new Set(result.value.visual.negative).size).toBe(result.value.visual.negative.length);
  });
});

describe('composeStyleDraft, refusals', () => {
  it('will not compose without a starting point', () => {
    const result = composeStyleDraft({ answers: {}, name: 'A', seed: 1 });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.context).toMatchObject({ missing: [BASE_QUESTION_ID] });
  });

  it('rejects an unknown preset', () => {
    const result = composeStyleDraft({
      answers: { [BASE_QUESTION_ID]: 'art-nouveau' },
      name: 'A',
      seed: 1,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.context).toMatchObject({ answer: 'art-nouveau' });
  });

  it('names the questions still unanswered', () => {
    const result = composeStyleDraft({
      answers: { [BASE_QUESTION_ID]: 'watercolour', mood: 'cool-quiet' },
      name: 'A',
      seed: 1,
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.context).toMatchObject({
      missing: expect.arrayContaining(['outline']),
    });
  });

  it('rejects a stale option id rather than skipping the answer', () => {
    const result = composeStyleDraft({
      answers: { ...defaultAnswers('watercolour'), outline: 'dotted-line' },
      name: 'A',
      seed: 1,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.context).toMatchObject({ question: 'outline' });
  });

  it('refuses an incoherent override and names both fields', () => {
    const result = composeStyleDraft({
      answers: defaultAnswers('watercolour'),
      name: 'A',
      seed: 1,
      overrides: { line: { present: false, weight: 0.8 } },
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.context).toMatchObject({
        fields: ['visual.line.present', 'visual.line.weight'],
      });
    }
  });

  it('applies a coherent override', () => {
    const result = composeStyleDraft({
      answers: defaultAnswers('watercolour'),
      name: 'A',
      seed: 1,
      overrides: { shape: { headToBodyRatio: 9 }, motion: { tempo: 2 } },
    });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.visual.shape.headToBodyRatio).toBe(9);
    expect(result.value.motion.tempo).toBe(2);
  });
});

describe('checkStyleCoherence', () => {
  const preset = STYLE_PRESETS.find((candidate) => candidate.id === 'gouache-storybook');
  if (preset === undefined) throw new Error('missing preset');
  const { visual, motion } = preset.draft;

  it('passes every shipped preset', () => {
    for (const candidate of STYLE_PRESETS) {
      const result = checkStyleCoherence(candidate.draft.visual, candidate.draft.motion);
      expect(isOk(result), candidate.id).toBe(true);
    }
  });

  it.each([
    [
      'an outline colour on a style with no outline',
      {
        ...visual,
        line: { ...visual.line, present: false, weight: 0, colorMode: 'black' as const },
      },
      motion,
      ['visual.line.present', 'visual.line.colorMode'],
    ],
    [
      'multiple bands on flat shading',
      { ...visual, shading: { ...visual.shading, model: 'flat' as const, steps: 3 } },
      motion,
      ['visual.shading.model', 'visual.shading.steps'],
    ],
    [
      'a boil amplitude with boil switched off',
      visual,
      { ...motion, boil: { ...motion.boil, enabled: false, amplitude: 0.4 } },
      ['motion.boil.enabled', 'motion.boil.amplitude'],
    ],
    [
      'four-frame holds at under twelve frames a second',
      visual,
      { ...motion, stepMode: 'on-4s' as const, fps: 8 },
      ['motion.stepMode', 'motion.fps'],
    ],
  ])('rejects %s', (_label, badVisual, badMotion, fields) => {
    const result = checkStyleCoherence(badVisual, badMotion);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.context).toMatchObject({ fields });
  });
});
