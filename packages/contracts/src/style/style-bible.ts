/**
 * The Style Bible - art direction, locked before a single pixel is generated.
 *
 * Two things make this more than a prompt template:
 *
 *  1. **Motion is part of the style.** A paper-cutout world does not move like a
 *     painterly one: it snaps, it hinges, it holds. Putting easing curves, step mode,
 *     exaggeration and ambient rules in the *same* document as palette and line weight
 *     is what stops the look and the movement drifting apart.
 *
 *  2. **It has a checksum, and the checksum is part of every asset key.** Changing the
 *     style therefore forks the asset library instead of silently leaving old assets
 *     mismatched against new ones. Season 1 stays renderable after a season 2 restyle.
 */

import { z } from 'zod';

import { StyleBibleId } from '../primitives/ids';
import {
  Degrees,
  HexColor,
  Fps,
  IsoInstant,
  Label,
  Millis,
  NamedColor,
  NonEmptyString,
  Prose,
  Sha256Hex,
  SignedUnit,
  Slug,
  Unit01,
} from '../primitives/common';

// ── visual ──────────────────────────────────────────────────────────────────

/**
 * The physical medium being imitated. This is the single strongest lever on the
 * result, so it is an enum rather than free text - it selects prompt fragments,
 * matting strategy, and a default motion profile all at once.
 */
export const ArtMedium = z.enum([
  'flat-vector',
  'painterly',
  'watercolour',
  'gouache',
  'paper-cutout',
  'collage',
  'ink-comic',
  'manga',
  'pixel-art',
  'low-poly-2d',
  'claymation',
  'felt-craft',
  'woodblock',
  'chalk-pastel',
  'photo-collage',
  'custom',
]);
export type ArtMedium = z.infer<typeof ArtMedium>;

export const ColorHarmony = z.enum([
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
]);
export type ColorHarmony = z.infer<typeof ColorHarmony>;

export const Palette = z
  .object({
    colors: z.array(NamedColor).min(3).max(24).describe('The full working palette, named by role'),
    harmony: ColorHarmony.describe('The relationship the palette is built on'),
    /**
     * Minimum luminance contrast between a subject and its background.
     *
     * Enforced because generated art drifts toward mush: without a floor, characters
     * stop reading against their own backgrounds and no amount of animation fixes it.
     */
    contrastFloor: Unit01.default(0.35),
    /** A restricted set used for skin/fur/foliage so organic surfaces stay coherent. */
    organicRamp: z.array(HexColor).max(8).default([]),
  })
  .describe('Colour system for the whole series');
export type Palette = z.infer<typeof Palette>;

export const LineStyle = z.object({
  present: z.boolean().default(true).describe('Whether forms are outlined at all'),
  weight: Unit01.default(0.4).describe('0 = hairline, 1 = heavy brush'),
  variability: Unit01.default(0.3).describe(
    '0 = uniform technical line, 1 = strongly modulated brush pressure',
  ),
  colorMode: z
    .enum(['black', 'tinted', 'darker-fill', 'none'])
    .default('tinted')
    .describe('tinted = the outline is a darker version of the fill it borders'),
  taper: Unit01.default(0.2).describe('How much the stroke narrows at its ends'),
  roughness: Unit01.default(0.2).describe('0 = vector-clean, 1 = hand-wobbled'),
});
export type LineStyle = z.infer<typeof LineStyle>;

export const ShadingModel = z.enum(['flat', 'cel', 'soft', 'crosshatch', 'stipple', 'painterly']);
export type ShadingModel = z.infer<typeof ShadingModel>;

export const Shading = z.object({
  model: ShadingModel.default('cel'),
  /** Number of discrete bands for `cel`. Ignored by continuous models. */
  steps: z.number().int().min(1).max(8).default(2),
  /** Key-light direction in degrees, 0 = from the right, counter-clockwise. */
  lightDirection: Degrees.default(45),
  ambientTint: HexColor.optional().describe('Colour of light in the shadows'),
  rimLight: Unit01.default(0).describe('Edge light strength; separates subject from ground'),
  occlusionStrength: Unit01.default(0.3),
});
export type Shading = z.infer<typeof Shading>;

