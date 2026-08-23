/**
 * What we ask a vision model to *see*, as opposed to what we ask it to decide.
 *
 * The temptation is to hand the model `StyleBibleDraft`'s JSON Schema and let it fill
 * the form in. That fails in a specific and expensive way: asked for
 * `line.variability: number`, a model returns 0.5 for everything, because it has no
 * grounding for what 0.5 means and the safest number is the middle one. The bible comes
 * back complete, plausible, and identical for every reference set.
 *
 * So the model is asked for **observations in observational vocabulary** - is there an
 * outline, how thick, does the stroke width change, which way is the light coming from,
 * how many distinct shadow tones can you count - and this package does the mapping to
 * fields. The model is good at the first job and bad at the second; the mapping is a
 * lookup table, which is bad at neither and is reviewable, testable and identical
 * between runs.
 *
 * Every enum here is phrased the way an art student would answer, deliberately: those
 * are the words the model's training data attaches to the visual evidence.
 *
 * This is a wire shape for one prompt, not a domain shape, so it lives here rather than
 * in `@rv/contracts` - the same reason `VisionScoreSheet` lives beside its port.
 */

import { z } from 'zod';

/** Four-step presence scale. Used for everything that is a matter of degree. */
export const Presence = z.enum(['none', 'subtle', 'noticeable', 'dominant']);
export type Presence = z.infer<typeof Presence>;

/**
 * What the artwork appears to be physically made of.
 *
 * Named after the *process* rather than the style label, because "watercolour" is a
 * word a model will apply to anything pale and blue, whereas "pigment visibly running
 * into wet paper" is a thing that is either in the picture or not.
 */
export const SurfaceImpression = z.enum([
  'vector-flat',
  'printed-ink',
  'wet-paint',
  'opaque-paint',
  'dry-pigment',
  'cut-paper',
  'woven-fabric',
  'modelled-clay',
  'pixel-grid',
  'carved-print',
  'photographic',
]);
export type SurfaceImpression = z.infer<typeof SurfaceImpression>;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

export const StyleObservations = z.object({
  surface: z.object({
    impression: SurfaceImpression,
    /** Forced justification. A model that must cite evidence looks; one that need not, guesses. */
    evidence: z
      .string()
      .min(1)
      .max(300)
      .describe('What in the image tells you this - name a specific visible detail.'),
  }),

  outline: z.object({
    present: z.boolean().describe('Are the forms drawn with an outline at all?'),
    thickness: z.enum(['none', 'hairline', 'thin', 'medium', 'thick', 'very-thick']),
    uniformity: z
      .enum(['uniform', 'slightly-modulated', 'strongly-modulated'])
      .describe('Does the stroke get thicker and thinner along its length?'),
    colour: z.enum(['black', 'darker-than-fill', 'coloured', 'same-as-fill', 'no-outline']),
    steadiness: z.enum(['ruler-straight', 'slightly-uneven', 'hand-wobbled', 'scratchy']),
    tapered: z.boolean().describe('Do stroke ends come to a point?'),
  }),

  shading: z.object({
    bands: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe('Count the distinct shadow tones on one surface. 1 means no shading at all.'),
    edge: z.enum(['none', 'hard', 'soft', 'textured', 'hatched', 'dotted']),
    lightFrom: z.enum([
      'right',
      'upper-right',
      'above',
      'upper-left',
      'left',
      'lower-left',
      'below',
      'lower-right',
      'no-clear-direction',
    ]),
    rimLight: z.enum(['none', 'faint', 'clear', 'strong']),
    contactShadows: z.enum(['none', 'faint', 'defined', 'deep']),
  }),

  texture: z.object({
    grain: Presence.describe('Fine speckled noise over the whole image.'),
    paperFibre: Presence.describe('The tooth of the paper showing through.'),
    halftone: Presence.describe('Printed dots making up the tones.'),
    brushMarks: Presence.describe('Individual strokes of a brush or tool.'),
    edgeRaggedness: Presence.describe('How torn or broken the outer silhouette edges are.'),
  }),

  forms: z.object({
    corners: z.enum(['sharp', 'mostly-sharp', 'mixed', 'mostly-round', 'round']),
    proportions: z.enum([
      'realistic',
      'slightly-stylised',
      'clearly-stylised',
      'strongly-caricatured',
      'extreme',
    ]),
    headsPerBody: z
      .number()
      .min(1)
      .max(10)
      .describe('If a figure is visible, how many head-heights tall is it? Otherwise answer 6.'),
    detail: z.enum(['pictographic', 'sparse', 'moderate', 'dense', 'intricate']),
    readableAsSilhouette: z
      .boolean()
      .describe('Would the main subject still be recognisable filled in solid black?'),
  }),

  background: z.enum([
    'flat-colour',
    'gradient',
    'painted-scene',
    'stacked-depth-layers',
    'almost-empty',
    'dense-detail',
  ]),

  colourRelationship: z.enum([
    'monochrome',
    'analogous',
    'complementary',
    'split-complementary',
    'triadic',
    'tetradic',
    'earthy',
    'pastel',
    'neon',
    'muted',
    'high-contrast',
  ]),

  valueContrast: z.enum(['very-low', 'low', 'moderate', 'high', 'very-high']),

  colours: z
    .array(
      z.object({
        hex: Hex,
        name: z.string().min(1).max(40).describe('A plain-language name, e.g. "moss", "brick".'),
        where: z.string().min(1).max(120).describe('Where in the image this colour appears.'),
      }),
    )
    .min(3)
    .max(12),

  organicColours: z
    .array(Hex)
    .max(6)
    .describe('Colours used for skin, fur or foliage specifically. Empty if none are visible.'),

  notablyAbsent: z
    .array(z.string().min(1).max(60))
    .max(12)
    .describe(
      'Things this style clearly avoids and that a generator would add by default - e.g. "photographic depth of field", "glowing highlights".',
    ),
});
export type StyleObservations = z.infer<typeof StyleObservations>;
