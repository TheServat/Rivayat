import { unwrap } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { FakeProcessRunner } from '../__fixtures__/doubles';
import { FfprobeReader, parseProbe, parseRational } from './ffprobe';

const REPORT = JSON.stringify({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1080,
      height: 1920,
      pix_fmt: 'yuv420p',
      r_frame_rate: '30/1',
      duration: '4.000000',
      bit_rate: '9500000',
      nb_frames: '120',
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '4.010000', bit_rate: '9600000' },
});

describe('parseProbe', () => {
  it('reads the video stream and converts its stringly-typed fields', () => {
    const probe = unwrap(parseProbe(REPORT, 'x.mp4'));
    expect(probe).toMatchObject({
      width: 1080,
      height: 1920,
      codecName: 'h264',
      pixelFormat: 'yuv420p',
      fps: 30,
      durationMs: 4000,
      bitrateBps: 9_500_000,
      frameCount: 120,
      hasAudio: true,
    });
  });

  it('falls back to the container when the stream declares no duration or bitrate', () => {
    const report = JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'prores', width: 4, height: 4, r_frame_rate: '25/1' },
      ],
      format: { duration: '2.5', bit_rate: '1000' },
    });
    const probe = unwrap(parseProbe(report, 'x.mov'));
    expect(probe.durationMs).toBe(2500);
    expect(probe.bitrateBps).toBe(1000);
  });

  it('reports a missing frame count as null rather than zero', () => {
    // Zero would read as "a file with no frames", which is a different and wrong claim.
    const report = JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 4, height: 4, r_frame_rate: '25/1' },
      ],
      format: {},
    });
    expect(unwrap(parseProbe(report, 'x')).frameCount).toBeNull();
    expect(unwrap(parseProbe(report, 'x')).bitrateBps).toBeNull();
  });

  it('refuses a file with no video stream', () => {
    const report = JSON.stringify({ streams: [{ codec_type: 'audio' }], format: {} });
    const result = parseProbe(report, 'x.m4a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('refuses a video stream missing its basic fields', () => {
    const report = JSON.stringify({ streams: [{ codec_type: 'video' }], format: {} });
    expect(parseProbe(report, 'x').ok).toBe(false);
  });

  it('refuses non-JSON', () => {
    expect(parseProbe('not json', 'x').ok).toBe(false);
  });

  it('survives a report with no streams array at all', () => {
    expect(parseProbe('{}', 'x').ok).toBe(false);
  });
});

describe('parseRational', () => {
  it('keeps 30000/1001 exact rather than rounding to 29.97', () => {
    expect(parseRational('30000/1001')).toBeCloseTo(29.97002997, 8);
  });

  it('accepts a bare numerator', () => {
    expect(parseRational('24')).toBe(24);
  });

  it.each([['0/0'], [''], ['a/b']])('rejects %s', (value) => {
    expect(parseRational(value)).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(parseRational(30)).toBeNull();
  });
});

describe('FfprobeReader', () => {
  it('asks for JSON with streams and format', async () => {
    const runner = new FakeProcessRunner();
    runner.replies.push({ exitCode: 0, stdout: REPORT, stderr: '' });
    const probe = await new FfprobeReader(runner).probe('/w/out.mp4');
    expect(probe.ok).toBe(true);
    expect(runner.runs[0]?.spec.args).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      '/w/out.mp4',
    ]);
  });

  it('reports a non-zero exit as a provider error carrying stderr', async () => {
    const runner = new FakeProcessRunner();
    runner.replies.push({ exitCode: 1, stdout: '', stderr: 'moov atom not found' });
    const probe = await new FfprobeReader(runner).probe('/w/broken.mp4');
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.error.message).toContain('moov atom not found');
    expect(probe.error.context).toMatchObject({ path: '/w/broken.mp4' });
  });
});