export const Texture = z.object({
  grain: Unit01.default(0),
  paperFiber: Unit01.default(0),
  halftone: Unit01.default(0),
  edgeRoughness: Unit01.default(0.1).describe('Ragged vs clean silhouette edges'),
  brushVisibility: Unit01.default(0),
});
export type Texture = z.infer<typeof Texture>;

export const ShapeLanguage = z.object({
  roundness: Unit01.default(0.6).describe('0 = angular and sharp, 1 = soft and circular'),
  exaggeration: Unit01.default(0.4).describe('How far proportions depart from realistic'),
  headToBodyRatio: z
    .number()
    .min(1)
    .max(10)
    .default(6)
    .describe('Heads per body height. ~2-3 chibi, ~6 naturalistic, ~8 heroic'),
  silhouetteRule: Prose.describe(
    'The readability rule every character must satisfy, e.g. "recognisable as a black shape at 64px"',
  ),
  detailDensity: Unit01.default(0.4).describe('Sparse and graphic vs dense and illustrative'),
});
export type ShapeLanguage = z.infer<typeof ShapeLanguage>;

export const VisualStyle = z
  .object({
    medium: ArtMedium,
    mediumNote: Prose.optional().describe('Required when medium is "custom"'),
    palette: Palette,
    line: LineStyle.prefault({}),
    shading: Shading.prefault({}),
    texture: Texture.prefault({}),
    shape: ShapeLanguage,
    backgroundTreatment: z
      .enum(['flat-color', 'gradient', 'painted', 'layered-parallax', 'minimal', 'detailed-scene'])
      .default('layered-parallax'),
    /** Things that must never appear. Fed to every image prompt as negatives. */
    negative: z.array(NonEmptyString).max(64).default([]),
  })
  .superRefine((visual, ctx) => {
    // `mediumNote` says "Required when medium is custom" and nothing enforced it.
    // `custom` exists precisely because the enum cannot name every medium, so a custom
    // medium with no note leaves the prompt compiler with the word "custom" and nothing
    // to compile - and it fails at generation time, after the money is committed.
    if (visual.medium === 'custom' && visual.mediumNote === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['mediumNote'],
        message: 'a custom medium must describe itself; the enum cannot',
      });
    }
  });
export type VisualStyle = z.infer<typeof VisualStyle>;

// ── motion ──────────────────────────────────────────────────────────────────

/**
 * One cubic-bezier control point.
 *
 * `x` is the normalised time of the control point and is meaningless outside 0..1 - a
 * bezier whose control point sits at t = 5 is not a slow curve, it is not a curve. `y`
 * is deliberately allowed past the unit range, because that is exactly what produces
 * anticipation (dipping below the start) and overshoot (passing the target and settling
 * back), which `MotionPrinciples` explicitly asks for.
 *
 * The bounds are identical to `CubicBezierEasing` in `anim/easing.ts` on purpose, and
 * `style-bible.spec.ts` asserts they stay identical. The two schemas exist because they
 * are consumed differently - one names a curve for the whole series, the other inlines
 * one at a keyframe - but they describe the same mathematics, and a control point that
 * is legal in a style bible and illegal at a keyframe is a bug waiting for the first
 * clip that inlines a style curve.
 */
export const BezierControlPoint = z.object({
  x: Unit01.describe('Normalised time, 0..1.'),
  y: z.number().min(-4).max(4).describe('Value. Outside 0..1 for anticipation and overshoot.'),
});
export type BezierControlPoint = z.infer<typeof BezierControlPoint>;

