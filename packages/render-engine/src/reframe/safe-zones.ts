/**
 * Safe zones as data the UI can draw, and as a check that runs before the render.
 *
 * The numbers are not restated here. `FORMAT_PRESETS` in `@rv/contracts` holds them,
 * verified live on 2026-08-23 (research §7): the universal vertical safe zone is
 * **900x1400 centred inside 1080x1920**, and TikTok additionally excludes the top 15 %,
 * bottom 20 % and right 15 %. Copying those into a second table is how the two versions
 * start disagreeing, so this module reads the presets and does arithmetic on them.
 *
 * The point of validating *before* rendering is RV-166's, and it is a good one: "I do
 * not discover a cropped face after a 20-minute render." Solving a plan costs
 * microseconds and rendering costs minutes, so every check that can be expressed on the
 * plan belongs here rather than on the output.
 */

import {
  FORMAT_PRESETS,
  type ExclusionZone,
  type FormatProfileId,
  type NormRect,
} from '@rv/contracts';

import type { ReframeInput } from './reframe-plan';
import { buildReframePlan } from './reframe-plan';
import type { SolveOptions } from './solve-crop';

/** Everything an overlay needs to draw a format's guides. */
export interface SafeZoneTemplate {
  readonly format: FormatProfileId;
  readonly frame: { readonly width: number; readonly height: number };
  /** Already excludes every rect in {@link exclusions}. */
  readonly safeArea: NormRect;
  /** The platform chrome that carved the safe area out, so the UI can label it. */
  readonly exclusions: readonly ExclusionZone[];
  /** The same rectangles in pixels, because an overlay draws in pixels. */
  readonly safeAreaPx: { x: number; y: number; width: number; height: number };
}

export function safeZoneTemplate(format: FormatProfileId): SafeZoneTemplate {
  const profile = FORMAT_PRESETS[format];
  return {
    format,
    frame: profile.size,
    safeArea: profile.safeArea,
    exclusions: profile.exclusions,
    safeAreaPx: {
      x: Math.round(profile.safeArea.x * profile.size.width),
      y: Math.round(profile.safeArea.y * profile.size.height),
      width: Math.round(profile.safeArea.width * profile.size.width),
      height: Math.round(profile.safeArea.height * profile.size.height),
    },
  };
}

export function allSafeZoneTemplates(): readonly SafeZoneTemplate[] {
  return (Object.keys(FORMAT_PRESETS) as FormatProfileId[]).map(safeZoneTemplate);
}

// ── pre-render validation ───────────────────────────────────────────────────

export type DeliveryIssueSeverity = 'error' | 'warning';

/**
 * A problem, named precisely enough to fix.
 *
 * Structured rather than a sentence: CLAUDE.md §3 requires tests to assert on fields
 * rather than wording, and a UI that wants to jump to the offending shot needs the id,
 * not a string it has to parse.
 */
export interface DeliveryIssue {
  readonly severity: DeliveryIssueSeverity;
  readonly code: 'safe-area-violation' | 'duration-exceeded' | 'codec-not-allowed' | 'no-shots';
  readonly format: FormatProfileId;
  /** `null` for an issue about the whole delivery rather than one shot. */
  readonly shotId: string | null;
  readonly message: string;
  readonly detail: Readonly<Record<string, number | string>>;
}

/**
 * Everything checkable before a frame is drawn, for one format.
 *
 * Duration first: it is the cheapest check and the one that invalidates the whole
 * export. A 95-second episode cannot go to Reels at all (90 s), so solving seven crops
 * for it is wasted work and a misleading green tick.
 */
export function validateDelivery(
  input: ReframeInput,
  format: FormatProfileId,
  totalDurationMs: number,
  options: SolveOptions = {},
): readonly DeliveryIssue[] {
  const profile = FORMAT_PRESETS[format];
  const issues: DeliveryIssue[] = [];

  if (profile.maxDurationMs !== null && totalDurationMs > profile.maxDurationMs) {
    issues.push({
      severity: 'error',
      code: 'duration-exceeded',
      format,
      shotId: null,
      message: `${profile.label} allows ${String(profile.maxDurationMs)}ms; this composition is ${String(totalDurationMs)}ms`,
      detail: {
        limitMs: profile.maxDurationMs,
        actualMs: totalDurationMs,
        overageMs: totalDurationMs - profile.maxDurationMs,
      },
    });
  }

  if (input.shots.length === 0) {
    issues.push({
      severity: 'error',
      code: 'no-shots',
      format,
      shotId: null,
      message: 'the composition contains no shots to reframe',
      detail: {},
    });
    return issues;
  }

  const plan = buildReframePlan(input, profile, options);
  /* c8 ignore next -- the only failure `buildReframePlan` reports is an empty shot
     list, which the branch above already returned on. */
  if (!plan.ok) return issues;

  for (const shot of plan.value.shots) {
    if (!shot.safeAreaViolation) continue;
    issues.push({
      severity: 'error',
      code: 'safe-area-violation',
      format,
      shotId: shot.shotId,
      message: `${shot.shotId} cannot keep its focus target inside the ${profile.label} safe area`,
      detail: {
        strategy: shot.strategy,
        focusX: shot.focusPoint.x,
        focusY: shot.focusPoint.y,
      },
    });
  }

  return issues;
}

/**
 * The same check across every requested format.
 *
 * Returned as one flat list rather than grouped: the CLI prints a per-profile table and
 * the API returns JSON, and both would rather group it themselves than un-group a map.
 */
export function validateAllDeliveries(
  input: ReframeInput,
  formats: readonly FormatProfileId[],
  totalDurationMs: number,
  options: SolveOptions = {},
): readonly DeliveryIssue[] {
  return formats.flatMap((format) => validateDelivery(input, format, totalDurationMs, options));
}

/** True when nothing would stop this delivery. The CLI's exit code. */
export function isDeliverable(issues: readonly DeliveryIssue[]): boolean {
  return !issues.some((issue) => issue.severity === 'error');
}
