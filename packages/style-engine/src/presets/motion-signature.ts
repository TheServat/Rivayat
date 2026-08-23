/**
 * How different do two styles *move*?
 *
 * A preset library where eight styles share one motion profile is eight palettes over
 * one template, and it is the exact failure the "motion is part of the style"
 * requirement exists to prevent. Eyeballing does not catch it - two motion blocks can
 * differ in six fields and still feel identical, or differ in one (`stepMode`) and feel
 * like different media entirely.
 *
 * So distinctness is measured. Every scalar in `MotionStyle` is normalised onto the
 * unit interval, every categorical field contributes a full unit when it differs, and
 * the distance is the mean over all of them. `presets.spec.ts` asserts a floor over
 * *every pair* in the library, which is a property of the set rather than a checklist
 * that can be satisfied by tweaking one preset.
 *
 * The default easing curve is folded in as four scalars because it carries more of the
 * felt difference between "snappy" and "floaty" than any of the named principles do.
 */

import type { EasingCurve, MotionStyle } from '@rv/contracts';

export interface MotionSignature {
  /** Every scalar normalised to 0..1, keyed by its dotted path. */
  readonly scalars: Readonly<Record<string, number>>;
  /** Every enum-valued field, keyed by its dotted path. */
  readonly categories: Readonly<Record<string, string>>;
}

/**
 * Below this, two presets are the same style wearing different colours.
 *
 * Calibrated against the shipped library rather than chosen a priori: the closest pair
 * in the library sits comfortably above it, and a new preset that lands underneath is
 * telling us it has nothing new to say about movement.
 */
export const MOTION_DISTINCTNESS_FLOOR = 0.12;