/**
 * A named easing curve as explicit cubic-bezier control points.
 *
 * Not an enum of preset names: the whole point is that a style can define *its own*
 * feel, and a renderer, a baker and an exporter must all interpret it identically.
 * Two numbers pairs are unambiguous; "ease-out-quart" is a lookup table away from a
 * mismatch.
 *
 * `name` is what `Easing`'s `named` variant (`anim/easing.ts`), `MotionStyle.defaultEasing`
 * and `CameraGrammar.panEase` all resolve against.
 */
export const EasingCurve = z.object({
  name: Slug,
  p1: BezierControlPoint.describe('First control point.'),
  p2: BezierControlPoint.describe('Second control point.'),
});
export type EasingCurve = z.infer<typeof EasingCurve>;

/**
 * Frame stepping.
 *
 * `on-2s` and `on-3s` hold each drawing for 2 or 3 frames, the classic hand-animation
 * cadence. This one field is most of the difference between "looks animated" and
 * "looks like a computer interpolated it".
 */
export const StepMode = z.enum(['smooth', 'on-2s', 'on-3s', 'on-4s']);
export type StepMode = z.infer<typeof StepMode>;

export const MotionPrinciples = z.object({
  squashStretch: Unit01.default(0.3),
  anticipation: Unit01.default(0.4).describe('Wind-up before a move'),
  followThrough: Unit01.default(0.4).describe('Trailing parts settling after the main mass stops'),
  overshoot: Unit01.default(0.25),
  secondaryMotion: Unit01.default(0.5).describe('Hair, cloth, ears, tails reacting to the primary'),
  arcBias: Unit01.default(0.6).describe('0 = straight-line moves, 1 = everything travels on arcs'),
  holdBias: Unit01.default(0.3).describe(
    'Preference for still poses between moves; high values read as deliberate',
  ),
  weight: Unit01.default(0.5).describe('0 = floaty, 1 = heavy and grounded'),
});
export type MotionPrinciples = z.infer<typeof MotionPrinciples>;

/**
 * "Boil" - the low-amplitude jitter of a redrawn line.
 *
 * Present in hand-drawn animation because no two drawings are identical. Faking it is
 * the cheapest way to stop rig-driven motion looking mechanical.
 */
export const BoilSettings = z.object({
  enabled: z.boolean().default(false),
  amplitude: Unit01.default(0.15),
  hz: z.number().min(0).max(24).default(8).describe('Redraw rate; 8-12 reads as traditional'),
  affectsFills: z.boolean().default(false).describe('Whether fills boil with the outline'),
});
export type BoilSettings = z.infer<typeof BoilSettings>;

/**
 * Idle life.
 *
 * Nothing in a shot should be perfectly still - a frozen tree in a moving scene reads
 * as a bug. These are the always-on background motions the choreographer applies
 * without being asked.
 */
export const AmbientMotion = z.object({
  windHz: z.number().min(0).max(4).default(0.3),
  windAmplitude: Unit01.default(0.25),
  windGustiness: Unit01.default(0.4).describe('0 = steady breeze, 1 = irregular gusts'),
  breathHz: z.number().min(0).max(2).default(0.25),
  blinkIntervalMs: Millis.default(4200),
  blinkVarianceMs: Millis.default(1800),
  idleAmplitude: Unit01.default(0.2),
  /** Depth-dependent phase offset so a forest does not sway as one object. */
  phaseByDepth: Unit01.default(0.5),
});
export type AmbientMotion = z.infer<typeof AmbientMotion>;

export const CameraGrammar = z.object({
  panEase: Slug.default('ease-in-out').describe('Name of a curve in `easings`'),
  parallaxStrength: Unit01.default(0.5),
  parallaxCurve: z
    .enum(['linear', 'exponential', 'logarithmic'])
    .default('exponential')
    .describe('How layer offset scales with depth'),
  shakeAmplitude: Unit01.default(0.05),
  defaultShotMs: Millis.default(3000),
  cutRhythm: z
    .enum(['languid', 'measured', 'brisk', 'frenetic'])
    .default('measured')
    .describe('Baseline shot length feel; the sequencer uses it to pace a scene'),
  allowZoom: z.boolean().default(true),
  allowRoll: z.boolean().default(false),
});
export type CameraGrammar = z.infer<typeof CameraGrammar>;

