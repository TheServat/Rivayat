import { FixedClock, instant } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { RenderArtifact } from '@rv/contracts';

import type { MediaProbe } from '../encode/ffprobe';
import { MANIFEST_VERSION, buildManifest, serialiseManifest, type DeliveryEntry } from './manifest';

const CLOCK = new FixedClock(instant(1_760_000_000_000));

const PROBE: MediaProbe = {
  width: 1080,
  height: 1920,
  codecName: 'h264',
  pixelFormat: 'yuv420p',
  fps: 30,
  durationMs: 4000,
  bitrateBps: 10_000_000,
  frameCount: 120,
  hasAudio: false,
};

const ARTIFACT: RenderArtifact = {
  kind: 'delivery',
  format: 'reels-9x16',
  path: 'projects/p/deliver/e/reels-9x16.mp4',
  sha256: 'a'.repeat(64),
  bytes: 1024,
  durationMs: 4000,
  size: { width: 1080, height: 1920 },
  frameCount: 120,
  encode: {
    codec: 'h264',
    container: 'mp4',
    rateControl: { mode: 'crf', crf: 20 },
    pixelFormat: 'yuv420p',
    colorRange: 'limited',
    fps: 30,
    gopSeconds: 2,
    audioCodec: 'none',
    audioBitrateKbps: 192,
    loudness: { integratedLufs: -23, truePeakDbtp: -1, loudnessRangeLu: 7 },
  },
  createdAt: '2026-08-23T00:00:00.000Z',
};

const SOURCE = {
  masterPath: 'projects/p/render/e/master.mov',
  masterSha256: 'b'.repeat(64),
  animationId: 'anm_1',
  compositionSize: { width: 2400, height: 1800 },
  frameCount: 120,
};

function entry(overrides: Partial<DeliveryEntry> = {}): DeliveryEntry {
  return {
    format: 'reels-9x16',
    artifact: ARTIFACT,
    probe: PROBE,
    issues: [],
    needsReview: false,
    strategies: { sht_1: 'crop' },
    ...overrides,
  };
}

describe('buildManifest', () => {
  it('records what was produced and what it was cut from', () => {
    // "From what" is the half that matters: it makes a surprising crop traceable
    // without re-running the delivery.
    const manifest = buildManifest(SOURCE, [entry()], CLOCK);
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.source).toEqual(SOURCE);
    expect(manifest.entries[0]?.strategies).toEqual({ sht_1: 'crop' });
    expect(manifest.createdAt).toBe(new Date(1_760_000_000_000).toISOString());
  });

  it('is clean when every entry is clean', () => {
    expect(buildManifest(SOURCE, [entry()], CLOCK).needsAttention).toBe(false);
  });

  it('flags a plan that needs review', () => {
    expect(buildManifest(SOURCE, [entry({ needsReview: true })], CLOCK).needsAttention).toBe(true);
  });

  it('flags an output that failed its spec', () => {
    const failing = entry({
      issues: [
        { code: 'resolution-mismatch', severity: 'error', message: '', expected: 'a', actual: 'b' },
      ],
    });
    expect(buildManifest(SOURCE, [failing], CLOCK).needsAttention).toBe(true);
  });

  it('does not flag on a warning alone', () => {
    const warned = entry({
      issues: [
        { code: 'bitrate-out-of-range', severity: 'warning', message: '', expected: 1, actual: 2 },
      ],
    });
    expect(buildManifest(SOURCE, [warned], CLOCK).needsAttention).toBe(false);
  });
});

describe('serialiseManifest', () => {
  it('sorts keys, so two identical deliveries produce identical manifests', () => {
    // `JSON.stringify` follows insertion order, which is stable until someone adds a
    // field in the middle of a literal.
    const manifest = buildManifest(SOURCE, [entry()], CLOCK);
    const shuffled = buildManifest({ ...SOURCE }, [{ ...entry() }], CLOCK);
    expect(serialiseManifest(manifest)).toBe(serialiseManifest(shuffled));
    const keys = Object.keys(JSON.parse(serialiseManifest(manifest)) as object);
    expect(keys).toEqual([...keys].sort());
  });

  it('ends with a newline, so the file is well-formed text', () => {
    expect(serialiseManifest(buildManifest(SOURCE, [entry()], CLOCK)).endsWith('\n')).toBe(true);
  });
});
