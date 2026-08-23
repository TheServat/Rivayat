/**
 * The owner's explicit requirement, tested against its own standard.
 *
 * "A character with three expressions and one outfit is a failure of this use-case, not of
 * the artist." So the tests assert the counts, the uniqueness of the slugs that become
 * asset variant keys, and that every description is a prompt an image model could actually
 * be handed - not a label.
 */

import { describe, expect, it } from 'vitest';
import { isErr } from '@rv/shared-kernel';

import { FakeStructuredBackend, respondError, respondJson } from '../__fixtures__/fakes';
import { characterPayload, styleBrief, testDeps } from '../__fixtures__/builders';
import {
  GenerateCharacterStatesUseCase,
  MAX_VARIANT_DEMAND,
  STATE_MINIMA,
  buildVariantDemand,
  variantKeyFor,
} from './generate-character-states';
import { composeStatePrompt, renderCharacterDescriptor } from './state-prompt';

function state(slug: string): Record<string, unknown> {
  return {
    slug,
    label: slug.replace(/-/gu, ' '),
    body: `Brow low, jaw set, weight on the back foot; hands flat against the wall for ${slug}.`,
    intensity: 0.7,
  };
}

function outfit(slug: string): Record<string, unknown> {
  return {
    slug,
    label: slug.replace(/-/gu, ' '),
    description: `Oiled canvas over a knitted underlayer, salt-stiff at the cuffs, for ${slug}.`,
    validity: { from: null, until: null },
    palette: [],
  };
}

const EXPRESSION_SLUGS = [
  'cornered',
  'unimpressed',
  'stricken',
  'guarded',
  'furious',
  'exhausted',
  'humiliated',
  'relieved',
];
const POSE_SLUGS = [
  'braced',
  'turning-away',
  'reaching',
  'kneeling',
  'blocking-the-door',
  'listening',
];
const OUTFIT_SLUGS = ['wardrobe-working', 'wardrobe-mourning'];

function fullSet(
  expressions = EXPRESSION_SLUGS,
  poses = POSE_SLUGS,
  outfits = OUTFIT_SLUGS,
): Record<string, unknown> {
  return {
    expressions: expressions.map(state),
    poses: poses.map(state),
    wardrobe: outfits.map(outfit),
  };
}

function runWith(...script: readonly Record<string, unknown>[]): {
  backend: FakeStructuredBackend;
  execute: () => ReturnType<GenerateCharacterStatesUseCase['execute']>;
} {
  const backend = new FakeStructuredBackend({ script: script.map((body) => respondJson(body)) });
  const useCase = new GenerateCharacterStatesUseCase(testDeps(backend));
  return {
    backend,
    execute: () =>
      useCase.execute({
        name: 'Mahtab',
        payload: characterPayload(),
        style: styleBrief(),
        characterSlug: 'mahtab',
      }),
  };
}

