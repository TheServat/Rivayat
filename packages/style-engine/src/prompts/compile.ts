/**
 * `PromptFragments`, **derived** from the structured style fields.
 *
 * This is the load-bearing claim of the whole style engine: moving `shading.steps`
 * from 2 to 4 in the UI has to change what the image model receives. That only works
 * if the prompt is *computed*. The moment someone types the positive clause by hand,
 * every structured control above it becomes decoration - the checksum changes, the
 * asset library forks, and the pixels come back identical.
 *
 * Three properties this module owes the rest of the system:
 *
 *  1. **Deterministic.** Same bible in, byte-identical strings out. The compiled
 *     positive clause is hashed into the response-cache key and into asset provenance;
 *     a compiler that reordered a `Set` would halve the cache hit rate silently.
 *  2. **Total over `VisualStyle`.** Every field of `VisualStyle` reaches the output in
 *     the regime where it is meaningful. `compile.spec.ts` enumerates
 *     `VisualStyle.shape` and mutates each one; a field the compiler ignores is a UI
 *     control that does nothing.
 *  3. **Blind to `motion` and `render`.** Prompts drive *still* image generation. The
 *     motion block is consumed by the choreographer and `render` is a post-grade
 *     applied at render time - baking either into an asset prompt is what RV-048's
 *     "a `render`-only change forks zero assets" rule exists to prevent.
 */

import { PromptFragments, type SubjectClass, type VisualStyle } from '@rv/contracts';

import { compileModelOverrides } from './model-phrasing';
import { BACKGROUND_PHRASING, MEDIUM_PHRASING, UNIVERSAL_NEGATIVES } from './medium';
import { SUBJECT_CLAUSES } from './subject';
import { band, dedupeStable, fixed, joinClauses, lightDirectionPhrase, plural } from './words';

/**
 * What the compiler needs.
 *
 * Structural rather than `StyleBible`, so a `StyleBibleDraft` mid-wizard compiles the
 * same way a locked bible does - the wizard must be able to show the user the real
 * prompt before anything has an id.
 */
export interface PromptCompilerInput {
  readonly visual: VisualStyle;
}

/**
 * Compiles the full fragment set.
 *
 * The result is parsed on the way out rather than merely constructed: the compiler is
 * the only writer of `PromptFragments`, so if it can emit something the schema refuses
 * (an empty positive clause, say, from a `custom` medium with an empty note) that must
 * fail here and not at generation time with the money already committed.
 */
export function compilePromptFragments(input: PromptCompilerInput): PromptFragments {
  const { visual } = input;
  return PromptFragments.parse({
    positive: compilePositiveClause(visual),
    negative: compileNegativeClause(visual),
    bySubject: compileSubjectClauses(visual),
    byModel: compileModelOverrides(visual),
  });
}

// ── the positive clause ─────────────────────────────────────────────────────

/**
 * The style clause prepended to every generation.
 *
 * Ordered medium → colour → line → shading → texture → form → background, because
 * that is the order the properties dominate perception in: a viewer reads "what is it
 * made of" before "what colour is it" before "how detailed is it", and CLIP-family
 * encoders weight earlier tokens more heavily (research §2).
 */
export function compilePositiveClause(visual: VisualStyle): string {
  return joinClauses([
    mediumClause(visual),
    paletteClause(visual.palette),
    lineClause(visual.line),
    shadingClause(visual.shading),
    textureClause(visual.texture),
    shapeClause(visual.shape),
    BACKGROUND_PHRASING[visual.backgroundTreatment],
  ]);
}

function mediumClause(visual: VisualStyle): string {
  return joinClauses([MEDIUM_PHRASING[visual.medium].clause, visual.mediumNote]);
}

function paletteClause(palette: VisualStyle['palette']): string {
  // Named *and* hexed. The name carries intent ("moss", "bark") which a language-model
  // encoder uses; the hex pins the actual colour for anything that reads it literally.
  const swatches = palette.colors
    .map((colour) =>
      colour.role === undefined
        ? `${colour.name} ${colour.hex}`
        : `${colour.role} ${colour.name} ${colour.hex}`,
    )
    .join(', ');

  const contrast = band(palette.contrastFloor, [
    'subjects barely separated from their ground',
    'gentle tonal separation between subject and ground',
    'clear tonal separation between subject and ground',
    'strong tonal separation between subject and ground',
    'extreme value contrast between subject and ground',
  ]);

  const organic =
    palette.organicRamp.length === 0
      ? undefined
      : `organic surfaces restricted to the ramp ${palette.organicRamp.join(', ')}`;

  return joinClauses([`${palette.harmony} palette of ${swatches}`, contrast, organic]);
}

