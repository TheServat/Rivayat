import type { MotionStyle, Palette, StepMode } from '@rv/contracts';

/**
 * Turning a `MotionStyle` into something a card can play.
 *
 * The trap this module exists to defuse is named in `docs/06-screen-briefs.md`: eleven
 * presets carry motion profiles as distinct as their palettes, and a gallery of stills
 * throws half of that away, so the user chooses on colour and is surprised later. Every
 * number below is read off the preset rather than chosen here - a paper-cutout world
 * hinges and holds because its `stepMode` is `on-2s` and its `holdBias` is 0.7, not
 * because this file has a special case for paper.
 *
 * Everything is pure and returns plain CSS values, which is what makes it testable
 * without a browser: `motion-preview.spec.ts` asserts that two profiles which differ
 * produce presentations that differ, and that the ones which should read as *held*
 * genuinely step rather than glide.
 *
 * ## Why the card animates at all, when the house rule says machine motion steps
 *
 * `motion.css` draws the line at "the interface interpolates when a person drives it and
 * steps when the machine does". A preset card is neither: it is not chrome reporting the
 * studio's state, it is *content* - a rendering of the thing being chosen, the same way
 * the palette swatches are. So it moves the way the style moves, and the interface
 * furniture around it keeps obeying the rule.
 */

/**
 * How many distinct drawings a second this style shows.
 *
 * The whole of the difference between "looks animated" and "looks like a computer
 * interpolated it", and the one motion field that a still image can never hint at. A
 * record rather than a `switch`, per the house rule: the union stays exhaustive at the
 * type level and adding a mode is adding an entry.
 */
const FRAMES_HELD: Readonly<Record<StepMode, number>> = {
  smooth: 1,
  'on-2s': 2,
  'on-3s': 3,
  'on-4s': 4,
};

/**
 * One loop of the preview, in seconds, before tempo.
 *
 * Long enough that a held style visibly holds, short enough that eleven of them running
 * at once do not read as a fairground. Tempo divides it, so a `tempo: 0.7` woodblock
 * takes half again as long as a `tempo: 1.15` flat-vector - which is exactly what tempo
 * means.
 */
const BASE_CYCLE_SECONDS = 2;

/** Constant, on purpose: the travel is the control, so the *timing* is the variable. */
const TRAVEL_PX = 26;

/**
 * How long a style sits in a pose between moves.
 *
 * `holdBias` is the field that most decides whether something reads as *deliberate* -
 * paper cutout sits at 0.7, woodblock at 0.95, painterly at 0.25 - and it is the one a
 * still frame can hint at least. A first cut of this preview left it out entirely and
 * the contact sheet showed the cost immediately: woodblock, whose whole character is
 * that it changes all at once and then does not move, crept across its frames like
 * gouache.
 *
 * It cannot be a custom property, because what it changes is *when* the keyframes sit
 * still and keyframe offsets are not parameterisable in CSS. So it is three buckets and
 * three keyframe sets, and the bucket also decides how much of the cycle the move
 * occupies - which is what the step count is computed against, so a held style shows
 * fewer, chunkier drawings during a shorter move.
 */
export type HoldBucket = 'none' | 'some' | 'long';

const HOLD_MOVE_FRACTION: Readonly<Record<HoldBucket, number>> = {
  none: 0.5,
  some: 0.26,
  long: 0.16,
};

function holdBucketFor(holdBias: number): HoldBucket {
  if (holdBias >= 0.65) return 'long';
  if (holdBias >= 0.35) return 'some';
  return 'none';
}

