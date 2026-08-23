/**
 * The crop solver: one composition, one delivery format, one shot.
 *
 * This is the piece the whole architecture is arranged around. Research §7's finding -
 * compose once in a format-agnostic scene space, re-frame per platform - is only worth
 * anything if the re-framing is *computed and checkable*. So the solver is written as a
 * constraint problem with a closed-form answer rather than as a heuristic:
 *
 * For a crop of width `w` at offset `x`, a focus rectangle `F` maps into the target
 * frame at `((F.x - x) / w, F.width / w)`. Requiring that to sit inside the safe area
 * `S` gives two inequalities, and solving them for `x` gives a closed interval:
 *
 * ```
 *   x ≤ F.x - S.x·w                       (focus does not run off the safe area's left)
 *   x ≥ F.x + F.width - (S.x + S.width)·w (nor off its right)
 * ```
 *
 * which is non-empty exactly when `F.width ≤ S.width·w`. The same holds vertically.
 * Everything else here is bookkeeping around those four lines: intersecting the
 * intervals over a moving subject, deciding between a static crop and a pan, and
 * saying so honestly when no crop exists.
 *
 * ## Why the crop size is never searched
 *
 * The solver only ever considers the *largest* crop of the target aspect. Zooming in
 * shrinks `w`, which makes `F.width ≤ S.width·w` strictly harder to satisfy - so a
 * tighter crop is never more feasible, only more presumptuous. The one case a crop
 * cannot serve at all (a focus region too wide for the safe area at full size) is
 * answered by letterboxing, not by zooming further in.
 *
 * ## Why a pan is two rectangles and not a per-frame solution
 *
 * Solving the crop independently at every frame produces a mathematically valid answer
 * that jitters: consecutive frames pick different points inside their feasible
 * intervals and the camera vibrates. The crop is therefore a **continuous function of
 * shot progress** by construction - two endpoints and a smoothstep - so continuity is a
 * property of the representation rather than something a post-pass has to smooth.
 */

import type { FocusPriority, NormRect, Size } from '@rv/contracts';

import {
  EPSILON,
  SMOOTHSTEP_PEAK_SLOPE,
  clamp,
  clamp01,
  containFit,
  contains,
  intersectIntervals,
  lerpRect,
  mapIntoCrop,
  mapIntoFit,
  maximalCrop,
  rectCentre,
  type Interval,
} from './geometry';

/** Where the subject is at one instant, in composition-space fractions. */
export interface FocusSample {
  /** Milliseconds from the start of the shot. */
  readonly timeMs: number;
  readonly region: NormRect;
}

export interface ShotFraming {
  readonly shotId: string;
  /** Milliseconds from the start of the composition. */
  readonly startMs: number;
  readonly durationMs: number;
  /** The composition-space region no crop should cut into. Advisory: it becomes a note. */
  readonly safeArea: NormRect;
  /** At least one. A single sample is a static subject. */
  readonly focus: readonly FocusSample[];
  readonly priority: FocusPriority;
  /** A hand-authored crop for this format, from `SceneSpace.overrides`. Wins outright. */
  readonly override?: NormRect;
}

export interface SolveOptions {
  /**
   * Ceiling on how fast the crop may travel, as a fraction of the composition per
   * second. A pan faster than this reads as a whip rather than a follow, so it is
   * clamped and the shot is flagged instead of shipping the whip.
   */
  readonly maxPanPerSecond?: number;
}

const DEFAULT_MAX_PAN_PER_SECOND = 0.25;

export type SolvedStrategy = 'crop' | 'pan-scan' | 'letterbox' | 'pillarbox';

export interface SolvedCrop {
  readonly strategy: SolvedStrategy;
  readonly sourceCrop: NormRect;
  /** `null` for anything static. Always the same size as `sourceCrop`. */
  readonly panTo: NormRect | null;
  /** The focus centre's landing point in the target frame, at the middle of the shot. */
  readonly focusPoint: { readonly x: number; readonly y: number };
  /** Composition pixels to target pixels. Above 1 means the crop was enlarged to fill. */
  readonly scale: number;
  readonly safeAreaViolation: boolean;
  readonly notes: readonly string[];
}