function lineClause(line: VisualStyle['line']): string {
  // `present: false` genuinely suppresses the rest: describing the taper of a stroke
  // that is not drawn is noise the encoder still pays attention to.
  if (!line.present) return 'no outlines at all, forms separated by colour and value alone';

  const weight = band(line.weight, [
    'hairline outlines',
    'fine outlines',
    'medium-weight outlines',
    'heavy outlines',
    'very heavy brush outlines',
  ]);
  const variability = band(line.variability, [
    'perfectly uniform stroke width',
    'nearly uniform stroke width',
    'moderately modulated stroke width',
    'strongly modulated stroke width',
    'dramatically swelling and thinning strokes',
  ]);
  const taper = band(line.taper, [
    'blunt stroke ends',
    'slightly tapered stroke ends',
    'tapered stroke ends',
    'sharply tapered stroke ends',
    'needle-fine stroke ends',
  ]);
  const roughness = band(line.roughness, [
    'vector-clean strokes',
    'almost clean strokes',
    'slightly irregular hand-drawn strokes',
    'visibly wobbly hand-drawn strokes',
    'raw scratchy hand-drawn strokes',
  ]);

  return joinClauses([weight, LINE_COLOR_PHRASING[line.colorMode], variability, taper, roughness]);
}

const LINE_COLOR_PHRASING = {
  black: 'outlines in solid black',
  tinted: 'outlines in a darker tint of the colour they border',
  'darker-fill': 'outlines in a much darker shade of their own fill',
  none: 'outlines the same colour as the fill, readable only as an edge',
} as const satisfies Record<VisualStyle['line']['colorMode'], string>;

function shadingClause(shading: VisualStyle['shading']): string {
  // `steps` is documented as "ignored by continuous models", but a continuous model
  // still resolves into a countable number of tonal zones, and leaving the control
  // dead for half the shading models is exactly the "UI control that does nothing"
  // failure this compiler exists to prevent. So it is always emitted - phrased as
  // hard bands for quantised models and as tonal zones for continuous ones.
  const banded = QUANTISED_SHADING.has(shading.model);
  const steps = banded
    ? `exactly ${plural(shading.steps, 'hard tonal band')}`
    : `resolving into about ${plural(shading.steps, 'tonal zone')}`;

  const rim =
    shading.rimLight < 0.05
      ? undefined
      : band(shading.rimLight, [
          'the faintest rim light',
          'a subtle rim light along the silhouette',
          'a clear rim light along the silhouette',
          'a strong rim light separating the silhouette',
          'a blazing rim light around the whole silhouette',
        ]);

  const occlusion = band(shading.occlusionStrength, [
    'no contact shadows',
    'faint contact shadows where forms meet',
    'defined contact shadows where forms meet',
    'deep contact shadows where forms meet',
    'near-black occlusion where forms meet',
  ]);

  return joinClauses([
    `${SHADING_PHRASING[shading.model]}, ${steps}`,
    lightDirectionPhrase(shading.lightDirection),
    shading.ambientTint === undefined ? undefined : `shadows tinted ${shading.ambientTint}`,
    rim,
    occlusion,
  ]);
}

const SHADING_PHRASING = {
  flat: 'no shading, every surface a single flat colour',
  cel: 'cel shading with hard-edged shadow shapes',
  soft: 'soft airbrushed shading',
  crosshatch: 'crosshatched shading built from ink hatching',
  stipple: 'stippled shading built from dots of varying density',
  painterly: 'painterly shading blended with the brush',
} as const satisfies Record<VisualStyle['shading']['model'], string>;

/** Shading models whose `steps` really are hard bands rather than tonal zones. */
const QUANTISED_SHADING = new Set<VisualStyle['shading']['model']>([
  'flat',
  'cel',
  'crosshatch',
  'stipple',
]);

function textureClause(texture: VisualStyle['texture']): string {
  const parts = [
    textureTerm(texture.grain, [
      'film grain',
      'the faintest film grain',
      'light film grain',
      'noticeable film grain',
      'heavy film grain',
    ]),
    textureTerm(texture.paperFiber, [
      'paper fibre',
      'the faintest paper fibre',
      'visible paper fibre',
      'coarse paper fibre',
      'rough handmade paper fibre',
    ]),
    textureTerm(texture.halftone, [
      'halftone dots',
      'a hint of halftone dots',
      'visible halftone dots',
      'coarse halftone dots',
      'aggressive newsprint halftone dots',
    ]),
    textureTerm(texture.brushVisibility, [
      'brush marks',
      'barely visible brush marks',
      'visible brush marks',
      'prominent brush marks',
      'thick impasto brush marks',
    ]),
    band(texture.edgeRoughness, [
      'razor-clean silhouette edges',
      'nearly clean silhouette edges',
      'slightly ragged silhouette edges',
      'torn and ragged silhouette edges',
      'violently torn silhouette edges',
    ]),
  ];
  return joinClauses(parts);
}

