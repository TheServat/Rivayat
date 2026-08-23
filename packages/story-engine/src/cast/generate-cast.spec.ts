/**
 * CHIRON's ordering, and the distinctness bar that stops a cast becoming a chorus.
 *
 * The tests worth having here are about *sequence* and *derivation*: that the appearance
 * call happens after the psychology call and is shown it, that the derivation is recorded,
 * and that a second character who sounds like the first gets exactly one chance to
 * change before the whole thing is refused.
 */

import { describe, expect, it } from 'vitest';
import { CharacterPayload } from '@rv/contracts';
import { isErr } from '@rv/shared-kernel';

import { FakeStructuredBackend, respondError, respondJson } from '../__fixtures__/fakes';
import {
  castCandidate,
  characterPayload,
  outlineContext,
  styleBibleFixture,
  styleBrief,
  testDeps,
} from '../__fixtures__/builders';
import { GenerateCharacterSheetUseCase } from './generate-character-sheet';
import { styleBriefFrom } from '../support/style-brief';
import {
  MIN_DISTINCT_AXES,
  collisions,
  compareAgainstCast,
  differingAxes,
} from './voice-distinctness';

const BASE = characterPayload();

function core(voiceOverrides: Partial<typeof BASE.voice> = {}): Record<string, unknown> {
  return {
    identity: BASE.identity,
    psych: BASE.psych,
    voice: { ...BASE.voice, ...voiceOverrides },
    arc: { startState: BASE.arc.startState, endState: BASE.arc.endState },
    motionSignature: BASE.motionSignature,
    knowledgeScope: 'limited',
  };
}

const VISUAL = {
  visual: {
    silhouetteNote: BASE.visual.silhouetteNote,
    build: BASE.visual.build,
    height: BASE.visual.height,
    palette: BASE.visual.palette,
    distinguishingMarks: BASE.visual.distinguishingMarks,
    propAffinities: [],
  },
  derivation: {
    silhouetteFrom: ['refuses help'],
    paletteFrom: ['duty'],
    note: 'The cowl is the refusal made visible; the rust is the lamp she keeps.',
  },
};

const CONTRASTING_VOICE = {
  register: 'poetic' as const,
  verbosity: 'rambling' as const,
  idiolect: ['liturgical phrases'],
  sentenceRhythm: 'looping' as const,
  humourMode: 'absurd' as const,
};

function useCase(...script: readonly Record<string, unknown>[]): {
  backend: FakeStructuredBackend;
  subject: GenerateCharacterSheetUseCase;
} {
  const backend = new FakeStructuredBackend({ script: script.map((body) => respondJson(body)) });
  return { backend, subject: new GenerateCharacterSheetUseCase(testDeps(backend)) };
}

