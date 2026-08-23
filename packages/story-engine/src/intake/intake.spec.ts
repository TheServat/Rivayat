/**
 * S0, all five front doors.
 *
 * RV-080's acceptance criterion is that every kind produces a brief that parses, so the
 * table-driven test is the point rather than a shortcut: the value of a polymorphic intake
 * is exactly that the five converge, and a test that only exercised `idea` would prove
 * nothing about that.
 */

import { describe, expect, it } from 'vitest';
import { BRIEF_KINDS, type BriefKind } from '@rv/contracts';
import { isErr } from '@rv/shared-kernel';

import {
  FakeStructuredBackend,
  type ScriptedResponse,
  respondError,
  respondJson,
  respondText,
} from '../__fixtures__/fakes';
import { brief, normalisedDraft, testDeps } from '../__fixtures__/builders';
import { chunkSource } from './compress';
import { NormalisedBrief } from './normalised-brief';
import {
  IdeaIntakeUseCase,
  IntakeUseCase,
  LoglineIntakeUseCase,
  ProseIntakeUseCase,
  ScriptIntakeUseCase,
  SeriesBibleIntakeUseCase,
  renderBibleOutline,
} from './intake';

describe('IntakeUseCase across all five kinds', () => {
  it.each(BRIEF_KINDS)('normalises a %s brief into something that parses', async (kind) => {
    const backend = new FakeStructuredBackend({ script: [respondJson(normalisedDraft())] });
    const outcome = await new IntakeUseCase(testDeps(backend)).execute({ brief: brief(kind) });

    if (isErr(outcome)) throw new Error(`${kind}: ${outcome.error.message}`);
    expect(NormalisedBrief.safeParse(outcome.value.brief).success).toBe(true);
    expect(outcome.value.brief.sourceKind).toBe(kind);
    expect(outcome.value.brief.castCandidates.length).toBeGreaterThan(0);
    expect(outcome.value.traces).toHaveLength(1);
  });

  it('carries the envelope decisions across rather than asking the model to restate them', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(normalisedDraft())] });
    const outcome = await new IntakeUseCase(testDeps(backend)).execute({ brief: brief('idea') });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.brief.language).toBe('fa');
    expect(outcome.value.brief.targetEpisodeDurationMs).toBe(420_000);
    expect(outcome.value.brief.plannedEpisodeCount).toBe(6);
  });
});

describe('IdeaIntakeUseCase', () => {
  it('preserves a Persian idea verbatim and keeps any translation additive', async () => {
    const persian = brief('idea');
    const backend = new FakeStructuredBackend({ script: [respondJson(normalisedDraft())] });
    const outcome = await new IdeaIntakeUseCase(testDeps(backend)).execute({
      brief: persian as Extract<typeof persian, { kind: 'idea' }>,
      settings: { translation: 'A fox in the city who keeps the lighthouse' },
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.brief.language).toBe('fa');
    expect(outcome.value.brief.sourceText).toBe('یک روباه در شهر که فانوس دریایی را نگه می‌دارد');
    expect(outcome.value.brief.translation).toBe('A fox in the city who keeps the lighthouse');
  });

  it('leaves translation absent rather than empty when none was supplied', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(normalisedDraft())] });
    const source = brief('idea');
    const outcome = await new IdeaIntakeUseCase(testDeps(backend)).execute({
      brief: source as Extract<typeof source, { kind: 'idea' }>,
      settings: { translation: '   ' },
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.brief.translation).toBeUndefined();
  });

  it('warns the producer that almost everything has to be invented', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(normalisedDraft())] });
    const source = brief('idea');
    await new IdeaIntakeUseCase(testDeps(backend)).execute({
      brief: source as Extract<typeof source, { kind: 'idea' }>,
    });

    const prompt = backend.userPromptAt(0);
    expect(prompt).toContain('invented rather than extracted');
    expect(prompt).toContain('Persian-speaking adults');
    expect(prompt).toContain('visible blood');
    expect(prompt).toContain('1 season(s) of 6 episode(s)');
  });
});

describe('LoglineIntakeUseCase', () => {
  it('tells the producer the four elements are already chosen', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(normalisedDraft())] });
    const source = brief('logline');
    const outcome = await new LoglineIntakeUseCase(testDeps(backend)).execute({
      brief: source as Extract<typeof source, { kind: 'logline' }>,
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(backend.userPromptAt(0)).toContain('Keep all four exactly as stated');
    expect(outcome.value.brief.compression.strategy).toBe('verbatim');
  });
});