/**
 * Solve one shot against one format.
 *
 * Order of preference is `crop`, then `pan-scan`, then a letterbox, then a flagged
 * best effort - which is `ReframeStrategy`'s own documented ordering: "crop. Always
 * preferred: nothing moves that the author did not move."
 */
export function solveShotCrop(
  shot: ShotFraming,
  composition: Size,
  target: Size,
  safeArea: NormRect,
  options: SolveOptions = {},
): SolvedCrop {
  const notes: string[] = [];
  const size = maximalCrop(composition, target);
  const scaleFor = (cropWidth: number): number =>
    Math.min(8, target.width / Math.max(cropWidth * composition.width, 1e-9));

  if (shot.override !== undefined) {
    // A hand-authored crop is a decision, not a suggestion. It is still *measured* -
    // silently shipping an override that cuts the subject would defeat the flag.
    const mapped = mapIntoCrop(midFocus(shot).region, shot.override);
    const violated = !contains(safeArea, mapped);
    if (violated) notes.push(`manual crop for ${shot.shotId} does not hold the focus target`);
    return {
      strategy: 'crop',
      sourceCrop: shot.override,
      panTo: null,
      focusPoint: clampPoint(rectCentre(mapped)),
      scale: scaleFor(shot.override.width),
      safeAreaViolation: applyPriority(violated, shot.priority, notes, shot.shotId),
      notes,
    };
  }

  const feasible = shot.focus.map((sample) => ({
    sample,
    x: feasibleInterval(
      sample.region.x,
      sample.region.width,
      safeArea.x,
      safeArea.width,
      size.width,
    ),
    y: feasibleInterval(
      sample.region.y,
      sample.region.height,
      safeArea.y,
      safeArea.height,
      size.height,
    ),
  }));

  const everySampleFits = feasible.every((entry) => entry.x !== null && entry.y !== null);

  if (!everySampleFits) {
    return letterboxOrFail(shot, composition, target, safeArea, notes, scaleFor);
  }

  // ── a single static crop, if one satisfies every sample ───────────────────
  const staticX = intersectAll(feasible.map((entry) => entry.x));
  const staticY = intersectAll(feasible.map((entry) => entry.y));

  if (staticX !== null && staticY !== null) {
    const crop = {
      x: clamp(
        idealOffset(meanCentre(shot, 'x'), safeArea.x, safeArea.width, size.width),
        staticX.low,
        staticX.high,
      ),
      y: clamp(
        idealOffset(meanCentre(shot, 'y'), safeArea.y, safeArea.height, size.height),
        staticY.low,
        staticY.high,
      ),
      width: size.width,
      height: size.height,
    };
    noteSafeAreaLoss(shot, crop, notes);
    return {
      strategy: 'crop',
      sourceCrop: crop,
      panTo: null,
      focusPoint: clampPoint(rectCentre(mapIntoCrop(midFocus(shot).region, crop))),
      scale: scaleFor(size.width),
      safeAreaViolation: false,
      notes,
    };
  }

  // ── the crop has to travel ────────────────────────────────────────────────
  return solvePan(shot, composition, target, safeArea, size, feasible, notes, scaleFor, options);
}

// ── the constraint ──────────────────────────────────────────────────────────

/**
 * The interval of crop offsets that hold this focus extent inside the safe area.
 *
 * `null` when the focus is simply too big for the safe area at this crop size - the one
 * genuinely infeasible case, and the one that sends the shot to a letterbox.
 */
export function feasibleInterval(
  focusStart: number,
  focusExtent: number,
  safeStart: number,
  safeExtent: number,
  cropExtent: number,
): Interval | null {
  if (focusExtent > safeExtent * cropExtent + EPSILON) return null;
  const low = Math.max(0, focusStart + focusExtent - (safeStart + safeExtent) * cropExtent);
  const high = Math.min(1 - cropExtent, focusStart - safeStart * cropExtent);
  // The composition's own edges can rule out an otherwise valid interval: a subject at
  // the very edge of the canvas cannot be centred, because there is nothing beside it.
  return high < low - EPSILON ? null : { low, high: Math.max(low, high) };
}

