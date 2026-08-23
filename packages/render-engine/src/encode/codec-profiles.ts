/**
 * Codec to encoder, as a table.
 *
 * CLAUDE.md §2 forbids a `switch` on a format or codec name in core: the union stays
 * exhaustive through a `Record` whose key type is the union itself, so adding `av1` to
 * `VideoCodec` fails to compile here rather than falling through to a default at
 * runtime. It is also the only honest way to record *why* a codec is configured the way
 * it is, because "H.264 uses `-crf` and ProRes uses `-profile:v`" is not a rule anyone
 * can derive.
 */

import type { PixelFormat, VideoCodec } from '@rv/contracts';

export interface CodecProfile {
  /** The FFmpeg encoder name, which is never the codec name. */
  readonly encoder: string;
  /**
   * Whether constant-quality is expressed as CRF.
   *
   * ProRes has no CRF: its quality is the profile, and passing `-crf` to `prores_ks`
   * is silently ignored - producing a file that is valid, enormous, and not what was
   * asked for.
   */
  readonly supportsCrf: boolean;
  /** Flags that are always right for this encoder. */
  readonly baseArgs: readonly string[];
  /**
   * What it takes to make **bitrate-targeted** encoding reproducible.
   *
   * Measured, not assumed. With FFmpeg 8.1.2 and `libx264`, an ABR/VBV encode of
   * identical input produces a *different file on every run*: the rate-control state is
   * shared across frame threads and the decisions depend on which thread finishes
   * first. Constant-quality encoding of the same input is byte-identical; ABR is not.
   *
   * That is a direct violation of CLAUDE.md #1, and RV-170 asserts on it ("delivered
   * twice, every output sha matches"), so bitrate mode pins the encoder to one thread.
   * It costs roughly 3x the wall time at 2160p, which is the price of the invariant.
   * `sliced-threads=1` was tried and does **not** fix it.
   *
   * Empty for constant-quality encoding, which is already deterministic at full speed.
   */
  readonly deterministicBitrateArgs: readonly string[];
  /** Pixel format when the caller expresses no preference. */
  readonly defaultPixelFormat: PixelFormat;
}

/**
 * ProRes 422 HQ.
 *
 * The master is the file every delivery is cut from, so it is graded for a second
 * generation rather than for size: 10-bit 4:2:2, intra-only, no inter-frame prediction
 * to smear a re-crop.
 */
const PRORES_HQ_PROFILE = '3';

export const CODEC_PROFILES: Record<VideoCodec, CodecProfile> = {
  h264: {
    encoder: 'libx264',
    supportsCrf: true,
    // `medium` rather than `veryslow`: the preset changes the *bitstream*, so it is part
    // of the render's identity, and a slower default would make every test encode slow.
    baseArgs: ['-preset', 'medium'],
    // x264's own thread count, so the filter graph still runs in parallel.
    deterministicBitrateArgs: ['-x264-params', 'threads=1'],
    defaultPixelFormat: 'yuv420p',
  },
  h265: {
    encoder: 'libx265',
    supportsCrf: true,
    // `hvc1` rather than the default `hev1`: QuickTime and every Apple device refuse
    // the latter, and TikTok is the only platform that accepts HEVC at all (research §7).
    baseArgs: ['-preset', 'medium', '-tag:v', 'hvc1'],
    deterministicBitrateArgs: ['-x265-params', 'frame-threads=1:pools=none'],
    defaultPixelFormat: 'yuv420p',
  },
  vp9: {
    encoder: 'libvpx-vp9',
    supportsCrf: true,
    // libvpx treats CRF as a *ceiling* unless the bitrate is pinned to zero, which is
    // the one non-obvious flag in this table.
    baseArgs: ['-b:v', '0', '-row-mt', '1'],
    // No encoder-specific knob measured for these two; the generic thread count is the
    // conservative choice until someone verifies a cheaper one.
    deterministicBitrateArgs: ['-threads', '1'],
    defaultPixelFormat: 'yuv420p',
  },
  av1: {
    encoder: 'libsvtav1',
    supportsCrf: true,
    baseArgs: ['-preset', '8'],
    deterministicBitrateArgs: ['-threads', '1'],
    defaultPixelFormat: 'yuv420p',
  },
  prores: {
    encoder: 'prores_ks',
    supportsCrf: false,
    baseArgs: ['-profile:v', PRORES_HQ_PROFILE, '-vendor', 'apl0'],
    // ProRes has no bitrate mode to make deterministic; its quality is the profile.
    deterministicBitrateArgs: [],
    defaultPixelFormat: 'yuv422p10le',
  },
};

/**
 * Flags that make two encodes of the same frames produce the same bytes.
 *
 * Without these an MP4 carries the encoder's version string, a creation timestamp and
 * an encoder-specific SEI blob, so the file differs on every run and the "renders are
 * bit-reproducible" invariant (CLAUDE.md #1) is unfalsifiable. RV-163 asserts on it, so
 * it has to be true rather than plausible.
 */
export const DETERMINISM_ARGS: readonly string[] = [
  '-fflags',
  '+bitexact',
  '-flags:v',
  '+bitexact',
  '-map_metadata',
  '-1',
];
