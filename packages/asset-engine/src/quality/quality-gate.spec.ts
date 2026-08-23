import { describe, expect, it } from 'vitest';
import { ProviderError, isErr, unwrap } from '@rv/shared-kernel';

import { FakeVisionPort } from '../__fixtures__/doubles';
import { specFor, styleBible, threeBlobSpec } from '../__fixtures__/builders';
import {
  ALPHA_CLEANLINESS,
  IDENTITY_MATCH,
  PART_COMPLETENESS,
  SILHOUETTE,
  STYLE_MATCH,
  buildRubric,
  mergeMeasuredScores,
} from './rubric';
import { DEFAULT_THRESHOLDS, QualityGateUseCase } from './quality-gate';

const IMAGE = { mimeType: 'image/png', data: Uint8Array.from([1, 2, 3]) };
const PERFECT = { alphaCleanliness: 1, partCompleteness: 1 };

describe('the rubric', () => {
  it('derives its questions from the style, not from a fixed string', () => {
    const paperCutout = buildRubric(styleBible(), specFor('tree'));
    const styleQuestion =
      paperCutout.find((criterion) => criterion.key === STYLE_MATCH)?.question ?? '';

    expect(styleQuestion).toContain('paper-cutout');
    expect(styleQuestion).toContain('cel');
    expect(styleQuestion).toContain('#4a6b3f');
    expect(styleQuestion).toContain('photorealism');
  });

  it('names a custom medium by its note, because the enum cannot', () => {
    const style = styleBible({
      visual: {
        ...styleBible().visual,
        medium: 'custom',
        mediumNote: 'scratchboard on clay-coated card',
      },
    });
    expect(buildRubric(style, specFor('tree'))[0]?.question).toContain('scratchboard');
  });

  it('describes the line weight in words the model can act on', () => {
    const heavy = styleBible({
      visual: { ...styleBible().visual, line: { ...styleBible().visual.line, weight: 0.9 } },
    });
    const none = styleBible({
      visual: { ...styleBible().visual, line: { ...styleBible().visual.line, present: false } },
    });

    expect(buildRubric(heavy, specFor('tree'))[0]?.question).toContain('heavy outline');
    expect(buildRubric(none, specFor('tree'))[0]?.question).toContain('no outline');
  });

  it('asks about identity only for characters and creatures', () => {
    const character = buildRubric(styleBible(), specFor('biped', { subjectClass: 'character' }));
    const prop = buildRubric(styleBible(), threeBlobSpec());

    expect(character.map((criterion) => criterion.key)).toContain(IDENTITY_MATCH);
    expect(prop.map((criterion) => criterion.key)).not.toContain(IDENTITY_MATCH);
  });

  it('folds the measured scores in and re-weights the overall', () => {
    const rubric = buildRubric(styleBible(), specFor('tree'));
    const merged = mergeMeasuredScores(
      [
        { key: STYLE_MATCH, score: 1, reason: 'x' },
        { key: SILHOUETTE, score: 1, reason: 'x' },
      ],
      { alphaCleanliness: 0, partCompleteness: 0 },
      rubric,
    );

    expect(merged.scores.map((score) => score.key)).toContain(ALPHA_CLEANLINESS);
    // A perfect model score cannot hide a failed matte.
    expect(merged.overall).toBeLessThan(1);
    expect(merged.overall).toBeGreaterThan(0);
  });

  it('clamps a measured score into the unit range', () => {
    const merged = mergeMeasuredScores([], { alphaCleanliness: 5, partCompleteness: -3 }, []);
    expect(merged.scores.find((score) => score.key === ALPHA_CLEANLINESS)?.score).toBe(1);
    expect(merged.scores.find((score) => score.key === PART_COMPLETENESS)?.score).toBe(0);
  });

  it('scores zero when the rubric is empty rather than dividing by nothing', () => {
    // Reached only through a hand-built call, but the alternative is a NaN threshold.
    const merged = mergeMeasuredScores([], { alphaCleanliness: 1, partCompleteness: 1 }, []);
    expect(Number.isNaN(merged.overall)).toBe(false);
  });
});

