import { InternalError, unwrap } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { EncodeSettings } from '@rv/contracts';

import { FakeProcessRunner, indexedFrame, solidFrame } from '../__fixtures__/doubles';
import { hashFrame, hashFrameSequence } from '../frames/frame-hash';
import { FfmpegEncoder } from './ffmpeg-encoder';

const SIZE = { width: 4, height: 4 };

const SETTINGS: EncodeSettings = {
  codec: 'h264',
  container: 'mp4',
  rateControl: { mode: 'crf', crf: 20 },
  pixelFormat: 'yuv420p',
  colorRange: 'limited',
  fps: 25,
  gopSeconds: 1,
  audioCodec: 'none',
  audioBitrateKbps: 192,
  loudness: { integratedLufs: -23, truePeakDbtp: -1, loudnessRangeLu: 7 },
};

describe('probeAvailable', () => {
  it('returns the version line', async () => {
    const runner = new FakeProcessRunner();
    runner.replies.push({
      exitCode: 0,
      stdout: 'ffmpeg version 8.1.2-full_build\nbuilt with\n',
      stderr: '',
    });
    const encoder = new FfmpegEncoder(runner);
    expect(unwrap(await encoder.probeAvailable())).toBe('ffmpeg version 8.1.2-full_build');
  });

  it('fails when the binary answers non-zero', async () => {
    const runner = new FakeProcessRunner();
    runner.replies.push({ exitCode: 127, stdout: '', stderr: 'not found' });
    const result = await new FfmpegEncoder(runner).probeAvailable();
    expect(result.ok).toBe(false);
  });

  it('propagates a spawn failure', async () => {
    const runner = new FakeProcessRunner();
    runner.run = (): Promise<never> =>
      Promise.resolve({ ok: false, error: new InternalError({ message: 'ENOENT' }) } as never);
    expect((await new FfmpegEncoder(runner).probeAvailable()).ok).toBe(false);
  });
});