describe('GenerateCharacterStatesUseCase', () => {
  it('yields a usable set: enough distinct expressions, poses and outfits', async () => {
    const outcome = await runWith(fullSet()).execute();

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.expressionSet.length).toBeGreaterThanOrEqual(STATE_MINIMA.expressions);
    expect(outcome.value.poseSet.length).toBeGreaterThanOrEqual(STATE_MINIMA.poses);
    expect(outcome.value.wardrobe.length).toBeGreaterThanOrEqual(STATE_MINIMA.wardrobe);
    expect(outcome.value.toppedUp).toBe(false);
  });

  it('gives every state a unique slug, because a slug is half an asset variant key', async () => {
    const outcome = await runWith(fullSet()).execute();
    if (isErr(outcome)) throw new Error(outcome.error.message);

    const slugs = [
      ...outcome.value.expressionSet.map((entry) => entry.slug),
      ...outcome.value.poseSet.map((entry) => entry.slug),
    ];
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(outcome.value.wardrobe.map((entry) => entry.slug)).size).toBe(
      outcome.value.wardrobe.length,
    );
  });

  it('makes every description a real prompt, not a label', async () => {
    const outcome = await runWith(fullSet()).execute();
    if (isErr(outcome)) throw new Error(outcome.error.message);

    for (const entry of [...outcome.value.expressionSet, ...outcome.value.poseSet]) {
      expect(entry.description.trim().length).toBeGreaterThan(80);
      // The style clause is in every one of them, unconditionally.
      expect(entry.description).toContain('gouache on cold-pressed paper');
      // And so is the character, so the image model knows who it is drawing.
      expect(entry.description).toContain('Silhouette:');
      expect(entry.description).toContain('Never include');
    }
  });

  it('frames an expression and a pose differently', async () => {
    const outcome = await runWith(fullSet()).execute();
    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.expressionSet[0]?.description).toContain('Facial expression');
    expect(outcome.value.poseSet[0]?.description).toContain('Full-body pose');
  });

  it('computes the cartesian demand with a deterministic key per combination', async () => {
    const outcome = await runWith(fullSet()).execute();
    if (isErr(outcome)) throw new Error(outcome.error.message);

    const expected = OUTFIT_SLUGS.length * (EXPRESSION_SLUGS.length + POSE_SLUGS.length);
    expect(outcome.value.variants).toHaveLength(expected);
    expect(new Set(outcome.value.variants.map((entry) => entry.variantKey)).size).toBe(expected);

    const one = outcome.value.variants.find(
      (entry) => entry.wardrobeSlug === 'wardrobe-mourning' && entry.stateSlug === 'cornered',
    );
    expect(one?.variantKey).toBe('wardrobe-mourning-cornered');
    expect(one?.semanticKey).toBe('char/mahtab/expression');
    expect(one?.prompt).toContain('salt-stiff at the cuffs');
  });

  it('tops up a short set with a second, targeted call', async () => {
    const short = fullSet(EXPRESSION_SLUGS.slice(0, 4), POSE_SLUGS.slice(0, 2), [
      'wardrobe-working',
    ]);
    const topUp = {
      expressions: EXPRESSION_SLUGS.slice(4).map(state),
      poses: POSE_SLUGS.slice(2).map(state),
      wardrobe: [outfit('wardrobe-mourning')],
    };
    const { backend, execute } = runWith(short, topUp);
    const outcome = await execute();

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(backend.callCount).toBe(2);
    expect(outcome.value.toppedUp).toBe(true);
    expect(outcome.value.expressionSet).toHaveLength(EXPRESSION_SLUGS.length);
    // The top-up prompt names what is missing and what already exists.
    const prompt = backend.userPromptAt(1);
    expect(prompt).toContain('more expression(s)');
    expect(prompt).toContain('cornered');
  });

  it('fails rather than shipping a character with three expressions', async () => {
    const short = fullSet(['cornered', 'guarded', 'stricken'], POSE_SLUGS, OUTFIT_SLUGS);
    const outcome = await runWith(short, short).execute();

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'insufficient-states', expressions: 3 });
  });

  it('drops a repeated slug rather than renaming it, and says which it dropped', async () => {
    const withDuplicate = fullSet([...EXPRESSION_SLUGS, 'cornered'], POSE_SLUGS, OUTFIT_SLUGS);
    const outcome = await runWith(withDuplicate).execute();

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.droppedDuplicateSlugs).toContain('cornered');
    expect(outcome.value.expressionSet).toHaveLength(EXPRESSION_SLUGS.length);
  });

  it('keeps a pose from colliding with an expression of the same name', async () => {
    const collide = fullSet(EXPRESSION_SLUGS, [...POSE_SLUGS, 'guarded'], OUTFIT_SLUGS);
    const outcome = await runWith(collide).execute();

    if (isErr(outcome)) throw new Error(outcome.error.message);
    const all = [
      ...outcome.value.expressionSet.map((entry) => entry.slug),
      ...outcome.value.poseSet.map((entry) => entry.slug),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(outcome.value.droppedDuplicateSlugs).toContain('guarded');
  });

  it('hands back a visual block ready to merge into the character sheet', async () => {
    const outcome = await runWith(fullSet()).execute();
    if (isErr(outcome)) throw new Error(outcome.error.message);

    expect(outcome.value.visual.silhouetteNote).toBe(characterPayload().visual.silhouetteNote);
    expect(outcome.value.visual.expressionSet).toBe(outcome.value.expressionSet);
    expect(outcome.value.visual.wardrobe).toHaveLength(OUTFIT_SLUGS.length);
  });

  it('produces one full-body reference per outfit', async () => {
    const outcome = await runWith(fullSet()).execute();
    if (isErr(outcome)) throw new Error(outcome.error.message);

    expect(outcome.value.wardrobeStates).toHaveLength(OUTFIT_SLUGS.length);
    expect(outcome.value.wardrobeStates[0]?.description).toContain('Full-body reference');
  });

  it('slugs a name that has no ASCII in it rather than emitting an illegal key', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(fullSet())] });
    const outcome = await new GenerateCharacterStatesUseCase(testDeps(backend)).execute({
      name: 'مهتاب',
      payload: characterPayload(),
      style: styleBrief(),
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.characterSlug).toBe('character');
    expect(outcome.value.variants[0]?.semanticKey).toBe('char/character/expression');
  });

  it('surfaces a failed call as a Result', async () => {
    const backend = new FakeStructuredBackend({ script: [respondError(), respondError()] });
    const outcome = await new GenerateCharacterStatesUseCase(testDeps(backend)).execute({
      name: 'Mahtab',
      payload: characterPayload(),
      style: styleBrief(),
    });
    expect(isErr(outcome)).toBe(true);
  });

  it('surfaces a failed top-up call as a Result', async () => {
    const short = fullSet(EXPRESSION_SLUGS.slice(0, 2), POSE_SLUGS, OUTFIT_SLUGS);
    const backend = new FakeStructuredBackend({
      script: [respondJson(short), respondError(), respondError()],
    });
    const outcome = await new GenerateCharacterStatesUseCase(testDeps(backend)).execute({
      name: 'Mahtab',
      payload: characterPayload(),
      style: styleBrief(),
    });
    expect(isErr(outcome)).toBe(true);
  });

  it('shows the art director the psychology every state has to answer to', async () => {
    const { backend, execute } = runWith(fullSet());
    await execute();
    const prompt = backend.userPromptAt(0);
    expect(prompt).toContain('Want:');
    expect(prompt).toContain('Wound:');
    expect(prompt).toContain('recognisable as a solid black shape at 64px');
    expect(prompt).toContain(`At least ${String(STATE_MINIMA.expressions)} expressions.`);
  });
});

