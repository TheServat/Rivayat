/**
 * The encoder settings a format profile implies.
 *
 * `FormatProfile` states what the platform wants - size, codec, bitrate range,
 * container, frame rate - and `EncodeSettings` states what FFmpeg needs. The gap
 * between them is small and entirely mechanical, which is exactly why it should be one
 * function rather than a literal repeated seven times in a delivery config.
 *
 * The master is the other case and it is genuinely different: it is not a delivery, so
 * it is graded for a second generation rather than for a platform.
 */

import { EBU_R128, type EncodeSettings, type FormatProfile } from '@rv/contracts';

export interface DeliverySettingsOptions {
  /** `false` (the default) emits `-an`; nothing in the render path produces audio yet. */
  readonly withAudio?: boolean;
  /** Keyframe interval. Two seconds is the usual compromise between seeking and size. */
  readonly gopSeconds?: number;
}

/**
 * Settings for one delivery target.
 *
 * Bitrate mode rather than CRF: the platform declares a range, and the only way to land
 * inside a declared range on purpose is to target it. `bufferMb` is one second of the
 * ceiling, which bounds how far the encoder may overshoot on a hard cut.
 */
export function deliverySettings(
  profile: FormatProfile,
  options: DeliverySettingsOptions = {},
): EncodeSettings {
  const target = (profile.bitrateMbps.minMbps + profile.bitrateMbps.maxMbps) / 2;
  return {
    codec: profile.codec,
    container: profile.container,
    rateControl: {
      mode: 'bitrate',
      targetMbps: target,
      maxMbps: profile.bitrateMbps.maxMbps,
      bufferMb: profile.bitrateMbps.maxMbps,
    },
    pixelFormat: 'yuv420p',
    // Limited range: every one of these targets is consumer video delivery, and full
    // range in an MP4 is the classic "why is my black grey" bug on half the players.
    colorRange: 'limited',
    fps: profile.fps,
    gopSeconds: options.gopSeconds ?? 2,
    audioCodec: options.withAudio === true ? 'aac' : 'none',
    audioBitrateKbps: 192,
    loudness: profile.loudness,
  };
}

export interface MasterSettingsOptions {
  readonly fps: number;
  /** ProRes by default. See below for when H.264 is the right master. */
  readonly codec?: EncodeSettings['codec'];
  readonly withAudio?: boolean;
}

/**
 * Settings for the master every delivery is cut from.
 *
 * ProRes 422 HQ in a MOV: intra-only, 10-bit, 4:2:2. The deliveries re-crop and
 * re-scale it, and an inter-frame codec's motion prediction smears exactly the detail a
 * crop then magnifies. It is large - roughly 15x an H.264 master - which is the price
 * of the second generation being clean.
 *
 * `codec` is a parameter because a draft-quality preview master is a legitimate thing
 * to want and paying ProRes for it is not.
 */
export function masterSettings(options: MasterSettingsOptions): EncodeSettings {
  const codec = options.codec ?? 'prores';
  return {
    codec,
    container: codec === 'prores' ? 'mov' : 'mp4',
    rateControl: codec === 'prores' ? { mode: 'crf', crf: 0 } : { mode: 'crf', crf: 16 },
    pixelFormat: codec === 'prores' ? 'yuv422p10le' : 'yuv420p',
    colorRange: 'limited',
    fps: options.fps,
    // One-second GOP on an H.264 master: the deliveries seek into it per shot, and a
    // long GOP makes every trim decode from the previous keyframe.
    gopSeconds: 1,
    audioCodec: options.withAudio === true ? 'pcm_s16le' : 'none',
    audioBitrateKbps: 192,
    loudness: EBU_R128,
  };
}