describe('ScriptIntakeUseCase', () => {
  it('reads a short script whole and reports that nothing was dropped', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(normalisedDraft())] });
    const source = brief('script');
    const outcome = await new ScriptIntakeUseCase(testDeps(backend)).execute({
      brief: source as Extract<typeof source, { kind: 'script' }>,
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.brief.compression).toMatchObject({ strategy: 'verbatim', chunkCount: 0 });
    expect(backend.callCount).toBe(1);
    expect(backend.userPromptAt(0)).toContain('fountain format');
  });

  it('compresses a long script rather than truncating it', async () => {
    const text = buildLongScript(30);
    const long = brief('script', { script: text });
    const backend = new FakeStructuredBackend({
      script: digestScriptFor(text, 5_000),
    });
    const outcome = await new ScriptIntakeUseCase(testDeps(backend)).execute({
      brief: long as Extract<typeof long, { kind: 'script' }>,
      settings: { tokenCeiling: 1_000, charsPerToken: 4, window: { windowChars: 5_000 } },
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.brief.compression.strategy).toBe('chunked-digest');
    expect(outcome.value.brief.compression.chunkCount).toBeGreaterThan(1);
    // The last passage reached the digest pass - a truncation would have dropped it.
    const lastDigestPrompt = backend.userPromptAt(backend.callCount - 2);
    expect(lastDigestPrompt).toContain('SCENE 30');
  });

  it('surfaces a compression failure rather than falling back to a prefix', async () => {
    const long = brief('script', { script: buildLongScript(30) });
    const backend = new FakeStructuredBackend({ script: [respondError(), respondError()] });
    const outcome = await new ScriptIntakeUseCase(testDeps(backend)).execute({
      brief: long as Extract<typeof long, { kind: 'script' }>,
      settings: { tokenCeiling: 100, window: { windowChars: 5_000 } },
    });
    expect(isErr(outcome)).toBe(true);
  });
});

describe('ProseIntakeUseCase', () => {
  it("names the excerpt's source work in the digest prompt", async () => {
    const text = buildLongProse(40);
    const long = brief('prose', { prose: text });
    const backend = new FakeStructuredBackend({ script: digestScriptFor(text, 8_000) });
    const source = long as Extract<typeof long, { kind: 'prose' }>;
    const outcome = await new ProseIntakeUseCase(testDeps(backend)).execute({
      brief: source,
      settings: { tokenCeiling: 1_000, window: { windowChars: 8_000 } },
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(backend.userPromptAt(0)).toContain('excerpt from "The Shoal Villages"');
    expect(outcome.value.brief.castCandidates.length).toBeGreaterThan(0);
    expect(outcome.value.brief.compression.ratio).toBeGreaterThan(1);
    expect(outcome.value.brief.compression.note).not.toBe('');
  });

  it('keeps only the first 20 000 characters of the source verbatim', async () => {
    const text = buildLongProse(60);
    const long = brief('prose', { prose: text });
    const backend = new FakeStructuredBackend({ script: digestScriptFor(text, 20_000) });
    const source = long as Extract<typeof long, { kind: 'prose' }>;
    const outcome = await new ProseIntakeUseCase(testDeps(backend)).execute({
      brief: source,
      settings: { tokenCeiling: 1_000, window: { windowChars: 20_000 } },
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.brief.sourceText.length).toBeLessThanOrEqual(20_000);
    expect(outcome.value.brief.sourceText.startsWith('The lamp had been out')).toBe(true);
  });

  it('tells the producer it is reading digests, not the work', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(normalisedDraft())] });
    const source = brief('prose');
    await new ProseIntakeUseCase(testDeps(backend)).execute({
      brief: source as Extract<typeof source, { kind: 'prose' }>,
    });
    expect(backend.userPromptAt(0)).toContain('Treat the digests as evidence, not as the work');
  });
});