describe('open / FrameSink', () => {
  it('pipes raw frames rather than writing a file each', async () => {
    // A 90-second 1080p render is 2,700 files otherwise.
    const runner = new FakeProcessRunner();
    const sink = unwrap(
      new FfmpegEncoder(runner).open({ size: SIZE, settings: SETTINGS, outputPath: 'o.mp4' }),
    );
    await sink.writeFrame(indexedFrame(4, 4, 0));
    await sink.writeFrame(indexedFrame(4, 4, 1));
    await sink.finish();
    expect(runner.runs).toHaveLength(0);
    expect(runner.pipedBytes()).toBe(2 * 4 * 4 * 4);
  });

  it('returns the digest of each frame and of the whole stream', async () => {
    const runner = new FakeProcessRunner();
    const sink = unwrap(
      new FfmpegEncoder(runner).open({ size: SIZE, settings: SETTINGS, outputPath: 'o.mp4' }),
    );
    const first = unwrap(await sink.writeFrame(indexedFrame(4, 4, 0)));
    const second = unwrap(await sink.writeFrame(indexedFrame(4, 4, 1)));
    const summary = unwrap(await sink.finish());
    expect(first).toBe(hashFrame(indexedFrame(4, 4, 0)));
    expect(summary.framesWritten).toBe(2);
    expect(summary.frameStreamHash).toBe(hashFrameSequence([first, second]));
  });

  it('refuses a frame that is not the declared size', async () => {
    // rawvideo has no per-frame header: a wrong-sized frame shifts everything after it
    // and the video tears diagonally from that point on.
    const runner = new FakeProcessRunner();
    const sink = unwrap(
      new FfmpegEncoder(runner).open({ size: SIZE, settings: SETTINGS, outputPath: 'o.mp4' }),
    );
    const result = await sink.writeFrame(solidFrame(8, 8, 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('8x8');
    expect(runner.pipedBytes()).toBe(0);
  });

  it('surfaces FFmpeg stderr as a typed error, not an exit code', async () => {
    const runner = new FakeProcessRunner();
    runner.pipedResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'x264 [error]: height not divisible by 2 (4x5)\n',
    };
    const sink = unwrap(
      new FfmpegEncoder(runner).open({ size: SIZE, settings: SETTINGS, outputPath: 'o.mp4' }),
    );
    const result = await sink.finish();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('height not divisible by 2');
    expect(result.error.context).toMatchObject({ exitCode: 1 });
  });

  it('propagates a write failure', async () => {
    const runner = new FakeProcessRunner();
    runner.writeError = new InternalError({ message: 'EPIPE' });
    const sink = unwrap(
      new FfmpegEncoder(runner).open({ size: SIZE, settings: SETTINGS, outputPath: 'o.mp4' }),
    );
    expect((await sink.writeFrame(indexedFrame(4, 4, 0))).ok).toBe(false);
  });

  it('propagates a spawn failure at open', () => {
    const runner = new FakeProcessRunner();
    runner.spawnError = new InternalError({ message: 'no ffmpeg' });
    const opened = new FfmpegEncoder(runner).open({
      size: SIZE,
      settings: SETTINGS,
      outputPath: 'o.mp4',
    });
    expect(opened.ok).toBe(false);
  });

  it('cancels at most once', async () => {
    const runner = new FakeProcessRunner();
    const sink = unwrap(
      new FfmpegEncoder(runner).open({ size: SIZE, settings: SETTINGS, outputPath: 'o.mp4' }),
    );
    await sink.cancel();
    await expect(sink.cancel()).resolves.toBeUndefined();
  });

  it('does not cancel after finishing', async () => {
    const runner = new FakeProcessRunner();
    const sink = unwrap(
      new FfmpegEncoder(runner).open({ size: SIZE, settings: SETTINGS, outputPath: 'o.mp4' }),
    );
    await sink.finish();
    await expect(sink.cancel()).resolves.toBeUndefined();
  });
});

describe('transcode and concat', () => {
  it('reads the input file directly and applies a complex filter', async () => {
    const runner = new FakeProcessRunner();
    const result = await new FfmpegEncoder(runner).transcode({
      inputPath: '/w/master.mov',
      settings: SETTINGS,
      outputPath: '/w/out.mp4',
      complexFilter: { graph: '[0:v]crop=2:2:0:0[vout]', map: '[vout]' },
    });
    expect(result.ok).toBe(true);
    expect(runner.runs[0]?.spec.args).toContain('[0:v]crop=2:2:0:0[vout]');
  });

  it('applies a simple filter when that is all there is', async () => {
    const runner = new FakeProcessRunner();
    await new FfmpegEncoder(runner).transcode({
      inputPath: '/w/m.mov',
      settings: SETTINGS,
      outputPath: '/w/o.mp4',
      videoFilter: 'scale=2:2',
    });
    expect(runner.runs[0]?.spec.args).toContain('-filter:v');
  });

  it("reports a failed transcode with FFmpeg's own words", async () => {
    const runner = new FakeProcessRunner();
    runner.replies.push({ exitCode: 234, stdout: '', stderr: 'Invalid argument\n' });
    const result = await new FfmpegEncoder(runner).transcode({
      inputPath: 'a',
      settings: SETTINGS,
      outputPath: 'b',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context).toMatchObject({ exitCode: 234 });
  });

  it('stitches shards with -c copy', async () => {
    const runner = new FakeProcessRunner();
    expect((await new FfmpegEncoder(runner).concat('/w/l.txt', '/w/o.mp4')).ok).toBe(true);
    expect(runner.runs[0]?.spec.args).toContain('copy');
  });

  it('reports a failed concat', async () => {
    const runner = new FakeProcessRunner();
    runner.replies.push({ exitCode: 1, stdout: '', stderr: 'unsafe file name' });
    expect((await new FfmpegEncoder(runner).concat('/w/l.txt', '/w/o.mp4')).ok).toBe(false);
  });
});
