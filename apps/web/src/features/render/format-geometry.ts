/**
 * The arithmetic behind a format preview.
 *
 * Every number a preview draws is derived from `FORMAT_PRESETS` in `@rv/contracts` -
 * the table research 7 verified live on 2026-08-23 - and never restated here. That
 * rule is the whole point of the module: a preview whose safe area is a hand-typed
 * `0.13` is a preview that stops agreeing with the renderer the first time a platform
 * moves its caption rail, and the failure is invisible until something is published
 * with a face behind the follow button.
 *
 * `@rv/render-engine`'s `safeZoneTemplate` does the same pixel conversion for the CLI.
 * The studio may not import it (`apps/web` is server-code-free, and `app.spec.ts`
 * fails the build on the import), so the conversion is re-derived from the same source
 * table rather than the numbers being copied. Two functions reading one table cannot
 * drift; two tables can.
 *
 * Everything here is pure and total. That is deliberate - the safe-area geometry is
 * the part of this screen that is *checkable*, so it is tested as arithmetic in
 * `format-geometry.spec.ts` rather than by looking at a screenshot.
 */

import type { FormatProfile, NormRect, ReframeStrategy, ShotReframe, Size } from '@rv/contracts';

/** A rectangle in a delivery format's own pixel grid. May extend outside the frame. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** An exclusion zone converted to the frame's pixels, keeping the platform's own name. */
export interface PixelZone {
  /** The name the profile gives it, e.g. `right action rail`. Not user-facing text. */
  readonly name: string;
  readonly rect: PixelRect;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * `-0` back to `0`.
 *
 * Negating a zero offset produces negative zero, which is equal to zero everywhere
 * except in a deep-equality assertion and in the SVG attribute it is serialised into.
 * `x="-0"` is legal and renders identically, but a test that reads the attribute back
 * would be comparing against a string nobody would think to write.
 */
function unsignZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * A normalised rectangle in the frame's pixels.
 *
 * Rounded, because an overlay draws on a pixel grid and `0.08333… x 1080 = 89.999…`
 * renders as a hairline gap between the frame edge and the zone beside it.
 */
export function toPixels(rect: NormRect, size: Size): PixelRect {
  return {
    x: Math.round(rect.x * size.width),
    y: Math.round(rect.y * size.height),
    width: Math.round(rect.width * size.width),
    height: Math.round(rect.height * size.height),
  };
}

/** The region guaranteed clear of platform UI, in this format's pixels. */
export function safeAreaPx(profile: FormatProfile): PixelRect {
  return toPixels(profile.safeArea, profile.size);
}

/** The chrome that carved the safe area out, in this format's pixels. */
export function exclusionsPx(profile: FormatProfile): readonly PixelZone[] {
  return profile.exclusions.map((zone) => ({
    name: zone.name,
    rect: toPixels(zone.rect, profile.size),
  }));
}

/** How much of the frame the safe area is, as a fraction. `1` for an unobstructed format. */
export function safeAreaFraction(profile: FormatProfile): number {
  return clamp01(profile.safeArea.width) * clamp01(profile.safeArea.height);
}

/**
 * The share of the frame the platform's own interface covers.
 *
 * A **union**, not a sum. TikTok's three zones overlap at the corners - the right
 * action rail runs the full height and so crosses both the top chrome and the caption
 * rail - and adding their areas reports 50 % where the truth is 45 %. Overstating how
 * much of the frame is unusable is not a safe error: it is the number a user decides
 * their composition against.
 *
 * Exact rather than sampled: the distinct edges of the rectangles are the only places
 * coverage can change, so compressing the coordinates to those edges and testing one
 * point per cell is a complete answer for any set of axis-aligned rectangles.
 */
export function coveredFraction(rects: readonly NormRect[]): number {
  if (rects.length === 0) return 0;

  const clamped = rects.map((rect) => ({
    x0: clamp01(rect.x),
    y0: clamp01(rect.y),
    x1: clamp01(rect.x + rect.width),
    y1: clamp01(rect.y + rect.height),
  }));

  const edges = (pick: (r: (typeof clamped)[number]) => readonly [number, number]): number[] =>
    [...new Set([0, 1, ...clamped.flatMap((rect) => pick(rect))])].sort((a, b) => a - b);

  const xs = edges((rect) => [rect.x0, rect.x1]);
  const ys = edges((rect) => [rect.y0, rect.y1]);

  let area = 0;
  for (let i = 0; i + 1 < xs.length; i += 1) {
    const left = xs[i] ?? 0;
    const right = xs[i + 1] ?? 0;
    const midX = (left + right) / 2;
    for (let j = 0; j + 1 < ys.length; j += 1) {
      const top = ys[j] ?? 0;
      const bottom = ys[j + 1] ?? 0;
      const midY = (top + bottom) / 2;
      const covered = clamped.some(
        (rect) => midX > rect.x0 && midX < rect.x1 && midY > rect.y0 && midY < rect.y1,
      );
      if (covered) area += (right - left) * (bottom - top);
    }
  }
  return area;
}

/**
 * The largest size of `subject`'s aspect that fits inside `box`.
 *
 * How seven frames of four different aspects are laid out side by side and still read
 * as *their own shape*: every one is contained in the same box, so a 16:9 card and a
 * 9:16 card differ by exactly the ratio the platform states and nothing else.
 */
export function containedSize(subject: Size, box: Size): Size {
  const scale = Math.min(box.width / subject.width, box.height / subject.height);
  return { width: subject.width * scale, height: subject.height * scale };
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * `1920x1080` -> `16:9`, computed rather than read from `aspectRatio`.
 *
 * `format.spec.ts` upstream already asserts that every preset's declared ratio equals
 * its own width over height. This recomputes it so the *preview* is drawn from the
 * pixel size it will actually encode at, and so the spec beside this file can assert
 * the two agree from the studio's side too.
 */
export function reduceRatio(size: Size): string {
  const divisor = greatestCommonDivisor(Math.round(size.width), Math.round(size.height));
  return `${String(Math.round(size.width) / divisor)}:${String(Math.round(size.height) / divisor)}`;
}

/**
 * Where the whole composition lands inside the target frame, in target pixels.
 *
 * This is what makes the reframer's decision *visible* rather than a word in a badge.
 * Two cases, and they are the two answers the solver gives:
 *
 *  - **crop / pan-scan** - the chosen sub-rectangle of the composition is stretched to
 *    fill the frame, so the composition itself is larger than the frame and hangs off
 *    the edges. Drawing it that way shows exactly what was thrown away.
 *  - **letterbox / pillarbox** - no crop could hold the focus, so the whole
 *    composition is kept and centred, with bars. Drawing it that way shows the bars
 *    are a decision rather than an accident.
 *
 * `reflow` moves layout nodes instead of the camera, so its frame is the frame: it
 * shares the crop branch.
 */
export function compositionRectInTarget(
  strategy: ReframeStrategy,
  sourceCrop: NormRect,
  composition: Size,
  target: Size,
): PixelRect {
  if (strategy === 'letterbox' || strategy === 'pillarbox') {
    const fit = containedSize(composition, target);
    return {
      x: (target.width - fit.width) / 2,
      y: (target.height - fit.height) / 2,
      width: fit.width,
      height: fit.height,
    };
  }

  // A zero-extent crop cannot be inverted. The schema forbids one, so this is a guard
  // against a hand-edited plan rather than a case the solver produces.
  const width = sourceCrop.width <= 0 ? 1 : sourceCrop.width;
  const height = sourceCrop.height <= 0 ? 1 : sourceCrop.height;
  return {
    x: unsignZero((-sourceCrop.x / width) * target.width),
    y: unsignZero((-sourceCrop.y / height) * target.height),
    width: target.width / width,
    height: target.height / height,
  };
}

/** Where the focus target lands in the delivered frame, in that frame's pixels. */
export function focusPointPx(
  focusPoint: { readonly x: number; readonly y: number },
  size: Size,
): { readonly x: number; readonly y: number } {
  return { x: focusPoint.x * size.width, y: focusPoint.y * size.height };
}

/** True when the point sits inside the rectangle. Edges count as inside. */
export function containsPoint(
  rect: NormRect,
  point: { readonly x: number; readonly y: number },
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * The plan's verdict for one format, reduced to the three answers a card can show.
 *
 * `held` and `missed` come from the solver's own `safeAreaViolation` rather than from
 * re-checking its geometry here: two implementations of one constraint is two answers,
 * and the authoritative one is the engine's. The preview draws where the focus landed;
 * it does not decide whether that was acceptable.
 */
export type ReframeVerdict = 'held' | 'missed';

export function verdictOf(shot: ShotReframe): ReframeVerdict {
  return shot.safeAreaViolation ? 'missed' : 'held';
}

/**
 * An SVG `points` list for a rectangle, so a zone can be drawn as one path.
 *
 * Preview geometry lives in SVG rather than in positioned elements for a reason that
 * is easy to get wrong: a delivered frame does **not** mirror in Persian. TikTok's
 * action rail is on the right of the screen for a Tehran viewer as much as a London
 * one, so laying the overlay out with `inset-inline-start` would flip the platform's
 * own chrome and the preview would be lying in exactly the locale the studio is used
 * in. SVG coordinates are unaffected by `direction`, which makes them the correct
 * coordinate system for a picture of a screen.
 */
export function rectPoints(rect: PixelRect): string {
  const { x, y, width, height } = rect;
  return `${String(x)},${String(y)} ${String(x + width)},${String(y)} ${String(x + width)},${String(y + height)} ${String(x)},${String(y + height)}`;
}
