import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EBU_R128 } from './format';
import {
  EncodeSettings,
  FrameRange,
  RateControl,
  RenderArtifact,
  RenderBackend,
  RenderCheckpoint,
  RenderJob,
  RenderJobState,
  RenderPhase,
  RenderProgress,
  RenderRequest,
  RenderShard,
} from './render-job';

const body = (tail: string): string => tail.padStart(26, '0');
const PROJECT_ID = `prj_${body('A1')}`;
const ANIMATION_ID = `anm_${body('A2')}`;
const EPISODE_ID = `ep_${body('A3')}`;
const JOB_ID = `job_${body('A4')}`;
const RUN_ID = `run_${body('A5')}`;
const AT = '2026-08-23T10:00:00+03:30';
const SHA = 'a'.repeat(64);

const request = (overrides: Record<string, unknown> = {}): unknown => ({
  projectId: PROJECT_ID,
  animationId: ANIMATION_ID,
  formats: ['shorts-9x16'],
  quality: 'final',
  ...overrides,
});

const encode = (overrides: Record<string, unknown> = {}): unknown => ({
  codec: 'h264',
  container: 'mp4',
  rateControl: { mode: 'crf', crf: 18 },
  fps: 30,
  ...overrides,
});

const artifact = (overrides: Record<string, unknown> = {}): unknown => ({
  kind: 'delivery',
  format: 'shorts-9x16',
  path: 'workspace/renders/ep-01/shorts-9x16.mp4',
  sha256: SHA,
  bytes: 18_442_112,
  durationMs: 62_000,
  size: { width: 1080, height: 1920 },
  frameCount: 1860,
  encode: encode(),
  createdAt: AT,
  ...overrides,
});

const progress = (overrides: Record<string, unknown> = {}): unknown => ({
  jobId: JOB_ID,
  phase: 'rendering',
  framesDone: 900,
  framesTotal: 1860,
  fraction: 0.4,
  ...overrides,
});

describe('backends', () => {
  it('offers the browser backend, the browserless backend, and letting the IR decide', () => {
    expect(RenderBackend.options).toEqual(['pixi-playwright', 'napi-canvas', 'auto']);
  });

  it('defaults to `auto`, so no call site has to guess whether a shader is in play', () => {
    expect(RenderRequest.parse(request()).backend).toBe('auto');
  });
});