function unitFrom(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

function flag(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * The curve `defaultEasing` names.
 *
 * `MotionStyle`'s own refinement already guarantees the name resolves, so a miss here
 * would be a schema bug rather than bad data - falling back to the first curve keeps
 * the signature total without pretending the miss did not happen.
 */
function defaultCurve(motion: MotionStyle): EasingCurve | undefined {
  return motion.easings.find((curve) => curve.name === motion.defaultEasing) ?? motion.easings[0];
}

export function motionSignature(motion: MotionStyle): MotionSignature {
  const curve = defaultCurve(motion);
  const principles = motion.principles;
  const ambient = motion.ambient;
  const camera = motion.camera;

  return {
    scalars: {
      fps: unitFrom(motion.fps, 6, 60),
      tempo: unitFrom(motion.tempo, 0.25, 4),

      'principles.squashStretch': principles.squashStretch,
      'principles.anticipation': principles.anticipation,
      'principles.followThrough': principles.followThrough,
      'principles.overshoot': principles.overshoot,
      'principles.secondaryMotion': principles.secondaryMotion,
      'principles.arcBias': principles.arcBias,
      'principles.holdBias': principles.holdBias,
      'principles.weight': principles.weight,

      'boil.enabled': flag(motion.boil.enabled),
      // Amplitude and rate only mean anything while boil is on; zeroing them when it is
      // off stops two styles that both have boil disabled from reading as different
      // because one of them left a stale amplitude behind.
      'boil.amplitude': motion.boil.enabled ? motion.boil.amplitude : 0,
      'boil.hz': motion.boil.enabled ? unitFrom(motion.boil.hz, 0, 24) : 0,
      'boil.affectsFills': motion.boil.enabled ? flag(motion.boil.affectsFills) : 0,

      'ambient.windHz': unitFrom(ambient.windHz, 0, 4),
      'ambient.windAmplitude': ambient.windAmplitude,
      'ambient.windGustiness': ambient.windGustiness,
      'ambient.breathHz': unitFrom(ambient.breathHz, 0, 2),
      'ambient.blinkIntervalMs': unitFrom(ambient.blinkIntervalMs, 0, 12_000),
      'ambient.idleAmplitude': ambient.idleAmplitude,
      'ambient.phaseByDepth': ambient.phaseByDepth,

      'camera.parallaxStrength': camera.parallaxStrength,
      'camera.shakeAmplitude': camera.shakeAmplitude,
      'camera.defaultShotMs': unitFrom(camera.defaultShotMs, 0, 12_000),
      'camera.allowZoom': flag(camera.allowZoom),
      'camera.allowRoll': flag(camera.allowRoll),

      'easing.p1x': curve?.p1.x ?? 0,
      'easing.p1y': unitFrom(curve?.p1.y ?? 0, -4, 4),
      'easing.p2x': curve?.p2.x ?? 0,
      'easing.p2y': unitFrom(curve?.p2.y ?? 0, -4, 4),
    },
    categories: {
      stepMode: motion.stepMode,
      'camera.parallaxCurve': camera.parallaxCurve,
      'camera.cutRhythm': camera.cutRhythm,
    },
  };
}

/**
 * Dimensions that decide how a *cut* is made, not how anything *moves*.
 *
 * These are real differences between styles and they belong in `MotionStyle`, but none of
 * them changes what a viewer sees a character do. `defaultShotMs` and `cutRhythm` are
 * editing; `allowZoom` and `allowRoll` are permissions the choreographer may never use.
 *
 * They are excluded from {@link coreMotionDistance} because together they are worth
 * `4/34` of the unweighted mean - enough, on their own, to carry two otherwise identical
 * profiles over {@link MOTION_DISTINCTNESS_FLOOR}. A distinctness measure that can be
 * satisfied by changing the shot length is not measuring movement.
 */
export const EDITORIAL_DIMENSIONS: ReadonlySet<string> = new Set([
  'camera.defaultShotMs',
  'camera.allowZoom',
  'camera.allowRoll',
  'camera.cutRhythm',
]);

function meanDifference(a: MotionStyle, b: MotionStyle, include: (key: string) => boolean): number {
  const left = motionSignature(a);
  const right = motionSignature(b);

  let total = 0;
  let count = 0;

  for (const [key, value] of Object.entries(left.scalars)) {
    if (!include(key)) continue;
    total += Math.abs(value - (right.scalars[key] ?? 0));
    count += 1;
  }
  for (const [key, value] of Object.entries(left.categories)) {
    if (!include(key)) continue;
    total += value === right.categories[key] ? 0 : 1;
    count += 1;
  }

  return count === 0 ? 0 : total / count;
}

/**
 * Mean per-dimension difference between two motion profiles, 0..1.
 *
 * Unweighted on purpose. A weighting would encode an opinion about which part of
 * movement matters most, and the point of the measure is to catch a library that has no
 * opinion at all.
 *
 * This is the *whole* profile, editorial dimensions included, which is the right answer to
 * "how different are these two `MotionStyle` values". It is the wrong answer to "do these
 * two styles move differently" - see {@link coreMotionDistance}.
 */
export function motionDistance(a: MotionStyle, b: MotionStyle): number {
  return meanDifference(a, b, () => true);
}

/**
 * The same measure over the dimensions that actually govern movement.
 *
 * {@link motionDistance} is gameable in exactly one way, and it is a way a preset author
 * would stumble into rather than commit: two profiles identical in frame rate, tempo, step
 * mode, every motion principle, boil, easing, ambient life, parallax and shake still score
 * above the floor if they merely cut differently and disagree about whether the camera may
 * zoom. Nothing a viewer could point at has changed.
 *
 * So the floor is asserted on *this* number over the shipped library, and the two measures
 * are kept side by side rather than one replacing the other: the full distance is still
 * what a diff view wants to show.
 */
export function coreMotionDistance(a: MotionStyle, b: MotionStyle): number {
  return meanDifference(a, b, (key) => !EDITORIAL_DIMENSIONS.has(key));
}

/** The fields on which two profiles actually differ. For a diff view, and for test output. */
export function motionDifferences(a: MotionStyle, b: MotionStyle): readonly string[] {
  const left = motionSignature(a);
  const right = motionSignature(b);
  const out: string[] = [];

  for (const [key, value] of Object.entries(left.scalars)) {
    if (Math.abs(value - (right.scalars[key] ?? 0)) > 1e-9) out.push(key);
  }
  for (const [key, value] of Object.entries(left.categories)) {
    if (value !== right.categories[key]) out.push(key);
  }
  return out;
}