function intersectAll(intervals: readonly (Interval | null)[]): Interval | null {
  let current: Interval | null = { low: 0, high: 1 };
  for (const interval of intervals) {
    if (interval === null || current === null) return null;
    current = intersectIntervals(current, interval);
  }
  return current;
}

/** The offset that puts the focus centre on the safe area's centre. */
function idealOffset(
  focusCentre: number,
  safeStart: number,
  safeExtent: number,
  cropExtent: number,
): number {
  return focusCentre - (safeStart + safeExtent / 2) * cropExtent;
}

// ── panning ─────────────────────────────────────────────────────────────────

interface FeasibleSample {
  readonly sample: FocusSample;
  readonly x: Interval | null;
  readonly y: Interval | null;
}

function solvePan(
  shot: ShotFraming,
  composition: Size,
  target: Size,
  safeArea: NormRect,
  size: { width: number; height: number },
  feasible: readonly FeasibleSample[],
  notes: string[],
  scaleFor: (cropWidth: number) => number,
  options: SolveOptions,
): SolvedCrop {
  const first = feasible[0];
  const last = feasible[feasible.length - 1];
  /* c8 ignore next -- `focus` carries at least one sample by construction; this keeps
     the narrowing honest without inventing an unreachable behaviour. */
  if (first === undefined || last === undefined)
    throw new Error('a shot must carry a focus sample');

  const endpoint = (entry: FeasibleSample): NormRect => ({
    x: pinned(
      entry.x,
      idealOffset(rectCentre(entry.sample.region).x, safeArea.x, safeArea.width, size.width),
    ),
    y: pinned(
      entry.y,
      idealOffset(rectCentre(entry.sample.region).y, safeArea.y, safeArea.height, size.height),
    ),
    width: size.width,
    height: size.height,
  });

  const from = endpoint(first);
  let to = endpoint(last);

  // ── velocity ceiling ──────────────────────────────────────────────────────
  const seconds = Math.max(shot.durationMs, 1) / 1000;
  const maxTravel = (options.maxPanPerSecond ?? DEFAULT_MAX_PAN_PER_SECOND) * seconds;
  // Smoothstep peaks at 1.5x the average slope, so the *peak* velocity is what has to
  // clear the ceiling - checking the average would let a fast middle through.
  const travel = Math.hypot(to.x - from.x, to.y - from.y) * SMOOTHSTEP_PEAK_SLOPE;
  let clampedPan = false;
  if (travel > maxTravel + EPSILON && travel > 0) {
    const factor = maxTravel / travel;
    to = {
      ...to,
      x: from.x + (to.x - from.x) * factor,
      y: from.y + (to.y - from.y) * factor,
    };
    clampedPan = true;
    notes.push(
      `pan for ${shot.shotId} exceeded ${String(options.maxPanPerSecond ?? DEFAULT_MAX_PAN_PER_SECOND)}/s and was clamped`,
    );
  }

  // ── verify the whole path, not just its ends ──────────────────────────────
  const span = Math.max(last.sample.timeMs - first.sample.timeMs, 1);
  let violated = clampedPan;
  for (const entry of feasible) {
    const progress = (entry.sample.timeMs - first.sample.timeMs) / span;
    const crop = lerpRect(from, to, progress);
    if (!contains(safeArea, mapIntoCrop(entry.sample.region, crop))) {
      violated = true;
      notes.push(
        `focus leaves the safe area at ${String(Math.round(entry.sample.timeMs))}ms of ${shot.shotId}`,
      );
      break;
    }
  }

  noteSafeAreaLoss(shot, from, notes);
  const midCrop = lerpRect(from, to, 0.5);

  return {
    strategy: 'pan-scan',
    sourceCrop: from,
    panTo: to,
    focusPoint: clampPoint(rectCentre(mapIntoCrop(midFocus(shot).region, midCrop))),
    scale: scaleFor(size.width),
    safeAreaViolation: applyPriority(violated, shot.priority, notes, shot.shotId),
    notes,
  };
}

/** The endpoint offset, pinned into its feasible interval. */
function pinned(interval: Interval | null, ideal: number): number {
  /* c8 ignore next -- `solvePan` is only reached once every sample is feasible. */
  if (interval === null) return clamp01(ideal);
  return clamp(ideal, interval.low, interval.high);
}

