/**
 * Scoring a generated image against the style it was supposed to be drawn in.
 *
 * The output is `QualityScores` - the shape `AssetVersion.scores` already holds - so the
 * asset pipeline's gate does not learn a second vocabulary. Two things about how it is
 * filled in are worth stating plainly, because both were choices:
 *
 * **Palette adherence is measured, not asked.** It is a nearest-colour distance in
 * OKLab over sampled pixels. It costs nothing, it is exact, and it is identical between
 * runs - none of which is true of a model's opinion. It then folds into `styleMatch`
 * alongside the model's judgement, and is *also* returned in full, because the folded
 * number cannot tell you whether a rejected asset failed on colour or on medium.
 *
 * **`partCompleteness` is an input, not a score.** Only the caller knows how many parts
 * it planned and how many came back usable. Defaulting it to 1 would let every asset
 * pass a criterion nobody measured, which is worse than requiring the caller to say.
 */

import { QualityScores, type StyleBible } from '@rv/contracts';
import type {
  ImagePayload,
  ProviderUsage,
  VisionScore,
  VisionScoringPort,
  VisionScoringRequest,
} from '@rv/providers';
import {
  type AppError,
  type Logger,
  NoopLogger,
  type Result,
  ValidationError,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';

import { type PaletteAdherence, measurePaletteAdherence } from '../colour/palette';
import type { RasterPort } from '../ports/raster';
import {
  ALPHA_KEY,
  IDENTITY_KEY,
  SILHOUETTE_KEY,
  STYLE_MATCH_KEY,
  buildStyleRubric,
} from './rubric';

/**
 * How much of `styleMatch` the model's judgement accounts for.
 *
 * The larger share, because the model is answering about medium, line and shading as
 * well as colour - four properties against one. The measured palette keeps the rest,
 * which is enough for a badly off-palette image to fail on its own even when a model
 * likes it.
 */
const VISION_STYLE_WEIGHT = 0.6;
const PALETTE_WEIGHT = 1 - VISION_STYLE_WEIGHT;

/**
 * How `QualityScores.overall` is composed.
 *
 * Separate from `RUBRIC_WEIGHTS`, which weights the questions put to the model. This
 * one weights the *finished* score sheet, and it has an entry the rubric does not:
 * `partCompleteness` never goes to a model at all.
 */
const OVERALL_WEIGHTS = {
  styleMatch: 3,
  silhouetteReadability: 2,
  alphaCleanliness: 2,
  partCompleteness: 2,
  identityMatch: 3,
} as const;

/** Scores are stored and compared, so they are rounded to a fixed precision. */
function round(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

export interface StyleScoreReport {
  readonly scores: QualityScores;
  /**
   * The measurement behind the palette half of `styleMatch`.
   *
   * Kept whole: `offPaletteShare` and `worstDistance` are what turn "this asset scored
   * 0.61" into "17 % of it is a colour the style never declared".
   */
  readonly paletteAdherence: PaletteAdherence;
  /** What the vision model said, verbatim, including its reasons. */
  readonly vision: readonly VisionScore[];
  readonly modelRef: string;
  readonly usage: ProviderUsage;
}

export interface ScoreStyleMatchInput {
  readonly bible: StyleBible;
  readonly image: ImagePayload;
  /**
   * Identity anchors, when the subject has an identity to keep.
   *
   * Their presence is what adds the identity criterion - scoring identity against
   * nothing is scoring a guess.
   */
  readonly references?: readonly ImagePayload[];
  /** Fraction of the planned parts that came back usable. The caller measured it. */
  readonly partCompleteness: number;
  readonly signal?: AbortSignal;
}

export interface ScoreStyleMatchDeps {
  readonly vision: VisionScoringPort;
  /** Required, not optional: palette adherence has no model-based fallback by design. */
  readonly raster: RasterPort;
  readonly logger?: Logger;
}

export class ScoreStyleMatchUseCase {
  readonly #vision: VisionScoringPort;
  readonly #raster: RasterPort;
  readonly #logger: Logger;

  constructor(deps: ScoreStyleMatchDeps) {
    this.#vision = deps.vision;
    this.#raster = deps.raster;
    this.#logger = deps.logger ?? new NoopLogger();
  }

  async execute(input: ScoreStyleMatchInput): Promise<Result<StyleScoreReport, AppError>> {
    if (input.partCompleteness < 0 || input.partCompleteness > 1) {
      return err(
        new ValidationError({
          message: 'partCompleteness is a fraction of the planned parts, 0..1.',
          context: { partCompleteness: input.partCompleteness },
        }),
      );
    }

    const decoded = await this.#raster.decode(input.image);
    if (isErr(decoded)) return decoded;

    // Organic ramp included: skin, fur and foliage are legitimately on-palette even
    // though they are not in the main swatch list, and excluding them would fail every
    // character in the series for having a face.
    const palette = [
      ...input.bible.visual.palette.colors.map((colour) => colour.hex),
      ...input.bible.visual.palette.organicRamp,
    ];
    const adherence = measurePaletteAdherence(decoded.value, palette);

    const withIdentity = input.references !== undefined && input.references.length > 0;
    const rubric = buildStyleRubric(input.bible, { withIdentity });

    const request: VisionScoringRequest = {
      image: input.image,
      rubric,
      ...(input.references === undefined ? {} : { references: input.references }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const scored = await this.#vision.score(request);
    if (isErr(scored)) return scored;

    const byKey = new Map(scored.value.scores.map((entry) => [entry.key, entry.score]));
    const missing = rubric.filter((criterion) => !byKey.has(criterion.key));
    if (missing.length > 0) {
      // Neither 0 nor 1 is a safe stand-in: one fails good assets, the other passes bad
      // ones. Saying the scorer did not answer is the only honest option.
      this.#logger.warn('style scoring: rubric criteria unanswered', {
        missing: missing.map((criterion) => criterion.key),
      });
      return err(
        new ValidationError({
          message: 'The vision scorer did not answer every rubric criterion.',
          context: { missing: missing.map((criterion) => criterion.key) },
        }),
      );
    }

    const visionStyle = byKey.get(STYLE_MATCH_KEY) ?? 0;
    const silhouette = byKey.get(SILHOUETTE_KEY) ?? 0;
    const alpha = byKey.get(ALPHA_KEY) ?? 0;
    const identity = withIdentity ? byKey.get(IDENTITY_KEY) : undefined;

    const styleMatch = round(VISION_STYLE_WEIGHT * visionStyle + PALETTE_WEIGHT * adherence.score);

    const weighted: readonly (readonly [number, number])[] = [
      [styleMatch, OVERALL_WEIGHTS.styleMatch],
      [silhouette, OVERALL_WEIGHTS.silhouetteReadability],
      [alpha, OVERALL_WEIGHTS.alphaCleanliness],
      [input.partCompleteness, OVERALL_WEIGHTS.partCompleteness],
      ...(identity === undefined ? [] : ([[identity, OVERALL_WEIGHTS.identityMatch]] as const)),
    ];
    const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0);
    const overall =
      weighted.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;

    const scores = QualityScores.parse({
      styleMatch,
      alphaCleanliness: round(alpha),
      silhouetteReadability: round(silhouette),
      ...(identity === undefined ? {} : { identityMatch: round(identity) }),
      partCompleteness: round(input.partCompleteness),
      overall: round(overall),
    });

    return ok({
      scores,
      paletteAdherence: adherence,
      vision: scored.value.scores,
      modelRef: scored.value.modelRef,
      usage: scored.value.usage,
    });
  }
}