/**
 * A texture term that disappears at zero.
 *
 * At exactly 0 the effect is *absent*, and "no film grain" belongs in the negative
 * prompt, not the positive one - stating it positively is how a model ends up adding
 * the thing you asked it not to add.
 */
function textureTerm(
  value: number,
  words: readonly [string, string, string, string, string],
): string | undefined {
  if (value === 0) return undefined;
  return band(value, words);
}

function shapeClause(shape: VisualStyle['shape']): string {
  const roundness = band(shape.roundness, [
    'sharply angular forms',
    'mostly angular forms',
    'a mix of angular and rounded forms',
    'softly rounded forms',
    'entirely circular and blobby forms',
  ]);
  const exaggeration = band(shape.exaggeration, [
    'anatomically straight proportions',
    'lightly stylised proportions',
    'clearly stylised proportions',
    'strongly caricatured proportions',
    'extreme cartoon caricature',
  ]);
  const detail = band(shape.detailDensity, [
    'extremely sparse, almost pictographic detail',
    'sparse graphic detail',
    'moderate detail',
    'dense illustrative detail',
    'intricate, densely packed detail',
  ]);

  return joinClauses([
    roundness,
    exaggeration,
    `figures about ${fixed(shape.headToBodyRatio, 1)} heads tall`,
    detail,
    shape.silhouetteRule,
  ]);
}

// ── the negative clause ─────────────────────────────────────────────────────

/**
 * Everything that must not appear, from four sources, in a stable order.
 *
 * Author-declared negatives come first because they are the only ones a human chose,
 * and the CLIP-conditioned lane truncates at 77 tokens - if anything is going to fall
 * off the end it should not be the art director's explicit rule.
 */
export function compileNegativeClause(visual: VisualStyle): string {
  return dedupeStable([
    ...visual.negative,
    ...MEDIUM_PHRASING[visual.medium].negatives,
    ...impliedNegatives(visual),
    ...UNIVERSAL_NEGATIVES,
  ]).join(', ');
}

/**
 * Negatives the structured fields imply.
 *
 * A style that says "no outlines" must *say* "no outlines" to the model: image models
 * add linework by default because most of their training data has it, and omitting a
 * property from the positive prompt is not the same as forbidding it.
 */
function impliedNegatives(visual: VisualStyle): readonly string[] {
  const out: string[] = [];
  if (!visual.line.present || visual.line.colorMode === 'none') {
    out.push('outlines', 'ink linework');
  }
  if (visual.line.present && visual.line.roughness < 0.15) out.push('wobbly sketchy linework');
  if (visual.shading.model === 'flat') out.push('gradients', 'cast shadows');
  if (visual.shading.rimLight === 0) out.push('rim light');
  if (visual.texture.grain === 0) out.push('film grain', 'sensor noise');
  if (visual.texture.paperFiber === 0) out.push('paper texture');
  if (visual.texture.halftone === 0) out.push('halftone dots');
  if (visual.texture.brushVisibility === 0) out.push('visible brush strokes');
  if (visual.texture.edgeRoughness < 0.1) out.push('ragged edges', 'torn edges');
  if (visual.palette.contrastFloor >= 0.6) out.push('muddy midtones', 'low contrast');
  if (visual.shape.detailDensity < 0.35) out.push('busy background clutter');
  if (visual.shape.exaggeration < 0.2) out.push('cartoon caricature');
  if (visual.palette.organicRamp.length > 0) out.push('off-palette skin tones');
  return out;
}

// ── per-subject clauses ─────────────────────────────────────────────────────

/**
 * The extra sentence each subject class gets.
 *
 * Every class is emitted, not only the ones with something unusual to say, because the
 * UI shows the user what a foliage prompt will actually look like - and an absent key
 * renders as "nothing extra", which is indistinguishable from "we forgot".
 */
function compileSubjectClauses(visual: VisualStyle): Partial<Record<SubjectClass, string>> {
  const out: Partial<Record<SubjectClass, string>> = {};
  for (const [subject, clause] of SUBJECT_CLAUSES) {
    out[subject] = clause(visual);
  }
  return out;
}
