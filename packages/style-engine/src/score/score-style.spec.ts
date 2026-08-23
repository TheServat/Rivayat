import { QualityScores } from '@rv/contracts';
import { ProviderError, isErr, isOk, ok as okResult } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  FakeRaster,
  FakeVisionPort,
  imagePayload,
  lockedBibleFrom,
  stripedImage,
} from '../__fixtures__/fakes';
import { STYLE_PRESETS } from '../presets/index';
import {
  ALPHA_KEY,
  IDENTITY_KEY,
  SILHOUETTE_KEY,
  STYLE_MATCH_KEY,
  buildStyleRubric,
} from './rubric';
import { ScoreStyleMatchUseCase } from './score-style';

function preset(id: string) {
  const found = STYLE_PRESETS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no preset ${id}`);
  return found;
}

const BIBLE = lockedBibleFrom(preset('paper-cutout'));

/** Exactly the palette the bible declares - the on-palette case. */
const ON_PALETTE = stripedImage([
  [0x4a, 0x6b, 0x3f],
  [0x5a, 0x46, 0x32],
  [0xe8, 0xdd, 0xc8],
]);

/** A colour the style never declared. */
const OFF_PALETTE = stripedImage([[0xff, 0x00, 0xff]]);

function subject(options: { vision?: FakeVisionPort; raster?: FakeRaster }): {
  useCase: ScoreStyleMatchUseCase;
  vision: FakeVisionPort;
} {
  const vision = options.vision ?? new FakeVisionPort({ score: 0.8 });
  const raster = options.raster ?? new FakeRaster([okResult(ON_PALETTE)]);
  return { useCase: new ScoreStyleMatchUseCase({ vision, raster }), vision };
}

describe('the style rubric', () => {
  it('asks about the style in the style’s own words', () => {
    const rubric = buildStyleRubric(BIBLE);
    const styleMatch = rubric.find((criterion) => criterion.key === STYLE_MATCH_KEY);
    expect(styleMatch?.question).toContain('cut-paper');
    expect(styleMatch?.question).toContain('flat shading');
    expect(styleMatch?.question).toContain('no outlines');

    const silhouette = rubric.find((criterion) => criterion.key === SILHOUETTE_KEY);
    expect(silhouette?.question).toContain(BIBLE.visual.shape.silhouetteRule);
  });

  it('never asks a model about the palette', () => {
    // Palette adherence is a distance computation. Paying a model for an opinion about
    // it buys a worse answer that also moves between runs.
    const questions = buildStyleRubric(BIBLE, { withIdentity: true })
      .map((criterion) => criterion.question.toLowerCase())
      .join(' ');
    expect(questions).not.toContain('palette');
    expect(buildStyleRubric(BIBLE).map((criterion) => criterion.key)).toEqual([
      STYLE_MATCH_KEY,
      SILHOUETTE_KEY,
      ALPHA_KEY,
    ]);
  });

  it('adds the identity criterion only when there is something to compare against', () => {
    expect(buildStyleRubric(BIBLE).map((criterion) => criterion.key)).not.toContain(IDENTITY_KEY);
    expect(
      buildStyleRubric(BIBLE, { withIdentity: true }).map((criterion) => criterion.key),
    ).toContain(IDENTITY_KEY);
  });

  it('describes a custom medium from its note', () => {
    const custom = {
      ...BIBLE,
      visual: {
        ...BIBLE.visual,
        medium: 'custom' as const,
        mediumNote: 'scratchboard, white line cut from black ink',
      },
    };
    expect(buildStyleRubric(custom)[0]?.question).toContain('scratchboard');
  });

  it('describes line weight in words at each end of the range', () => {
    const heavy = {
      ...BIBLE,
      visual: { ...BIBLE.visual, line: { ...BIBLE.visual.line, present: true, weight: 0.9 } },
    };
    const medium = {
      ...BIBLE,
      visual: { ...BIBLE.visual, line: { ...BIBLE.visual.line, present: true, weight: 0.5 } },
    };
    const fine = {
      ...BIBLE,
      visual: { ...BIBLE.visual, line: { ...BIBLE.visual.line, present: true, weight: 0.2 } },
    };
    expect(buildStyleRubric(heavy)[0]?.question).toContain('a heavy weight');
    expect(buildStyleRubric(medium)[0]?.question).toContain('a medium weight');
    expect(buildStyleRubric(fine)[0]?.question).toContain('a fine weight');
  });
});

describe('ScoreStyleMatchUseCase', () => {
  it('produces the QualityScores shape the asset pipeline already expects', async () => {
    const { useCase } = subject({});
    const result = await useCase.execute({
      bible: BIBLE,
      image: imagePayload('asset'),
      partCompleteness: 1,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(() => QualityScores.parse(result.value.scores)).not.toThrow();
    expect(result.value.scores.identityMatch).toBeUndefined();
    expect(result.value.scores.partCompleteness).toBe(1);
  });

  it('measures palette adherence from the pixels and folds it into the style score', async () => {
    const { useCase } = subject({});
    const result = await useCase.execute({
      bible: BIBLE,
      image: imagePayload('asset'),
      partCompleteness: 1,
    });
    if (!isOk(result)) throw new Error('expected ok');

    expect(result.value.paletteAdherence.score).toBe(1);
    expect(result.value.paletteAdherence.sampled).toBeGreaterThan(0);
    // 0.6 * 0.8 (the model) + 0.4 * 1.0 (measured).
    expect(result.value.scores.styleMatch).toBeCloseTo(0.88, 4);
  });

  it('lets a measured palette failure pull the score down even when the model approves', async () => {
    // The whole reason the measurement is not delegated: a model that likes the picture
    // cannot overrule the pixels.
    const { useCase } = subject({
      vision: new FakeVisionPort({ score: 1 }),
      raster: new FakeRaster([okResult(OFF_PALETTE)]),
    });
    const result = await useCase.execute({
      bible: BIBLE,
      image: imagePayload('asset'),
      partCompleteness: 1,
    });
    if (!isOk(result)) throw new Error('expected ok');

    expect(result.value.paletteAdherence.score).toBe(0);
    expect(result.value.paletteAdherence.offPaletteShare).toBe(1);
    expect(result.value.scores.styleMatch).toBeCloseTo(0.6, 4);
    expect(result.value.scores.overall).toBeLessThan(1);
  });

  it('counts the organic ramp as on-palette', async () => {
    // Excluding it would fail every character in the series for having a face.
    const skin = stripedImage([[0xe2, 0xb4, 0x8c]]);
    const { useCase } = subject({ raster: new FakeRaster([okResult(skin)]) });
    const result = await useCase.execute({
      bible: BIBLE,
      image: imagePayload('face'),
      partCompleteness: 1,
    });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.paletteAdherence.score).toBe(1);
  });

  it('scores identity when anchors are supplied and passes them to the port', async () => {
    const { useCase, vision } = subject({});
    const references = [imagePayload('turnaround')];
    const result = await useCase.execute({
      bible: BIBLE,
      image: imagePayload('asset'),
      references,
      partCompleteness: 0.75,
    });

    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.scores.identityMatch).toBe(0.8);
    expect(vision.requests[0]?.references).toEqual(references);
    expect(vision.requests[0]?.rubric.map((criterion) => criterion.key)).toContain(IDENTITY_KEY);
  });

  it('lets partCompleteness move the overall score', async () => {
    const whole = await subject({}).useCase.execute({
      bible: BIBLE,
      image: imagePayload('a'),
      partCompleteness: 1,
    });
    const partial = await subject({}).useCase.execute({
      bible: BIBLE,
      image: imagePayload('a'),
      partCompleteness: 0.25,
    });
    if (!isOk(whole) || !isOk(partial)) throw new Error('expected ok');
    expect(partial.value.scores.overall).toBeLessThan(whole.value.scores.overall);
  });

  it('is deterministic for the same image and bible', async () => {
    const first = await subject({}).useCase.execute({
      bible: BIBLE,
      image: imagePayload('a'),
      partCompleteness: 1,
    });
    const second = await subject({}).useCase.execute({
      bible: BIBLE,
      image: imagePayload('a'),
      partCompleteness: 1,
    });
    if (!isOk(first) || !isOk(second)) throw new Error('expected ok');
    expect(first.value.scores).toEqual(second.value.scores);
  });

  it('keeps the model’s reasons alongside the numbers', async () => {
    const result = await subject({}).useCase.execute({
      bible: BIBLE,
      image: imagePayload('a'),
      partCompleteness: 1,
    });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.vision).toHaveLength(3);
    expect(result.value.vision[0]?.reason.length).toBeGreaterThan(0);
    expect(result.value.modelRef).toBe('ollama:qwen3.5:latest');
    expect(result.value.usage.tokens.input).toBe(500);
  });
});

describe('ScoreStyleMatchUseCase, failures', () => {
  it('refuses an out-of-range partCompleteness', async () => {
    for (const value of [-0.1, 1.5]) {
      const result = await subject({}).useCase.execute({
        bible: BIBLE,
        image: imagePayload('a'),
        partCompleteness: value,
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.context).toMatchObject({ partCompleteness: value });
    }
  });

  it('fails rather than guessing when the image cannot be decoded', async () => {
    // There is no model-based fallback for palette adherence on purpose.
    const { useCase } = subject({
      raster: new FakeRaster([
        { ok: false, error: new ProviderError({ provider: 'sharp', message: 'corrupt png' }) },
      ]),
    });
    const result = await useCase.execute({
      bible: BIBLE,
      image: imagePayload('a'),
      partCompleteness: 1,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.kind).toBe('provider');
  });

  it('propagates a scorer failure', async () => {
    const { useCase } = subject({
      vision: new FakeVisionPort({
        failure: new ProviderError({ provider: 'ollama', message: 'model not loaded' }),
      }),
    });
    const result = await useCase.execute({
      bible: BIBLE,
      image: imagePayload('a'),
      partCompleteness: 1,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.kind).toBe('provider');
  });

  it('says an unanswered criterion was unanswered instead of scoring it', async () => {
    // Scoring a missing answer 0 fails good assets and scoring it 1 passes bad ones.
    const { useCase } = subject({ vision: new FakeVisionPort({ omit: [ALPHA_KEY] }) });
    const result = await useCase.execute({
      bible: BIBLE,
      image: imagePayload('a'),
      partCompleteness: 1,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.context).toMatchObject({ missing: [ALPHA_KEY] });
  });
});