// ── the fallback ────────────────────────────────────────────────────────────

/**
 * When no crop can hold the subject, keep the whole composition instead.
 *
 * A letterbox is a real answer, not a failure: a wide two-shot that will not survive a
 * 9:16 crop is better delivered whole with bars than delivered with one of the two
 * faces cut off. It is only when even the letterboxed focus misses the safe area - the
 * platform's chrome covers it wherever it goes - that the shot is genuinely unsolvable
 * and gets flagged.
 */
function letterboxOrFail(
  shot: ShotFraming,
  composition: Size,
  target: Size,
  safeArea: NormRect,
  notes: string[],
  scaleFor: (cropWidth: number) => number,
): SolvedCrop {
  const fit = containFit(composition, target);
  const focus = midFocus(shot).region;
  const mapped = mapIntoFit(focus, fit);
  const violated = !contains(safeArea, mapped);

  notes.push(
    violated
      ? `no crop or fit holds the focus target of ${shot.shotId} inside the safe area`
      : `${shot.shotId} is letterboxed: the focus region is too wide for a crop`,
  );

  return {
    // Bars top and bottom when the composition is the wider of the two; sides otherwise.
    strategy: fit.height < fit.width ? 'letterbox' : 'pillarbox',
    sourceCrop: { x: 0, y: 0, width: 1, height: 1 },
    panTo: null,
    focusPoint: clampPoint(rectCentre(mapped)),
    scale: scaleFor(1),
    safeAreaViolation: applyPriority(violated, shot.priority, notes, shot.shotId),
    notes,
  };
}

// ── shared bookkeeping ──────────────────────────────────────────────────────

/**
 * `FocusPriority` decides whether a miss is an error or a shrug.
 *
 * Straight from the schema's own words: "'must-keep' fails the crop, 'prefer'
 * penalises it, 'optional' ignores it."
 */
function applyPriority(
  violated: boolean,
  priority: FocusPriority,
  notes: string[],
  shotId: string,
): boolean {
  if (!violated) return false;
  switch (priority) {
    case 'must-keep':
      return true;
    case 'prefer':
      notes.push(`${shotId}: focus is "prefer" and was not fully held`);
      return true;
    case 'optional':
      notes.push(`${shotId}: focus is "optional"; the miss is accepted`);
      return false;
  }
}

/** A note - never a violation - when the crop eats into the shot's declared safe area. */
function noteSafeAreaLoss(shot: ShotFraming, crop: NormRect, notes: string[]): void {
  if (!contains(crop, shot.safeArea)) {
    notes.push(`${shot.shotId}: the crop cuts into the shot's declared safe area`);
  }
}

function midFocus(shot: ShotFraming): FocusSample {
  const sample = shot.focus[Math.floor(shot.focus.length / 2)] ?? shot.focus[0];
  /* c8 ignore next -- `focus` is non-empty by construction. */
  if (sample === undefined) throw new Error('a shot must carry a focus sample');
  return sample;
}

function meanCentre(shot: ShotFraming, axis: 'x' | 'y'): number {
  const total = shot.focus.reduce((sum, sample) => sum + rectCentre(sample.region)[axis], 0);
  return total / shot.focus.length;
}

function clampPoint(point: { x: number; y: number }): { x: number; y: number } {
  // `ShotReframe.focusPoint` is `Unit01`, so a focus that lands outside the frame has
  // to be reported at the edge rather than as an out-of-range number the schema would
  // reject. The violation flag is what carries the fact that it missed.
  return { x: clamp01(point.x), y: clamp01(point.y) };
}

/**
 * The crop at a point in the shot, `0` at its start and `1` at its end.
 *
 * The public form of the continuity guarantee: callers get the crop from this function
 * rather than solving one themselves, so there is exactly one interpolation in the
 * system and the FFmpeg filter, the preview overlay and the test all agree.
 */
export function cropAtProgress(
  solved: {
    readonly sourceCrop: NormRect;
    readonly panTo: NormRect | null;
  },
  progress: number,
): NormRect {
  return solved.panTo === null
    ? solved.sourceCrop
    : lerpRect(solved.sourceCrop, solved.panTo, progress);
}