/**
 * The motion half of the style bible.
 *
 * This is what the requirement "the style must also cover how things animate" turns
 * into: every value here is consumed by the choreographer and the rig's motion presets,
 * so the same `bird/flap` clip genuinely differs between a paper-cutout series and a
 * painterly one.
 */
export const MotionStyle = z
  .object({
    fps: Fps.default(24),
    stepMode: StepMode.default('smooth'),
    easings: z
      .array(EasingCurve)
      .min(1)
      .describe('Named curves this style uses; referenced by name elsewhere'),
    defaultEasing: Slug.describe('Name of the curve used when nothing else is specified'),
    principles: MotionPrinciples.prefault({}),
    boil: BoilSettings.prefault({}),
    ambient: AmbientMotion.prefault({}),
    camera: CameraGrammar.prefault({}),
    /** Global speed multiplier, so a whole series can be paced up or down at once. */
    tempo: z.number().min(0.25).max(4).default(1),
  })
  .superRefine((motion, ctx) => {
    // `defaultEasing` and `camera.panEase` are curve *names*, and a name that resolves to
    // nothing is the same class of bug the rig and the IR already refuse: a dangling
    // internal reference. The evaluator would have to invent a curve or throw mid-render,
    // and both are worse than failing here. `Easing`'s `named` variant resolves against
    // this same list, but across documents, so only this half is checkable.
    const names = new Set(motion.easings.map((curve) => curve.name));
    if (names.size !== motion.easings.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['easings'],
        message: 'two easing curves share a name; a reference to it would be ambiguous',
      });
    }
    if (!names.has(motion.defaultEasing)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultEasing'],
        message: `defaultEasing "${motion.defaultEasing}" is not one of this style's easings`,
      });
    }
    if (!names.has(motion.camera.panEase)) {
      ctx.addIssue({
        code: 'custom',
        path: ['camera', 'panEase'],
        message: `camera.panEase "${motion.camera.panEase}" is not one of this style's easings`,
      });
    }
  });
export type MotionStyle = z.infer<typeof MotionStyle>;

// ── output treatment ────────────────────────────────────────────────────────

export const RenderTreatment = z.object({
  filmGrain: Unit01.default(0),
  vignette: Unit01.default(0),
  bloom: Unit01.default(0),
  chromaticAberration: Unit01.default(0),
  colorGrade: z
    .object({
      temperature: SignedUnit.default(0),
      tint: SignedUnit.default(0),
      lift: HexColor.optional(),
      gamma: HexColor.optional(),
      gain: HexColor.optional(),
      saturation: z.number().min(0).max(2).default(1),
    })
    .prefault({}),
});
export type RenderTreatment = z.infer<typeof RenderTreatment>;

// ── prompt fragments ────────────────────────────────────────────────────────

export const SubjectClass = z.enum([
  'character',
  'creature',
  'prop',
  'foliage',
  'architecture',
  'sky',
  'ground',
  'water',
  'fx',
  'ui',
]);
export type SubjectClass = z.infer<typeof SubjectClass>;

/**
 * The compiled text the image models actually receive.
 *
 * Derived from the structured fields above rather than typed by hand, so that editing
 * `shading.steps` in the UI genuinely changes what gets generated. Stored on the bible
 * because it must be frozen alongside the checksum - a prompt that drifts is a style
 * that drifts.
 */
export const PromptFragments = z.object({
  positive: NonEmptyString.describe('Style clause prepended to every generation'),
  negative: NonEmptyString.describe('Negative clause appended to every generation'),
  bySubject: z
    // `partialRecord`, not `record`: an enum-keyed `z.record` demands *every* key, and
    // most styles only need to say something extra about one or two subject classes.
    .partialRecord(SubjectClass, z.string())
    .default({})
    .describe('Additional clause per subject class, e.g. foliage needs different guidance'),
  /** Model-specific overrides, keyed by `provider:model`. */
  byModel: z.record(z.string(), z.string()).prefault({}),
});
export type PromptFragments = z.infer<typeof PromptFragments>;

