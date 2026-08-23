/**
 * Does this file actually satisfy the profile it claims to?
 *
 * The failure this catches is specific and nasty: a delivery that *looks* produced -
 * the job succeeded, the manifest lists it, the file plays - and is 1920x1080 where the
 * profile says 1080x1920, or HEVC where Instagram takes H.264 only. Nothing upstream
 * notices, because everything upstream is reasoning about intent. Only a probe of the
 * finished bytes can tell you what was really written.
 *
 * So the validator never trusts the encoder's arguments, the plan, or the request. It
 * reads the file with `ffprobe` and compares that to `FORMAT_PRESETS`. The tests
 * produce a deliberately wrong output by *encoding one wrongly* rather than by faking a
 * probe, because a mocked probe would only prove the comparison compiles.
 */

import { assertNever } from '@rv/shared-kernel';
import type { FormatProfile, VideoCodec } from '@rv/contracts';

import type { MediaProbe } from '../encode/ffprobe';

/**
 * Our codec names to FFmpeg's.
 *
 * They disagree for exactly the codec people get wrong: we call it `h265`, FFmpeg calls
 * the *codec* `hevc` and the *encoder* `libx265`. A comparison that assumed the three
 * names were one name would pass a ProRes file as H.265.
 */
export const FFPROBE_CODEC_NAMES: Record<VideoCodec, readonly string[]> = {
  h264: ['h264'],
  h265: ['hevc', 'h265'],
  vp9: ['vp9'],
  av1: ['av1'],
  prores: ['prores'],
};

export type SpecIssueCode =
  | 'resolution-mismatch'
  | 'codec-mismatch'
  | 'codec-not-allowed'
  | 'frame-rate-mismatch'
  | 'duration-exceeded'
  | 'bitrate-out-of-range';

export interface SpecIssue {
  readonly code: SpecIssueCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly expected: string | number;
  readonly actual: string | number;
}

export interface ValidateSpecOptions {
  /**
   * Check the measured bitrate against the profile's declared range.
   *
   * Off unless the encode actually targeted a bitrate. A CRF encode of a mostly-static
   * cutout scene lands far below the declared floor and is *correct*: the range is what
   * the platform accepts, not a quota to fill.
   */
  readonly checkBitrate?: boolean;
  /** Frame-rate comparison tolerance. 29.97 is not 30, but 30.0001 is. */
  readonly fpsTolerance?: number;
  /** Slack on the duration limit, for container rounding. */
  readonly durationToleranceMs?: number;
}

const DEFAULT_FPS_TOLERANCE = 0.01;
const DEFAULT_DURATION_TOLERANCE_MS = 100;

/**
 * Every way this file fails its profile. Empty means it passes.
 *
 * A list rather than a first failure: "wrong resolution" and "wrong codec" are usually
 * the same misconfiguration, and reporting one at a time turns one fix into three runs.
 */
export function validateAgainstProfile(
  probe: MediaProbe,
  profile: FormatProfile,
  options: ValidateSpecOptions = {},
): readonly SpecIssue[] {
  const issues: SpecIssue[] = [];

  if (probe.width !== profile.size.width || probe.height !== profile.size.height) {
    issues.push({
      code: 'resolution-mismatch',
      severity: 'error',
      message: `${profile.label} requires ${profile.size.width}x${profile.size.height}`,
      expected: `${String(profile.size.width)}x${String(profile.size.height)}`,
      actual: `${String(probe.width)}x${String(probe.height)}`,
    });
  }

  const declared = FFPROBE_CODEC_NAMES[profile.codec];
  if (!declared.includes(probe.codecName)) {
    issues.push({
      code: 'codec-mismatch',
      severity: 'error',
      message: `${profile.label} is encoded as ${profile.codec}`,
      expected: declared.join('|'),
      actual: probe.codecName,
    });
  }

  // The platform's list, not ours. Reels declares H.264 only (research §7), so an HEVC
  // file that happens to match a mis-set `codec` is still rejected here.
  const allowed = profile.allowedCodecs.flatMap((codec) => FFPROBE_CODEC_NAMES[codec]);
  if (!allowed.includes(probe.codecName)) {
    issues.push({
      code: 'codec-not-allowed',
      severity: 'error',
      message: `${profile.platform} does not accept ${probe.codecName}`,
      expected: allowed.join('|'),
      actual: probe.codecName,
    });
  }

  const fpsTolerance = options.fpsTolerance ?? DEFAULT_FPS_TOLERANCE;
  if (Math.abs(probe.fps - profile.fps) > fpsTolerance) {
    issues.push({
      code: 'frame-rate-mismatch',
      severity: 'error',
      message: `${profile.label} is delivered at ${String(profile.fps)} fps`,
      expected: profile.fps,
      actual: probe.fps,
    });
  }

  const durationTolerance = options.durationToleranceMs ?? DEFAULT_DURATION_TOLERANCE_MS;
  if (
    profile.maxDurationMs !== null &&
    probe.durationMs > profile.maxDurationMs + durationTolerance
  ) {
    issues.push({
      code: 'duration-exceeded',
      severity: 'error',
      message: `${profile.label} allows ${String(profile.maxDurationMs)}ms`,
      expected: profile.maxDurationMs,
      actual: probe.durationMs,
    });
  }

  if (options.checkBitrate === true && probe.bitrateBps !== null) {
    const mbps = probe.bitrateBps / 1_000_000;
    if (mbps < profile.bitrateMbps.minMbps || mbps > profile.bitrateMbps.maxMbps) {
      issues.push({
        code: 'bitrate-out-of-range',
        severity: 'warning',
        message: `${profile.label} declares ${String(profile.bitrateMbps.minMbps)}-${String(profile.bitrateMbps.maxMbps)} Mbps`,
        expected: `${String(profile.bitrateMbps.minMbps)}-${String(profile.bitrateMbps.maxMbps)}`,
        actual: Number(mbps.toFixed(3)),
      });
    }
  }

  return issues;
}

/** True when nothing is wrong enough to block publishing. */
export function satisfiesProfile(issues: readonly SpecIssue[]): boolean {
  return !issues.some((issue) => issue.severity === 'error');
}

/** A one-line summary per issue, for the CLI's pass/fail table. */
export function describeIssue(issue: SpecIssue): string {
  switch (issue.severity) {
    case 'error':
    case 'warning':
      return `${issue.severity.toUpperCase()} ${issue.code}: expected ${String(issue.expected)}, got ${String(issue.actual)}`;
    default:
      return assertNever(issue.severity, 'spec issue severity');
  }
}
