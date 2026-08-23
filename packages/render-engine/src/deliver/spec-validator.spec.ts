import { FORMAT_PRESETS } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import type { MediaProbe } from '../encode/ffprobe';
import {
  FFPROBE_CODEC_NAMES,
  describeIssue,
  satisfiesProfile,
  validateAgainstProfile,
} from './spec-validator';

function probe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    width: 1080,
    height: 1920,
    codecName: 'h264',
    pixelFormat: 'yuv420p',
    fps: 30,
    durationMs: 30_000,
    bitrateBps: 10_000_000,
    frameCount: 900,
    hasAudio: false,
    ...overrides,
  };
}

const REELS = FORMAT_PRESETS['reels-9x16'];
const TIKTOK = FORMAT_PRESETS['tiktok-9x16'];

describe('validateAgainstProfile', () => {
  it('passes a conforming file', () => {
    expect(validateAgainstProfile(probe(), REELS)).toEqual([]);
    expect(satisfiesProfile([])).toBe(true);
  });

  it('rejects a landscape file delivered as a vertical profile', () => {
    // The specific failure the validator exists for: everything upstream reasons about
    // intent, and only a probe of the bytes can say what was written.
    const issues = validateAgainstProfile(probe({ width: 1920, height: 1080 }), REELS);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'resolution-mismatch',
      severity: 'error',
      expected: '1080x1920',
      actual: '1920x1080',
    });
  });

  it('rejects HEVC for Instagram, which takes H.264 only', () => {
    // Research §7 is emphatic about this, and `allowedCodecs` carries it as data.
    const issues = validateAgainstProfile(probe({ codecName: 'hevc' }), REELS);
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      'codec-mismatch',
      'codec-not-allowed',
    ]);
  });

  it('accepts HEVC for TikTok, which does allow it', () => {
    const issues = validateAgainstProfile(probe({ codecName: 'hevc' }), TIKTOK);
    // The profile still encodes H.264, so the file disagrees with what we meant to
    // write - but the *platform* would take it, and the two facts are reported apart.
    expect(issues.map((issue) => issue.code)).toEqual(['codec-mismatch']);
  });

  it('knows hevc and h265 are the same codec under two names', () => {
    expect(FFPROBE_CODEC_NAMES.h265).toContain('hevc');
  });

  it('rejects a frame rate that is not the delivered one', () => {
    const issues = validateAgainstProfile(probe({ fps: 29.97 }), REELS);
    expect(issues[0]).toMatchObject({ code: 'frame-rate-mismatch', expected: 30 });
  });

  it('tolerates floating-point noise in the frame rate', () => {
    expect(validateAgainstProfile(probe({ fps: 30.0001 }), REELS)).toEqual([]);
  });

  it('rejects a file longer than the platform allows', () => {
    const issues = validateAgainstProfile(probe({ durationMs: 95_000 }), REELS);
    expect(issues[0]).toMatchObject({ code: 'duration-exceeded', expected: 90_000 });
  });

  it('tolerates container rounding at the duration limit', () => {
    expect(validateAgainstProfile(probe({ durationMs: 90_050 }), REELS)).toEqual([]);
  });

  it('never complains about duration for a profile with no limit', () => {
    expect(
      validateAgainstProfile(
        probe({ width: 1920, height: 1080, durationMs: 3_600_000 }),
        FORMAT_PRESETS['yt-1080p'],
      ),
    ).toEqual([]);
  });

  it('leaves the bitrate alone unless asked, because a CRF encode is legitimately low', () => {
    expect(validateAgainstProfile(probe({ bitrateBps: 900_000 }), REELS)).toEqual([]);
    const checked = validateAgainstProfile(probe({ bitrateBps: 900_000 }), REELS, {
      checkBitrate: true,
    });
    expect(checked[0]).toMatchObject({ code: 'bitrate-out-of-range', severity: 'warning' });
  });

  it('does not fail a delivery on a bitrate warning alone', () => {
    const issues = validateAgainstProfile(probe({ bitrateBps: 900_000 }), REELS, {
      checkBitrate: true,
    });
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(satisfiesProfile(issues)).toBe(true);
  });

  it('skips the bitrate check when the file declares none', () => {
    expect(
      validateAgainstProfile(probe({ bitrateBps: null }), REELS, { checkBitrate: true }),
    ).toEqual([]);
  });

  it('reports every failure at once rather than the first', () => {
    // One misconfiguration usually breaks several fields; reporting one at a time turns
    // one fix into three runs.
    const issues = validateAgainstProfile(
      probe({ width: 640, height: 480, codecName: 'vp9', fps: 24, durationMs: 200_000 }),
      REELS,
    );
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });
});

describe('describeIssue', () => {
  it('renders a line for the CLI table', () => {
    expect(
      describeIssue({
        code: 'resolution-mismatch',
        severity: 'error',
        message: '',
        expected: '1080x1920',
        actual: '1920x1080',
      }),
    ).toBe('ERROR resolution-mismatch: expected 1080x1920, got 1920x1080');
  });
});