// ── the bible ───────────────────────────────────────────────────────────────

/**
 * How this bible came to exist. All three paths converge on the same schema, so
 * downstream code never branches on origin.
 */
export const StyleOrigin = z.enum(['preset', 'derived', 'wizard', 'forked']);
export type StyleOrigin = z.infer<typeof StyleOrigin>;

export const StyleAnchor = z.object({
  /** Content hash of the reference image in the asset store. */
  imageHash: Sha256Hex,
  role: z
    .enum(['exemplar', 'palette-source', 'line-source', 'texture-source', 'counter-example'])
    .describe('counter-example = "explicitly not this"'),
  note: Label.optional(),
});
export type StyleAnchor = z.infer<typeof StyleAnchor>;

/**
 * The bible's fields, shared between the whole document and its two projections.
 *
 * Split out because `StyleBible` carries an object-level invariant, and Zod 4 refuses
 * `.pick()` / `.omit()` on a schema that has one. `StyleCheckpointInput` and
 * `StyleBibleDraft` are both projections of *these fields*, not of the invariant, so
 * they are derived from the unrefined base and the invariant is added on top exactly
 * once.
 */
const styleBibleShape = {
  id: StyleBibleId,
  name: Label,
  /** Bumped on every edit; the previous version stays addressable. */
  version: z.number().int().positive().default(1),
  origin: StyleOrigin,
  parentId: StyleBibleId.optional().describe('Set when origin is "forked"'),

  visual: VisualStyle,
  motion: MotionStyle,
  render: RenderTreatment.prefault({}),
  prompts: PromptFragments,

  anchors: z.array(StyleAnchor).max(32).default([]),

  /**
   * Base seed for every generation made under this style.
   *
   * Together with the frozen prompt fragments it is what makes a style reproducible:
   * regenerating an asset a year later yields the same image.
   */
  seed: z.number().int().nonnegative(),

  /**
   * Hash over everything that affects output.
   *
   * Participates in every asset dedup key. Set by the style engine, never by hand -
   * a hand-set checksum is a silent cache poisoning.
   */
  checksum: Sha256Hex,

  /**
   * A style may only be used for generation once locked. Locking freezes the
   * checksum; further edits fork a new version rather than mutating this one.
   */
  lockedAt: IsoInstant.nullable().default(null),

  createdAt: IsoInstant,
  notes: Prose.optional(),
} as const;

const StyleBibleFields = z.object(styleBibleShape);

export const StyleBible = StyleBibleFields.superRefine((bible, ctx) => {
  // `parentId` says "Set when origin is forked" and nothing enforced it. A fork with no
  // parent cannot be diffed against what it forked from, which is the only reason to
  // record that it was a fork at all - and season 2's restyle stops being traceable to
  // season 1's look.
  if (bible.origin === 'forked' && bible.parentId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['parentId'],
      message: 'a forked style must name the bible it forked from',
    });
  }
});
export type StyleBible = z.infer<typeof StyleBible>;

/** Everything the checksum is computed over: the fields that change what is drawn. */
export const StyleCheckpointInput = StyleBibleFields.pick({
  visual: true,
  motion: true,
  render: true,
  prompts: true,
  seed: true,
});
export type StyleCheckpointInput = z.infer<typeof StyleCheckpointInput>;

/**
 * A candidate bible before it has an id, a checksum or a lock.
 *
 * This is the shape an LLM is asked to produce when deriving a style from reference
 * images or a wizard - the identity fields are ours to assign, not the model's.
 */
export const StyleBibleDraft = StyleBibleFields.omit({
  id: true,
  checksum: true,
  lockedAt: true,
  createdAt: true,
  version: true,
  parentId: true,
});
export type StyleBibleDraft = z.infer<typeof StyleBibleDraft>;
