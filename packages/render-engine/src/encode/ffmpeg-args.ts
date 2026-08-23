/**
 * `EncodeSettings` → an argv array. Pure, and therefore assertable.
 *
 * The whole encoder is one long argument list, so building it is where every encoding
 * bug actually lives: the missing `-pix_fmt` that makes a file unplayable on iOS, the
 * `-crf` handed to an encoder that ignores it, the colour range nobody set. Keeping it
 * a pure function means those are unit tests rather than "encode a video and look at
 * it".
 *
 * It returns an **array**, never a string. See `ports/process.ts` for why that is not
 * a stylistic preference.
 */

import { assertNever } from '@rv/shared-kernel';
import type { EncodeSettings, Size } from '@rv/contracts';

import { CODEC_PROFILES, DETERMINISM_ARGS, type CodecProfile } from './codec-profiles';

/** Raw RGBA arriving on stdin - what the frame loop produces. */
export interface RawFrameInput {
  readonly kind: 'raw-rgba';
  readonly size: Size;
  readonly fps: number;
}

/** An existing file, for the master → delivery transcodes. */
export interface FileInput {
  readonly kind: 'file';
  readonly path: string;
}

export type EncodeInput = RawFrameInput | FileInput;

export interface BuildEncodeArgsOptions {
  readonly input: EncodeInput;
  readonly settings: EncodeSettings;
  readonly outputPath: string;
  /** A `-filter:v` graph, e.g. the reframer's crop/scale chain. */
  readonly videoFilter?: string;
  /** A `-filter_complex` graph plus the label to map. Mutually exclusive with the above. */
  readonly complexFilter?: { readonly graph: string; readonly map: string };
  /** Stop after this many frames. Used by the tiny end-to-end encodes. */
  readonly frameLimit?: number;
}

export function buildEncodeArgs(options: BuildEncodeArgsOptions): readonly string[] {
  const { settings, input } = options;
  const profile = CODEC_PROFILES[settings.codec];

  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    // Without `-nostdin` FFmpeg treats the parent's stdin as an interactive console and
    // a piped render can deadlock waiting for a keypress that never comes.
    '-nostdin',
    '-y',
  ];

  args.push(...inputArgs(input));
  args.push(...DETERMINISM_ARGS);

  if (options.complexFilter !== undefined) {
    args.push('-filter_complex', options.complexFilter.graph, '-map', options.complexFilter.map);
  } else if (options.videoFilter !== undefined) {
    args.push('-filter:v', options.videoFilter);
  }

  args.push('-c:v', profile.encoder, ...profile.baseArgs);
  args.push(...rateControlArgs(settings, profile));
  args.push('-pix_fmt', settings.pixelFormat);
  args.push('-color_range', settings.colorRange === 'full' ? 'pc' : 'tv');
  // Stated rather than inherited: rawvideo carries no colour metadata at all, so an
  // unset primaries/transfer/matrix triple leaves the player to guess, and players
  // guess differently.
  args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  args.push('-r', String(settings.fps));
  args.push('-g', String(Math.max(1, Math.round(settings.gopSeconds * settings.fps))));

  args.push(...audioArgs(settings));

  if (options.frameLimit !== undefined) args.push('-frames:v', String(options.frameLimit));

  args.push(options.outputPath);
  return args;
}

function inputArgs(input: EncodeInput): readonly string[] {
  switch (input.kind) {
    case 'raw-rgba':
      return [
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgba',
        '-video_size',
        `${String(input.size.width)}x${String(input.size.height)}`,
        '-framerate',
        String(input.fps),
        '-i',
        'pipe:0',
      ];
    case 'file':
      return ['-i', input.path];
    default:
      return assertNever(input, 'encode input');
  }
}

function rateControlArgs(settings: EncodeSettings, profile: CodecProfile): readonly string[] {
  const rate = settings.rateControl;
  switch (rate.mode) {
    case 'crf':
      // A CRF request against an encoder with no CRF is not silently dropped: ProRes
      // expresses quality as its profile, which `baseArgs` already set.
      return profile.supportsCrf ? ['-crf', String(rate.crf)] : [];
    case 'bitrate':
      return [
        '-b:v',
        `${String(Math.round(rate.targetMbps * 1000))}k`,
        '-maxrate',
        `${String(Math.round(rate.maxMbps * 1000))}k`,
        '-bufsize',
        `${String(Math.round(rate.bufferMb * 1000))}k`,
        // Reproducibility is not optional here; see `CodecProfile.deterministicBitrateArgs`.
        ...profile.deterministicBitrateArgs,
      ];
    default:
      return assertNever(rate, 'rate control mode');
  }
}

function audioArgs(settings: EncodeSettings): readonly string[] {
  if (settings.audioCodec === 'none') return ['-an'];
  return ['-c:a', settings.audioCodec, '-b:a', `${String(settings.audioBitrateKbps)}k`];
}

/**
 * The EBU R128 normalisation filter for this target.
 *
 * Kept beside the encoder arguments because it *is* an encoder argument, and separate
 * from `buildEncodeArgs` because a frame-only encode has no audio to normalise. Single
 * pass: `loudnorm` in two-pass mode needs a measurement run over the whole programme,
 * which doubles the encode and cannot stream.
 */
export function loudnessFilter(loudness: {
  readonly integratedLufs: number;
  readonly truePeakDbtp: number;
  readonly loudnessRangeLu: number;
}): string {
  return `loudnorm=I=${String(loudness.integratedLufs)}:TP=${String(loudness.truePeakDbtp)}:LRA=${String(loudness.loudnessRangeLu)}`;
}

/**
 * Args for stitching encoded shards into one file.
 *
 * `-c copy` because the shards were produced by the same encoder with the same
 * settings: re-encoding to join them would be a second generation of loss for no
 * reason, and would break the byte-equality the sharding test asserts.
 */
export function buildConcatArgs(listPath: string, outputPath: string): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'concat',
    // The list references files by relative path from its own location; without this
    // FFmpeg refuses anything that is not a bare filename.
    '-safe',
    '0',
    '-i',
    listPath,
    ...DETERMINISM_ARGS,
    '-c',
    'copy',
    outputPath,
  ];
}

/** The `concat` demuxer's list file. One quoted path per line, `'` escaped. */
export function buildConcatList(paths: readonly string[]): string {
  return paths.map((path) => `file '${path.replaceAll("'", String.raw`'\''`)}'`).join('\n') + '\n';
}
