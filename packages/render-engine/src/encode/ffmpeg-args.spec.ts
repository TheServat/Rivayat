import { describe, expect, it } from 'vitest';
import type { EncodeSettings } from '@rv/contracts';

import { CODEC_PROFILES, DETERMINISM_ARGS } from './codec-profiles';
import { buildConcatArgs, buildConcatList, buildEncodeArgs, loudnessFilter } from './ffmpeg-args';

function settings(overrides: Partial<EncodeSettings> = {}): EncodeSettings {
  return {
    codec: 'h264',
    container: 'mp4',
    rateControl: { mode: 'crf', crf: 18 },
    pixelFormat: 'yuv420p',
    colorRange: 'limited',
    fps: 30,
    gopSeconds: 2,
    audioCodec: 'none',
    audioBitrateKbps: 192,
    loudness: { integratedLufs: -23, truePeakDbtp: -1, loudnessRangeLu: 7 },
    ...overrides,
  };
}

/** The value after a flag, so assertions read as "-crf 18" rather than as an index. */
function after(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

const rawInput = { kind: 'raw-rgba', size: { width: 64, height: 64 }, fps: 30 } as const;

describe('buildEncodeArgs', () => {
  it('describes the raw frame stream so FFmpeg can read it', () => {
    // rawvideo has no header: FFmpeg is told the geometry or it reads garbage.
    const args = buildEncodeArgs({
      input: rawInput,
      settings: settings(),
      outputPath: '/tmp/o.mp4',
    });
    expect(after(args, '-f')).toBe('rawvideo');
    expect(after(args, '-pixel_format')).toBe('rgba');
    expect(after(args, '-video_size')).toBe('64x64');
    expect(after(args, '-i')).toBe('pipe:0');
  });

  it('passes -nostdin, or a piped encode can deadlock', () => {
    expect(
      buildEncodeArgs({ input: rawInput, settings: settings(), outputPath: 'o.mp4' }),
    ).toContain('-nostdin');
  });

  it('always carries the determinism flags', () => {
    const args = buildEncodeArgs({ input: rawInput, settings: settings(), outputPath: 'o.mp4' });
    for (const flag of DETERMINISM_ARGS) expect(args).toContain(flag);
  });

  it.each([
    ['h264', 'libx264'],
    ['h265', 'libx265'],
    ['vp9', 'libvpx-vp9'],
    ['av1', 'libsvtav1'],
    ['prores', 'prores_ks'],
  ] as const)('maps %s to the %s encoder', (codec, encoder) => {
    const args = buildEncodeArgs({
      input: rawInput,
      settings: settings({ codec, pixelFormat: CODEC_PROFILES[codec].defaultPixelFormat }),
      outputPath: 'o',
    });
    expect(after(args, '-c:v')).toBe(encoder);
  });

  it('passes CRF to an encoder that has one', () => {
    const args = buildEncodeArgs({ input: rawInput, settings: settings(), outputPath: 'o.mp4' });
    expect(after(args, '-crf')).toBe('18');
  });

  it('omits CRF for ProRes rather than passing a flag it silently ignores', () => {
    const args = buildEncodeArgs({
      input: rawInput,
      settings: settings({ codec: 'prores', container: 'mov', pixelFormat: 'yuv422p10le' }),
      outputPath: 'o.mov',
    });
    expect(args).not.toContain('-crf');
    expect(after(args, '-profile:v')).toBe('3');
  });

  it('expresses a bitrate target in kilobits with a ceiling and a buffer', () => {
    const args = buildEncodeArgs({
      input: rawInput,
      settings: settings({
        rateControl: { mode: 'bitrate', targetMbps: 10, maxMbps: 12, bufferMb: 12 },
      }),
      outputPath: 'o.mp4',
    });
    expect(after(args, '-b:v')).toBe('10000k');
    expect(after(args, '-maxrate')).toBe('12000k');
    expect(after(args, '-bufsize')).toBe('12000k');
  });

  it('pins the encoder to one thread in bitrate mode, and only in bitrate mode', () => {
    // Measured against FFmpeg 8.1.2: ABR/VBV with frame threading produces a different
    // file on every run, because the rate-control state is shared across the threads.
    // See `CodecProfile.deterministicBitrateArgs`.
    const abr = buildEncodeArgs({
      input: rawInput,
      settings: settings({
        rateControl: { mode: 'bitrate', targetMbps: 10, maxMbps: 12, bufferMb: 12 },
      }),
      outputPath: 'o.mp4',
    });
    expect(after(abr, '-x264-params')).toBe('threads=1');

    const crf = buildEncodeArgs({ input: rawInput, settings: settings(), outputPath: 'o.mp4' });
    expect(crf).not.toContain('-x264-params');
  });

  it('has a deterministic bitrate recipe for every codec that has a bitrate mode', () => {
    for (const [codec, profile] of Object.entries(CODEC_PROFILES)) {
      if (codec === 'prores') {
        expect(profile.deterministicBitrateArgs).toEqual([]);
        continue;
      }
      expect(profile.deterministicBitrateArgs.length).toBeGreaterThan(0);
    }
  });

  it('states the colour range and the primaries explicitly', () => {
    // rawvideo carries no colour metadata, and players guess differently.
    const limited = buildEncodeArgs({ input: rawInput, settings: settings(), outputPath: 'o' });
    expect(after(limited, '-color_range')).toBe('tv');
    expect(after(limited, '-colorspace')).toBe('bt709');

    const full = buildEncodeArgs({
      input: rawInput,
      settings: settings({ colorRange: 'full' }),
      outputPath: 'o',
    });
    expect(after(full, '-color_range')).toBe('pc');
  });

  it('turns the GOP length into a frame count', () => {
    const args = buildEncodeArgs({
      input: rawInput,
      settings: settings({ gopSeconds: 2, fps: 25 }),
      outputPath: 'o',
    });
    expect(after(args, '-g')).toBe('50');
  });

  it('disables audio when there is none, and configures it when there is', () => {
    expect(buildEncodeArgs({ input: rawInput, settings: settings(), outputPath: 'o' })).toContain(
      '-an',
    );
    const withAudio = buildEncodeArgs({
      input: rawInput,
      settings: settings({ audioCodec: 'aac', audioBitrateKbps: 128 }),
      outputPath: 'o',
    });
    expect(after(withAudio, '-c:a')).toBe('aac');
    expect(after(withAudio, '-b:a')).toBe('128k');
  });

  it('reads a file input directly instead of piping', () => {
    const args = buildEncodeArgs({
      input: { kind: 'file', path: '/w/master.mov' },
      settings: settings(),
      outputPath: '/w/out.mp4',
    });
    expect(after(args, '-i')).toBe('/w/master.mov');
    expect(args).not.toContain('rawvideo');
  });

  it('prefers a complex filter over a simple one when both are given', () => {
    const args = buildEncodeArgs({
      input: rawInput,
      settings: settings(),
      outputPath: 'o',
      videoFilter: 'scale=2:2',
      complexFilter: { graph: '[0:v]null[vout]', map: '[vout]' },
    });
    expect(after(args, '-filter_complex')).toBe('[0:v]null[vout]');
    expect(after(args, '-map')).toBe('[vout]');
    expect(args).not.toContain('-filter:v');
  });

  it('limits the frame count when asked', () => {
    const args = buildEncodeArgs({
      input: rawInput,
      settings: settings(),
      outputPath: 'o',
      frameLimit: 3,
    });
    expect(after(args, '-frames:v')).toBe('3');
  });

  it('puts the output path last', () => {
    const args = buildEncodeArgs({ input: rawInput, settings: settings(), outputPath: '/w/o.mp4' });
    expect(args.at(-1)).toBe('/w/o.mp4');
  });

  it('never emits a shell metacharacter as part of a flag', () => {
    // The port cannot express a command string, and this is the property that makes
    // that worth having: a path with a space is one argv element, not a quoting bug.
    const args = buildEncodeArgs({
      input: rawInput,
      settings: settings(),
      outputPath: '/w/my project/فصل ۱.mp4',
    });
    expect(args.at(-1)).toBe('/w/my project/فصل ۱.mp4');
  });
});

describe('loudnessFilter', () => {
  it('states the EBU R128 target FFmpeg expects', () => {
    expect(loudnessFilter({ integratedLufs: -23, truePeakDbtp: -1, loudnessRangeLu: 7 })).toBe(
      'loudnorm=I=-23:TP=-1:LRA=7',
    );
  });
});

describe('concat', () => {
  it('copies rather than re-encodes the shards', () => {
    const args = buildConcatArgs('/w/list.txt', '/w/out.mp4');
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    expect(after(args, '-f')).toBe('concat');
    expect(after(args, '-safe')).toBe('0');
  });

  it('quotes each path and escapes an apostrophe', () => {
    const list = buildConcatList(['/w/a.mp4', "/w/o'brien.mp4"]);
    expect(list).toBe("file '/w/a.mp4'\nfile '/w/o'\\''brien.mp4'\n");
  });
});