describe('variant keys and demand', () => {
  it('always produces the same key for the same combination', () => {
    expect(variantKeyFor('wardrobe-winter', 'cornered')).toBe('wardrobe-winter-cornered');
    expect(variantKeyFor('wardrobe-winter', 'cornered')).toBe(
      variantKeyFor('wardrobe-winter', 'cornered'),
    );
  });

  it('refuses a demand that would blow past the ceiling', () => {
    const many = Array.from({ length: 32 }, (_, index) => ({
      slug: `state-${String(index)}`,
      label: `state ${String(index)}`,
      body: 'Brow low.',
      intensity: 0.5,
    }));
    const outfits = Array.from({ length: 8 }, (_, index) => ({
      slug: `wardrobe-${String(index)}`,
      label: `outfit ${String(index)}`,
      description: 'Canvas.',
      validity: { from: null, until: null },
      palette: [],
    }));

    const outcome = buildVariantDemand({
      characterSlug: 'mahtab',
      style: styleBrief(),
      descriptor: {
        name: 'Mahtab',
        visual: characterPayload().visual,
        species: 'human',
        age: '54',
      },
      wardrobe: outfits,
      expressions: many,
      poses: many,
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({
      reason: 'variant-demand-too-large',
      ceiling: MAX_VARIANT_DEMAND,
    });
  });
});

describe('composeStatePrompt', () => {
  const descriptor = {
    name: 'Mahtab',
    visual: characterPayload().visual,
    species: 'human',
    age: '54',
  };

  it('puts the style first, then who this is, then what they are doing', () => {
    const prompt = composeStatePrompt({
      style: styleBrief(),
      descriptor,
      wardrobe: { label: 'working oilskin', description: 'Salt-stiff canvas.' },
      label: 'cornered',
      body: 'Chin down, weight on the back foot.',
      intensity: 0.85,
      framing: 'Facial expression',
    });

    expect(prompt.indexOf('gouache')).toBeLessThan(prompt.indexOf('Mahtab'));
    expect(prompt.indexOf('Mahtab')).toBeLessThan(prompt.indexOf('cornered'));
    expect(prompt).toContain('working oilskin');
    expect(prompt).toContain('0.85');
  });

  it('omits the wardrobe block entirely when no outfit is bound', () => {
    const prompt = composeStatePrompt({
      style: styleBrief(),
      descriptor,
      label: 'cornered',
      body: 'Chin down.',
      intensity: 0.5,
      framing: 'Facial expression',
    });
    expect(prompt).not.toContain('## Wearing');
  });

  it('names the identifying features an image model needs to keep steady', () => {
    expect(renderCharacterDescriptor(descriptor)).toContain('rope burn across the right palm');
    expect(renderCharacterDescriptor(descriptor)).toContain('rust #8a3b1e');
  });
});