describe('QualityGateUseCase', () => {
  it('accepts a take that clears every floor', async () => {
    const gate = new QualityGateUseCase({ vision: new FakeVisionPort() });
    const result = unwrap(
      await gate.execute({
        spec: specFor('tree'),
        style: styleBible(),
        attempt: { image: IMAGE, measured: PERFECT },
      }),
    );

    expect(result.verdict).toBe('accepted');
    expect(result.failures).toHaveLength(0);
    expect(result.repairClause).toBeUndefined();
    expect(result.scores.overall).toBeGreaterThan(DEFAULT_THRESHOLDS.overall);
  });

  it('rejects an off-style take: the gate is not a rubber stamp', async () => {
    const vision = new FakeVisionPort({ [STYLE_MATCH]: 0.15, [SILHOUETTE]: 0.2 });
    const gate = new QualityGateUseCase({ vision });

    const result = unwrap(
      await gate.execute({
        spec: specFor('tree'),
        style: styleBible(),
        attempt: { image: IMAGE, measured: PERFECT },
      }),
    );

    expect(result.verdict).toBe('needs-review');
    expect(result.failures.map((failure) => failure.key)).toContain(STYLE_MATCH);
    expect(result.scores.styleMatch).toBe(0.15);
  });

  it('rejects a bad matte even when the model liked the picture', async () => {
    const gate = new QualityGateUseCase({ vision: new FakeVisionPort() });
    const result = unwrap(
      await gate.execute({
        spec: specFor('tree'),
        style: styleBible(),
        attempt: { image: IMAGE, measured: { alphaCleanliness: 0.2, partCompleteness: 1 } },
      }),
    );

    expect(result.verdict).toBe('needs-review');
    expect(result.failures.map((failure) => failure.key)).toContain(ALPHA_CLEANLINESS);
  });

  it('rejects an incomplete part set', async () => {
    const gate = new QualityGateUseCase({ vision: new FakeVisionPort() });
    const result = unwrap(
      await gate.execute({
        spec: specFor('tree'),
        style: styleBible(),
        attempt: { image: IMAGE, measured: { alphaCleanliness: 1, partCompleteness: 0.6 } },
      }),
    );
    expect(result.failures.map((failure) => failure.key)).toContain(PART_COMPLETENESS);
  });

  it('offers a repair clause aimed at what actually failed', async () => {
    const vision = new FakeVisionPort({ [STYLE_MATCH]: 0.2 });
    const gate = new QualityGateUseCase({ vision });

    const result = unwrap(
      await gate.execute({
        spec: specFor('tree'),
        style: styleBible(),
        attempt: { image: IMAGE, measured: PERFECT },
      }),
    );

    expect(result.repairClause).toContain('paper-cutout');
    expect(result.repairsRemaining).toBe(2);
  });

  it('stops offering repairs once the budget is spent, and surfaces for review', async () => {
    const vision = new FakeVisionPort({ [STYLE_MATCH]: 0.2 });
    const gate = new QualityGateUseCase({ vision });

    const result = unwrap(
      await gate.execute({
        spec: specFor('tree'),
        style: styleBible(),
        attempt: { image: IMAGE, measured: PERFECT },
        repairsSoFar: 2,
      }),
    );

    expect(result.verdict).toBe('needs-review');
    expect(result.repairsRemaining).toBe(0);
    // No clause means "stop", not "try the same thing again".
    expect(result.repairClause).toBeUndefined();
  });

  it('does not penalise a prop for the identity criterion it was never asked', async () => {
    const gate = new QualityGateUseCase({ vision: new FakeVisionPort() });
    const result = unwrap(
      await gate.execute({
        spec: threeBlobSpec(),
        style: styleBible(),
        attempt: { image: IMAGE, measured: PERFECT },
      }),
    );

    expect(result.verdict).toBe('accepted');
    expect(result.scores.identityMatch).toBeUndefined();
  });

  it('records the identity score for a character', async () => {
    const gate = new QualityGateUseCase({ vision: new FakeVisionPort({ [IDENTITY_MATCH]: 0.95 }) });
    const result = unwrap(
      await gate.execute({
        spec: specFor('biped', { subjectClass: 'character' }),
        style: styleBible(),
        attempt: { image: IMAGE, measured: PERFECT },
        references: [IMAGE],
      }),
    );

    expect(result.scores.identityMatch).toBe(0.95);
  });

  it('fails an overall that is dragged down without any single floor being breached', async () => {
    const vision = new FakeVisionPort({ [STYLE_MATCH]: 0.62, [SILHOUETTE]: 0.52 });
    const gate = new QualityGateUseCase({
      vision,
      thresholds: { ...DEFAULT_THRESHOLDS, overall: 0.95 },
    });

    const result = unwrap(
      await gate.execute({
        spec: specFor('tree'),
        style: styleBible(),
        attempt: { image: IMAGE, measured: PERFECT },
      }),
    );

    expect(result.failures.map((failure) => failure.key)).toContain('overall');
    expect(result.repairClause).toBe('Increase overall fidelity to the style anchors');
  });

  it('propagates a scoring failure rather than passing the asset', async () => {
    const vision = new FakeVisionPort();
    vision.failWith(new ProviderError({ message: 'vision model down', provider: 'ollama' }));

    const failed = await new QualityGateUseCase({ vision }).execute({
      spec: specFor('tree'),
      style: styleBible(),
      attempt: { image: IMAGE, measured: PERFECT },
    });
    expect(isErr(failed)).toBe(true);
  });

  it('passes the references through to the vision port', async () => {
    const vision = new FakeVisionPort();
    await new QualityGateUseCase({ vision }).execute({
      spec: specFor('biped', { subjectClass: 'character' }),
      style: styleBible(),
      attempt: { image: IMAGE, measured: PERFECT },
      references: [IMAGE, IMAGE],
    });
    expect(vision.requests[0]?.references).toHaveLength(2);
  });
});