describe('SeriesBibleIntakeUseCase', () => {
  it('copies premise, themes, tone and genre across verbatim instead of paraphrasing them', async () => {
    // The model returns a *different* premise. The imported bible's must win.
    const backend = new FakeStructuredBackend({
      script: [
        respondJson(
          normalisedDraft({
            premise: 'Something the model made up.',
            themes: ['invented'],
            tone: ['invented'],
            genre: ['invented'],
          }),
        ),
      ],
    });
    const source = brief('series-bible');
    const outcome = await new SeriesBibleIntakeUseCase(testDeps(backend)).execute({
      brief: source as Extract<typeof source, { kind: 'series-bible' }>,
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.brief.premise).toContain('lighthouse keeper who refuses to believe');
    expect(outcome.value.brief.themes).toEqual(['inherited guilt']);
    expect(outcome.value.brief.tone).toEqual(['melancholy']);
    expect(outcome.value.brief.genre).toEqual(['folk horror']);
    expect(outcome.value.brief.workingTitle).toBe('The Keeper and the Tide');
  });

  it('shows the producer the outline down to episode loglines and no further', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(normalisedDraft())] });
    const source = brief('series-bible');
    await new SeriesBibleIntakeUseCase(testDeps(backend)).execute({
      brief: source as Extract<typeof source, { kind: 'series-bible' }>,
    });

    const prompt = backend.userPromptAt(0);
    expect(prompt).toContain('## Season 1: Season one');
    expect(prompt).toContain('1. The wick (draft) - Mahtab relights the lamp');
    // Acts and below are not rendered.
    expect(prompt).not.toContain('Act one');
  });
});

describe('renderBibleOutline', () => {
  it('names the world rules a later stage may not break', () => {
    const source = brief('series-bible') as Extract<
      ReturnType<typeof brief>,
      { kind: 'series-bible' }
    >;
    const rendered = renderBibleOutline(source.bible);
    expect(rendered).toContain('[metaphysics] The dead do not speak.');
  });
});

describe('a normalised brief that cannot be assembled', () => {
  it('comes back as a Result rather than throwing', async () => {
    const backend = new FakeStructuredBackend({
      // Every attempt fails validation: no cast candidates at all.
      script: [
        respondJson({ ...normalisedDraft(), castCandidates: [] }),
        respondText('sorry'),
        respondJson({ ...normalisedDraft(), castCandidates: [] }),
      ],
    });
    const outcome = await new IntakeUseCase(testDeps(backend)).execute({ brief: brief('idea') });
    expect(isErr(outcome)).toBe(true);
  });

  it('rejects a translation that is too long to store', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(normalisedDraft())] });
    const source = brief('idea');
    const outcome = await new IdeaIntakeUseCase(testDeps(backend)).execute({
      brief: source as Extract<typeof source, { kind: 'idea' }>,
      settings: { translation: 'x'.repeat(20_001) },
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ paths: ['translation'] });
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function buildLongScript(scenes: number): string {
  return Array.from(
    { length: scenes },
    (_, index) =>
      `INT. SCENE ${String(index + 1)} - NIGHT\n\n` +
      `MAHTAB climbs the stair for the ${String(index + 1)}th time. ` +
      'The glass is cold and the wick will not take. '.repeat(20),
  ).join('\n\n');
}

function buildLongProse(paragraphs: number): string {
  return [
    'The lamp had been out for an hour before she noticed, which was the first wrong thing.',
    ...Array.from(
      { length: paragraphs },
      (_, index) =>
        `Paragraph ${String(index + 1)}. ` +
        'She went up the stair and the salt came with her, as it always did. '.repeat(30),
    ),
  ].join('\n\n');
}

/**
 * One digest per window the compressor will actually cut, then the normalisation answer.
 *
 * The chunk count is derived from `chunkSource` rather than guessed, so the script cannot
 * silently fall out of step with the windowing and leave the last passage unread - which
 * is the exact failure the compressor exists to prevent.
 */
function digestScriptFor(source: string, windowChars: number): ScriptedResponse[] {
  const chunks = chunkSource(source, { windowChars });
  return [
    ...chunks.map((chunk) => respondJson(digest(chunk.ordinal))),
    respondJson(normalisedDraft()),
  ];
}

function digest(ordinal: number): Record<string, unknown> {
  return {
    synopsis: `Passage ${String(ordinal)}: she climbs, the wick fails, something answers.`,
    events: [`She reaches the lamp room in passage ${String(ordinal)}.`],
    charactersSeen: ['Mahtab'],
    placesSeen: ['The lamp room'],
    promisesPlanted: ['The voice knows something it should not.'],
    promisesPaid: [],
    droppedNote: 'The weather digressions and the inventory of the store room.',
  };
}

// A kind that does not exist is not representable; this keeps the union exhaustive check
// honest if a sixth door is added without an intake use-case.
const _EXHAUSTIVE: readonly BriefKind[] = BRIEF_KINDS;
void _EXHAUSTIVE;
