/**
 * What a file actually is, as opposed to what we meant it to be.
 *
 * The spec validator (`deliver/spec-validator.ts`) is only worth anything if it reads
 * the real file, so this is deliberately a thin, faithful wrapper: run `ffprobe`, parse
 * its JSON, and convert its stringly-typed fields into numbers exactly once.
 *
 * The conversions are the interesting part. `r_frame_rate` is the string `"30/1"`,
 * `duration` is a decimal string of *seconds*, `nb_frames` is frequently absent, and
 * `bit_rate` can be missing on a stream and present only on the container. Every one of
 * those has a wrong-but-plausible reading, so each is handled here rather than at four
 * call sites.
 */

import {
  ProviderError,
  ValidationError,
  err,
  ok,
  type AppError,
  type Result,
} from '@rv/shared-kernel';

import type { ProcessPort } from '../ports/process';
import type { FfmpegPaths } from './ffmpeg-encoder';
import { DEFAULT_FFMPEG_PATHS } from './ffmpeg-encoder';

export interface MediaProbe {
  readonly width: number;
  readonly height: number;
  /** FFmpeg's own name: `h264`, `hevc`, `prores`, `vp9`, `av1`. Not our `VideoCodec`. */
  readonly codecName: string;
  readonly pixelFormat: string;
  /** Exact, from `r_frame_rate`, so 30000/1001 does not become 29.97. */
  readonly fps: number;
  readonly durationMs: number;
  /** `null` when neither the stream nor the container declares one. */
  readonly bitrateBps: number | null;
  /** `null` when the container does not count frames. */
  readonly frameCount: number | null;
  readonly hasAudio: boolean;
}

export class FfprobeReader {
  readonly #process: ProcessPort;
  readonly #paths: FfmpegPaths;

  constructor(process: ProcessPort, paths: FfmpegPaths = DEFAULT_FFMPEG_PATHS) {
    this.#process = process;
    this.#paths = paths;
  }

  async probe(path: string): Promise<Result<MediaProbe, AppError>> {
    const result = await this.#process.run({
      command: this.#paths.ffprobe,
      args: ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
      timeoutMs: 30_000,
    });
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return err(
        new ProviderError({
          message: `ffprobe could not read ${path}: ${result.value.stderr.trim()}`,
          provider: 'ffprobe',
          retryable: false,
          context: { path, exitCode: result.value.exitCode },
        }),
      );
    }
    return parseProbe(result.value.stdout, path);
  }
}

/** Exported for the parsing tests: the JSON shape is the interesting part, not the spawn. */
export function parseProbe(json: string, path: string): Result<MediaProbe, AppError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (caught: unknown) {
    return err(
      new ValidationError({ message: `ffprobe returned non-JSON for ${path}`, cause: caught }),
    );
  }

  const root = asRecord(parsed);
  const streams = Array.isArray(root?.streams) ? root.streams : [];
  const video = streams.map(asRecord).find((stream) => stream?.codec_type === 'video');
  if (video === undefined || video === null) {
    return err(new ValidationError({ message: `${path} contains no video stream` }));
  }

  const width = asNumber(video.width);
  const height = asNumber(video.height);
  const codecName = typeof video.codec_name === 'string' ? video.codec_name : '';
  if (width === null || height === null || codecName === '') {
    return err(new ValidationError({ message: `${path}: video stream is missing basic fields` }));
  }

  const format = asRecord(root?.format);
  const durationSeconds = asNumber(video.duration) ?? asNumber(format?.duration) ?? 0;
  const bitrate = asNumber(video.bit_rate) ?? asNumber(format?.bit_rate);

  return ok({
    width,
    height,
    codecName,
    pixelFormat: typeof video.pix_fmt === 'string' ? video.pix_fmt : '',
    fps: parseRational(video.r_frame_rate) ?? 0,
    // Rounded to whole milliseconds because every duration in `@rv/contracts` is an
    // integer millisecond and a validator that compared 3999.9999 to 4000 would be a
    // coin toss.
    durationMs: Math.round(durationSeconds * 1000),
    bitrateBps: bitrate,
    frameCount: asNumber(video.nb_frames),
    hasAudio: streams.map(asRecord).some((stream) => stream?.codec_type === 'audio'),
  });
}

/** `"30/1"` → 30, `"30000/1001"` → 29.97002997..., `"0/0"` → null. */
export function parseRational(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const [numerator, denominator] = value.split('/');
  // `Number('')` is 0, so an empty numerator would otherwise read as a valid 0 fps.
  if (numerator === undefined || numerator.trim() === '') return null;
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return null;
  return top / bottom;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