describe('FrameRange', () => {
  it('accepts a half-open range with at least one frame', () => {
    expect(FrameRange.parse({ from: 0, to: 1 })).toEqual({ from: 0, to: 1 });
    expect(FrameRange.parse({ from: 3400, to: 5000 }).to).toBe(5000);
  });

  it('refuses an empty range, which would silently render nothing', () => {
    const result = FrameRange.safeParse({ from: 100, to: 100 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('to');
  });

  it('refuses an inverted or fractional range', () => {
    expect(FrameRange.safeParse({ from: 100, to: 50 }).success).toBe(false);
    expect(FrameRange.safeParse({ from: 0, to: 10.5 }).success).toBe(false);
    expect(FrameRange.safeParse({ from: -1, to: 10 }).success).toBe(false);
  });
});

describe('EncodeSettings', () => {
  it('accepts constant-quality encoding', () => {
    const settings = EncodeSettings.parse(encode());
    expect(settings.rateControl).toEqual({ mode: 'crf', crf: 18 });
  });

  it('accepts constant-bitrate encoding with its VBV buffer', () => {
    const settings = EncodeSettings.parse(
      encode({ rateControl: { mode: 'bitrate', targetMbps: 10, maxMbps: 12, bufferMb: 24 } }),
    );
    expect(settings.rateControl).toEqual({
      mode: 'bitrate',
      targetMbps: 10,
      maxMbps: 12,
      bufferMb: 24,
    });
  });

  it('cannot express CRF and bitrate at once', () => {
    expect(RateControl.safeParse({ mode: 'crf', crf: 18, targetMbps: 10 }).success).toBe(false);
    expect(RateControl.safeParse({ mode: 'vbr', crf: 18 }).success).toBe(false);
  });

  it('defaults to 8-bit 4:2:0 limited range with AAC audio', () => {
    const settings = EncodeSettings.parse(encode());
    expect(settings.pixelFormat).toBe('yuv420p');
    expect(settings.colorRange).toBe('limited');
    expect(settings.audioCodec).toBe('aac');
    expect(settings.audioBitrateKbps).toBe(192);
    expect(settings.gopSeconds).toBe(2);
  });

  it('defaults the loudness target to the EBU R128 standard', () => {
    expect(EncodeSettings.parse(encode()).loudness).toEqual(EBU_R128);
  });

  it('accepts a per-platform loudness target that differs from the standard', () => {
    const settings = EncodeSettings.parse(
      encode({ loudness: { integratedLufs: -14, truePeakDbtp: -1, loudnessRangeLu: 7 } }),
    );
    expect(settings.loudness.integratedLufs).toBe(-14);
  });

  it('rejects an out-of-range CRF', () => {
    expect(
      EncodeSettings.safeParse(encode({ rateControl: { mode: 'crf', crf: 64 } })).success,
    ).toBe(false);
  });
});

describe('RenderRequest', () => {
  it('defaults to the whole timeline, four workers, and no retained frames', () => {
    const parsed = RenderRequest.parse(request());
    expect(parsed.frames).toBeNull();
    expect(parsed.episodeId).toBeNull();
    expect(parsed.concurrency).toBe(4);
    expect(parsed.writeIntermediateFrames).toBe(false);
    expect(parsed.encodeOverrides).toEqual({});
  });

  it('renders every requested format from one pass', () => {
    const parsed = RenderRequest.parse(
      request({
        episodeId: EPISODE_ID,
        formats: ['yt-1080p', 'shorts-9x16', 'reels-9x16', 'ig-4x5', 'ig-1x1', 'tiktok-9x16'],
      }),
    );
    expect(parsed.formats).toHaveLength(6);
    expect(parsed.episodeId).toBe(EPISODE_ID);
  });

  it('refuses a request with no format, which would render into nothing', () => {
    expect(RenderRequest.safeParse(request({ formats: [] })).success).toBe(false);
  });

  it('refuses an unknown format', () => {
    expect(RenderRequest.safeParse(request({ formats: ['vimeo-4k'] })).success).toBe(false);
  });

  it('expresses a shard as a frame range on the request', () => {
    const parsed = RenderRequest.parse(request({ frames: { from: 0, to: 465 } }));
    expect(parsed.frames).toEqual({ from: 0, to: 465 });
  });

  it('takes a per-format encoder override', () => {
    const parsed = RenderRequest.parse(
      request({
        encodeOverrides: { 'yt-2160p': encode({ rateControl: { mode: 'crf', crf: 14 } }) },
      }),
    );
    expect(parsed.encodeOverrides['yt-2160p']?.rateControl).toEqual({ mode: 'crf', crf: 14 });
    expect(parsed.encodeOverrides['ig-1x1']).toBeUndefined();
  });

  it('bounds concurrency, because each worker is a browser or a canvas context', () => {
    expect(RenderRequest.safeParse(request({ concurrency: 0 })).success).toBe(false);
    expect(RenderRequest.safeParse(request({ concurrency: 65 })).success).toBe(false);
  });
});

describe('checkpointing and progress', () => {
  it('starts with nothing done', () => {
    const checkpoint = RenderCheckpoint.parse({ updatedAt: AT });
    expect(checkpoint.completedRanges).toEqual([]);
    expect(checkpoint.lastCompletedFrame).toBeNull();
    expect(checkpoint.lastFrameHash).toBeNull();
  });

  it('records completed ranges so a resumed job renders only the gaps', () => {
    const checkpoint = RenderCheckpoint.parse({
      completedRanges: [
        { from: 0, to: 1200 },
        { from: 1600, to: 1860 },
      ],
      lastCompletedFrame: 1199,
      lastFrameHash: SHA,
      updatedAt: AT,
    });
    expect(checkpoint.completedRanges).toHaveLength(2);
    expect(checkpoint.lastCompletedFrame).toBe(1199);
    expect(checkpoint.lastFrameHash).toBe(SHA);
  });

  it('rejects a frame hash that is not a lowercase sha256', () => {
    expect(
      RenderCheckpoint.safeParse({ lastFrameHash: 'A'.repeat(64), updatedAt: AT }).success,
    ).toBe(false);
  });

  it('splits work into disjoint shards', () => {
    const shard = RenderShard.parse({ index: 3, count: 8 });
    expect(shard).toEqual({ index: 3, count: 8 });
    expect(RenderShard.safeParse({ index: 0, count: 0 }).success).toBe(false);
  });

  it('reports frames done over a known total', () => {
    const tick = RenderProgress.parse(progress());
    expect(tick.framesDone).toBe(900);
    expect(tick.framesTotal).toBe(1860);
    expect(tick.etaMs).toBeNull();
    expect(tick.framesPerSecond).toBe(0);
    expect(tick.currentFormat).toBeNull();
  });

  it('refuses to report more frames done than exist', () => {
    const result = RenderProgress.safeParse(progress({ framesDone: 2000 }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('framesDone');
  });

  it('names the phases after the frame loop, because encoding is not rendering', () => {
    expect(RenderPhase.options).toEqual([
      'preparing',
      'rendering',
      'reframing',
      'encoding',
      'muxing',
      'finalising',
    ]);
    const tick = RenderProgress.parse(
      progress({
        phase: 'encoding',
        framesDone: 1860,
        fraction: 0.85,
        etaMs: 14_000,
        framesPerSecond: 18.5,
        currentFormat: 'tiktok-9x16',
        message: 'encoding tiktok-9x16',
      }),
    );
    expect(tick.currentFormat).toBe('tiktok-9x16');
    expect(tick.etaMs).toBe(14_000);
  });
});

describe('RenderArtifact', () => {
  it('records a produced file with its hash and duration', () => {
    const parsed = RenderArtifact.parse(artifact());
    expect(parsed.sha256).toBe(SHA);
    expect(parsed.durationMs).toBe(62_000);
    expect(parsed.frameCount).toBe(1860);
    expect(parsed.encode.codec).toBe('h264');
  });

  it('lets a master or an audio stem belong to no single format', () => {
    expect(RenderArtifact.parse(artifact({ kind: 'master', format: null })).format).toBeNull();
  });

  it('rejects an artefact without a content hash, which the CAS could not file', () => {
    expect(RenderArtifact.safeParse(artifact({ sha256: 'not-a-hash' })).success).toBe(false);
  });

  it('rejects a negative duration or size', () => {
    expect(RenderArtifact.safeParse(artifact({ durationMs: -1 })).success).toBe(false);
    expect(RenderArtifact.safeParse(artifact({ bytes: -1 })).success).toBe(false);
  });
});

describe('RenderJob', () => {
  const job = (overrides: Record<string, unknown> = {}): unknown => ({
    id: JOB_ID,
    runId: RUN_ID,
    request: request(),
    state: 'running',
    checkpoint: { updatedAt: AT },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });

  it('names every state a render can be in', () => {
    expect(RenderJobState.options).toEqual([
      'queued',
      'running',
      'paused',
      'succeeded',
      'failed',
      'cancelled',
    ]);
  });

  it('is resumable from its own record alone', () => {
    const parsed = RenderJob.parse(
      job({
        shard: { index: 2, count: 4 },
        checkpoint: {
          completedRanges: [{ from: 930, to: 1200 }],
          lastCompletedFrame: 1199,
          lastFrameHash: SHA,
          updatedAt: AT,
        },
        progress: progress(),
      }),
    );
    expect(parsed.shard).toEqual({ index: 2, count: 4 });
    expect(parsed.checkpoint.lastCompletedFrame).toBe(1199);
    expect(parsed.request.formats).toEqual(['shorts-9x16']);
    expect(parsed.progress?.framesDone).toBe(900);
  });

  it('starts unsharded, unprogressed, with nothing produced and no error', () => {
    const parsed = RenderJob.parse(job({ state: 'queued' }));
    expect(parsed.shard).toBeNull();
    expect(parsed.progress).toBeNull();
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.errorCode).toBeNull();
  });

  it('carries its artefacts once it succeeds', () => {
    const parsed = RenderJob.parse(
      job({
        state: 'succeeded',
        artifacts: [artifact({ kind: 'master', format: null }), artifact()],
      }),
    );
    expect(parsed.artifacts).toHaveLength(2);
    expect(parsed.artifacts.map((entry) => entry.kind)).toEqual(['master', 'delivery']);
  });

  it('carries a machine-readable error code when it fails', () => {
    expect(RenderJob.parse(job({ state: 'failed', errorCode: 'TIMEOUT' })).errorCode).toBe(
      'TIMEOUT',
    );
  });

  it('rejects an unknown state', () => {
    expect(RenderJob.safeParse(job({ state: 'stalled' })).success).toBe(false);
  });
});

describe('JSON Schema emission', () => {
  it('emits for the render request, job and encode schemas', () => {
    for (const schema of [
      RenderRequest,
      RenderJob,
      RenderProgress,
      RenderArtifact,
      EncodeSettings,
      RateControl,
    ]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    }
  });
});

// ── an artefact says which format it is, or says it belongs to none ─────────

describe('artefact kind and format agree', () => {
  function paths(value: unknown): string[] {
    const result = RenderArtifact.safeParse(value);
    return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
  }

  it('rejects a master tagged with a delivery format', () => {
    // Otherwise the master is indistinguishable from a delivery in the artefact list
    // and the platform-spec validator checks the wrong file.
    expect(paths(artifact({ kind: 'master' }))).toEqual(['format']);
  });

  it('rejects an audio stem tagged with a delivery format', () => {
    expect(paths(artifact({ kind: 'audio' }))).toEqual(['format']);
  });

  it('rejects a delivery that does not say what it was cut for', () => {
    expect(paths(artifact({ kind: 'delivery', format: null }))).toEqual(['format']);
  });

  it('accepts the two format-less kinds with a null format', () => {
    for (const kind of ['master', 'audio']) {
      expect(RenderArtifact.safeParse(artifact({ kind, format: null })).success, kind).toBe(true);
    }
  });

  it('leaves the kinds research does not pin either way alone', () => {
    for (const kind of ['frame-sequence', 'poster']) {
      expect(RenderArtifact.safeParse(artifact({ kind })).success, kind).toBe(true);
      expect(RenderArtifact.safeParse(artifact({ kind, format: null })).success, kind).toBe(true);
    }
  });
});

describe('a failed job can be routed, retried and reported on', () => {
  const job = (overrides: Record<string, unknown> = {}): unknown => ({
    id: JOB_ID,
    runId: RUN_ID,
    request: request(),
    state: 'succeeded',
    checkpoint: { updatedAt: AT },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });

  it('rejects a failed job with no error code', () => {
    const result = RenderJob.safeParse(job({ state: 'failed' }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['errorCode']);
  });

  it('accepts a failed job that carries one', () => {
    expect(RenderJob.safeParse(job({ state: 'failed', errorCode: 'RENDER_BACKEND' })).success).toBe(
      true,
    );
  });

  it('leaves every other state free of an error code', () => {
    for (const state of ['queued', 'running', 'paused', 'succeeded', 'cancelled']) {
      expect(RenderJob.safeParse(job({ state })).success, state).toBe(true);
    }
  });
});