describe('GenerateCharacterSheetUseCase', () => {
  it('produces a payload that satisfies the CHIRON-shaped contract', async () => {
    const { subject } = useCase(core(), VISUAL);
    const outcome = await subject.execute({
      context: outlineContext(),
      candidate: castCandidate(),
      style: styleBrief(),
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(CharacterPayload.safeParse(outcome.value.payload).success).toBe(true);
    const { psych } = outcome.value.payload;
    for (const field of [psych.want, psych.need, psych.wound, psych.lie, psych.ghost]) {
      expect(field.length).toBeGreaterThan(0);
    }
    expect(outcome.value.payload.voice.silenceHabits.length).toBeGreaterThan(0);
    expect(outcome.value.payload.motionSignature.idleBehaviour.length).toBeGreaterThan(0);
  });

  it('leaves the wardrobe, expressions and poses empty for the states use-case to fill', async () => {
    const { subject } = useCase(core(), VISUAL);
    const outcome = await subject.execute({
      context: outlineContext(),
      candidate: castCandidate(),
      style: styleBrief(),
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.payload.visual.wardrobe).toEqual([]);
    expect(outcome.value.payload.visual.expressionSet).toEqual([]);
    expect(outcome.value.payload.visual.poseSet).toEqual([]);
    // And no turning points, because no beats exist to point at yet.
    expect(outcome.value.payload.arc.turningPoints).toEqual([]);
  });

  it("derives appearance from psychology: the second call is shown the first's output", async () => {
    const { backend, subject } = useCase(core(), VISUAL);
    await subject.execute({
      context: outlineContext(),
      candidate: castCandidate(),
      style: styleBrief(),
    });

    expect(backend.callCount).toBe(2);
    const visualPrompt = backend.userPromptAt(1);
    expect(visualPrompt).toContain(BASE.psych.wound);
    expect(visualPrompt).toContain(BASE.psych.lie);
    expect(visualPrompt).toContain('Gait: trudge');
    expect(visualPrompt).toContain('recognisable as a solid black shape at 64px');
    // And it is told not to design the things S3b owns.
    expect(visualPrompt).toContain('Do not design outfits, expressions or poses here');
  });

  it('records which psych traits drove the silhouette and the palette', async () => {
    const { subject } = useCase(core(), VISUAL);
    const outcome = await subject.execute({
      context: outlineContext(),
      candidate: castCandidate(),
      style: styleBrief(),
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.derivation.silhouetteFrom).toEqual(['refuses help']);
    expect(outcome.value.derivation.paletteFrom).toEqual(['duty']);
  });

  it('accepts a second voice that differs on enough axes', async () => {
    const { subject } = useCase(core(CONTRASTING_VOICE), VISUAL);
    const outcome = await subject.execute({
      context: outlineContext(),
      candidate: castCandidate({ name: 'Bijan' }),
      style: styleBrief(),
      existingCast: [{ name: 'Mahtab', voice: BASE.voice }],
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.regeneratedForDistinctness).toBe(false);
    expect(outcome.value.voiceComparisons[0]?.distinct).toBe(true);
  });

  it('regenerates once when the new voice is confusable with an existing one', async () => {
    const { backend, subject } = useCase(core(), core(CONTRASTING_VOICE), VISUAL);
    const outcome = await subject.execute({
      context: outlineContext(),
      candidate: castCandidate({ name: 'Bijan' }),
      style: styleBrief(),
      existingCast: [{ name: 'Mahtab', voice: BASE.voice }],
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.regeneratedForDistinctness).toBe(true);
    expect(backend.callCount).toBe(3);
    // The retry says who it collided with and what to change.
    const retryPrompt = backend.userPromptAt(1);
    expect(retryPrompt).toContain('sounded like "Mahtab"');
    expect(retryPrompt).toContain('Change at least 2');
  });

  it('refuses after one regeneration rather than shipping a chorus', async () => {
    const { subject } = useCase(core(), core(), VISUAL);
    const outcome = await subject.execute({
      context: outlineContext(),
      candidate: castCandidate({ name: 'Bijan' }),
      style: styleBrief(),
      existingCast: [{ name: 'Mahtab', voice: BASE.voice }],
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('conflict');
    expect(outcome.error.context).toMatchObject({
      reason: 'voice-not-distinct',
      against: ['Mahtab'],
    });
  });

  it('shows the writer the voices already in the cast', async () => {
    const { backend, subject } = useCase(core(CONTRASTING_VOICE), VISUAL);
    await subject.execute({
      context: outlineContext(),
      candidate: castCandidate({ name: 'Bijan' }),
      style: styleBrief(),
      existingCast: [{ name: 'Mahtab', voice: BASE.voice }],
    });

    const prompt = backend.userPromptAt(0);
    expect(prompt).toContain('Mahtab: colloquial/terse');
    expect(prompt).toContain('must not be confusable');
  });

  it('says so plainly when this is the first character', async () => {
    const { backend, subject } = useCase(core(), VISUAL);
    await subject.execute({
      context: outlineContext(),
      candidate: castCandidate(),
      style: styleBrief(),
    });
    expect(backend.userPromptAt(0)).toContain('none yet - this is the first');
  });

  it('surfaces a failed core call as a Result', async () => {
    const backend = new FakeStructuredBackend({ script: [respondError(), respondError()] });
    const outcome = await new GenerateCharacterSheetUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      candidate: castCandidate(),
      style: styleBrief(),
    });
    expect(isErr(outcome)).toBe(true);
  });

  it('surfaces a failed visual call as a Result', async () => {
    const backend = new FakeStructuredBackend({
      script: [respondJson(core()), respondError(), respondError()],
    });
    const outcome = await new GenerateCharacterSheetUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      candidate: castCandidate(),
      style: styleBrief(),
    });
    expect(isErr(outcome)).toBe(true);
  });

  it('surfaces a failed regeneration as a Result', async () => {
    const backend = new FakeStructuredBackend({
      script: [respondJson(core()), respondError(), respondError()],
    });
    const outcome = await new GenerateCharacterSheetUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      candidate: castCandidate({ name: 'Bijan' }),
      style: styleBrief(),
      existingCast: [{ name: 'Mahtab', voice: BASE.voice }],
    });
    expect(isErr(outcome)).toBe(true);
  });
});

describe('voice distinctness', () => {
  it('needs two axes, because one is a coin flip', () => {
    expect(MIN_DISTINCT_AXES).toBe(2);
    const oneAxis = { ...BASE.voice, verbosity: 'rambling' as const };
    expect(differingAxes(BASE.voice, oneAxis)).toEqual(['verbosity']);
    expect(
      collisions(compareAgainstCast(oneAxis, [{ name: 'Mahtab', voice: BASE.voice }])),
    ).toHaveLength(1);
  });

  it('treats idiolect as a set, so reordering it changes nothing', () => {
    const reordered = { ...BASE.voice, idiolect: [...BASE.voice.idiolect].reverse() };
    expect(differingAxes(BASE.voice, reordered)).toEqual([]);

    const different = { ...BASE.voice, idiolect: ['liturgical phrases'] };
    expect(differingAxes(BASE.voice, different)).toEqual(['idiolect']);

    const longer = { ...BASE.voice, idiolect: [...BASE.voice.idiolect, 'net-mending metaphors'] };
    expect(differingAxes(BASE.voice, longer)).toEqual(['idiolect']);
  });

  it('reports every comparison, not only the failures', () => {
    const comparisons = compareAgainstCast({ ...BASE.voice, ...CONTRASTING_VOICE }, [
      { name: 'Mahtab', voice: BASE.voice },
      { name: 'Roya', voice: { ...BASE.voice, register: 'formal' } },
    ]);
    expect(comparisons).toHaveLength(2);
    expect(comparisons.every((comparison) => comparison.distinct)).toBe(true);
  });

  it('finds no collisions in an empty cast', () => {
    expect(collisions(compareAgainstCast(BASE.voice, []))).toEqual([]);
  });
});

describe('styleBriefFrom', () => {
  it('reduces a locked bible to what a writing stage needs', () => {
    const brief = styleBriefFrom(styleBibleFixture());
    expect(brief.positiveFragment).toContain('gouache');
    expect(brief.characterFragment).toContain('silhouette');
    expect(brief.paletteNames).toContain('rust (accent)');
    expect(brief.silhouetteRule).toContain('64px');
    expect(brief.shapeNote).toContain('heads tall');
  });

  it('leaves the character fragment absent when the bible declares none', () => {
    const bible = styleBibleFixture();
    const withoutFragment = {
      ...bible,
      prompts: { ...bible.prompts, bySubject: {} },
      visual: {
        ...bible.visual,
        palette: {
          ...bible.visual.palette,
          // A colour with no declared role renders as a bare name.
          colors: bible.visual.palette.colors.map(({ name, hex }) => ({ name, hex })),
        },
      },
    };
    const brief = styleBriefFrom(withoutFragment);
    expect('characterFragment' in brief).toBe(false);
    expect(brief.paletteNames).toContain('rust');
  });
});