export interface MotionPresentation {
  /** One loop, after tempo. Seconds. */
  readonly cycleSeconds: number;
  /** Distinct drawings a second: `fps` divided by the hold. */
  readonly imagesPerSecond: number;
  /** Which keyframe set the card runs: how much of the loop is spent in a pose. */
  readonly hold: HoldBucket;
  /** True when the style holds its drawings rather than interpolating between them. */
  readonly stepped: boolean;
  /** The CSS `animation-timing-function` the stage runs on. */
  readonly timingFunction: string;
  /** Custom properties for the card root. Empty strings are never emitted. */
  readonly vars: Readonly<Record<string, string>>;
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The style's own default curve, as a CSS `cubic-bezier`.
 *
 * `MotionStyle`'s refinement already guarantees `defaultEasing` names one of `easings`,
 * so the fallback is unreachable for valid data and present because
 * `noUncheckedIndexedAccess` is on and an unreachable branch is cheaper than an
 * assertion. Control-point `y` may sit outside 0..1 - that is anticipation and overshoot,
 * and CSS accepts it.
 */
function timingFor(motion: MotionStyle): string {
  const curve = motion.easings.find((entry) => entry.name === motion.defaultEasing);
  if (curve === undefined) return 'linear';
  return `cubic-bezier(${String(curve.p1.x)}, ${String(curve.p1.y)}, ${String(curve.p2.x)}, ${String(curve.p2.y)})`;
}

export function motionPresentation(motion: MotionStyle): MotionPresentation {
  const held = FRAMES_HELD[motion.stepMode];
  const stepped = held > 1;
  const imagesPerSecond = motion.fps / held;
  const cycleSeconds = round(BASE_CYCLE_SECONDS / motion.tempo);

  /*
   * A stepped style is quantised by the browser rather than eased by it.
   *
   * One CSS animation cannot ease *and* hold on the same segment - there is one timing
   * function per segment - so the two are split: the keyframe set supplies the hold
   * (a plateau where the transform does not change) and `steps()` supplies the cadence
   * across the segment that does. The named easing curve is drawn on the card as a line
   * as well, because a stepped style cannot express it in the animation at all.
   *
   * The alternative was emitting eleven bespoke `@keyframes` blocks at runtime, which
   * buys a subtlety nobody asked for at the price of a stylesheet nobody can read.
   */
  const principles = motion.principles;
  const hold = holdBucketFor(principles.holdBias);

  // Steps are counted over the segment the figure is actually *moving* in, not over the
  // whole half cycle: a held style makes its move in a sixth of the loop, so the same
  // drawings-per-second yields a handful of chunky poses rather than a smooth creep.
  const movingSeconds = cycleSeconds * HOLD_MOVE_FRACTION[hold];
  const stepsPerMove = Math.max(2, Math.round(imagesPerSecond * movingSeconds));
  const timingFunction = stepped ? `steps(${String(stepsPerMove)}, jump-none)` : timingFor(motion);

  const ambient = motion.ambient;

  return {
    cycleSeconds,
    imagesPerSecond,
    hold,
    stepped,
    timingFunction,
    vars: {
      '--sl-cycle': `${String(cycleSeconds)}s`,
      '--sl-timing': timingFunction,
      '--sl-travel': `${String(TRAVEL_PX)}px`,
      // Arc bias is literally how far off a straight line the move travels.
      '--sl-arc': `${String(round(1 + principles.arcBias * 13))}px`,
      // Squash on the contact, stretch at the apex. Claymation at 0.85 is unmissable;
      // woodblock at 0.05 does not deform at all, which is also the point.
      '--sl-squash': String(round(1 - principles.squashStretch * 0.24)),
      '--sl-stretch': String(round(1 + principles.squashStretch * 0.16)),
      // Weight leans the figure into the move. Heavy styles lean less and land harder.
      '--sl-lean': `${String(round(9 - principles.weight * 7))}deg`,
      '--sl-parallax': `${String(round(1 + motion.camera.parallaxStrength * 7))}px`,
      '--sl-boil': motion.boil.enabled ? `${String(round(motion.boil.amplitude * 1.8))}px` : '0px',
      // Three jitter positions per loop, so the loop lasts three redraws.
      '--sl-boil-cycle':
        motion.boil.enabled && motion.boil.hz > 0 ? `${String(round(3 / motion.boil.hz))}s` : '0s',
      // A windless style gets a zero amplitude rather than a zero duration: a
      // zero-length animation is undefined territory across engines, and an animation
      // that runs and moves nothing is not.
      '--sl-sway':
        ambient.windHz > 0 ? `${String(round(1 + ambient.windAmplitude * 9))}deg` : '0deg',
      '--sl-sway-cycle': `${String(ambient.windHz > 0 ? round(1 / ambient.windHz) : 1)}s`,
      '--sl-blink-cycle': `${String(Math.max(1, round(ambient.blinkIntervalMs / 1000)))}s`,
    },
  };
}

/**
 * Where a stepped card is parked, as a negative `animation-delay`.
 *
 * This is the whole reason the stepped mode looks like the played one: rather than
 * computing a pose with a second easing implementation - which is how a preview starts
 * disagreeing with what it previews - the animation is *paused* and seeked. The browser
 * evaluates the same keyframes through the same timing function it would have used to
 * play them, so stepping to `t` and playing to `t` cannot diverge, by construction.
 *
 * `frames` is twelve because twelve is the house cadence: a film held on 2s shows twelve
 * drawings a second, which is the rate the animation engine itself evaluates at.
 */
export const PREVIEW_FRAMES = 12;

export function frameSeek(cycleSeconds: number, frame: number, frames = PREVIEW_FRAMES): string {
  const clamped = Math.min(Math.max(frame, 0), frames - 1);
  return `${String(round((-cycleSeconds * clamped) / frames))}s`;
}

/**
 * A palette entry by the role it plays, falling back along the list.
 *
 * `Palette.colors` guarantees at least three entries and does not guarantee any
 * particular role, so a card that indexed `colors[3]` would render a hole for a
 * three-colour style. Asking for a role and degrading to a position keeps every preset
 * drawable without any preset needing to know a card exists.
 */
export function paletteColour(
  palette: Palette,
  role: NonNullable<Palette['colors'][number]['role']>,
  fallbackIndex: number,
): string {
  const byRole = palette.colors.find((colour) => colour.role === role);
  if (byRole !== undefined) return byRole.hex;
  const positional = palette.colors[fallbackIndex % palette.colors.length];
  return positional?.hex ?? palette.colors[0]?.hex ?? 'currentcolor';
}
