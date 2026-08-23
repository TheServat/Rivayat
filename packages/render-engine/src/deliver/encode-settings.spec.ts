import { EncodeSettings, FORMAT_PRESETS, type FormatProfileId } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import { deliverySettings, masterSettings } from './encode-settings';

const ALL = Object.keys(FORMAT_PRESETS) as FormatProfileId[];

describe('deliverySettings', () => {
  it.each(ALL)('%s satisfies the contract schema', (format) => {
    expect(() => EncodeSettings.parse(deliverySettings(FORMAT_PRESETS[format]))).not.toThrow();
  });

  it.each(ALL)('%s adopts the profile codec, container and frame rate', (format) => {
    const profile = FORMAT_PRESETS[format];
    const settings = deliverySettings(profile);
    expect(settings.codec).toBe(profile.codec);
    expect(settings.container).toBe(profile.container);
    expect(settings.fps).toBe(profile.fps);
  });

  it.each(ALL)("%s targets a bitrate inside the platform's declared range", (format) => {
    // The only way to land inside a declared range on purpose is to target it.
    const profile = FORMAT_PRESETS[format];
    const rate = deliverySettings(profile).rateControl;
    expect(rate.mode).toBe('bitrate');
    if (rate.mode !== 'bitrate') return;
    expect(rate.targetMbps).toBeGreaterThanOrEqual(profile.bitrateMbps.minMbps);
    expect(rate.targetMbps).toBeLessThanOrEqual(profile.bitrateMbps.maxMbps);
    expect(rate.maxMbps).toBe(profile.bitrateMbps.maxMbps);
  });

  it('emits -an by default, because nothing in the render path makes audio yet', () => {
    expect(deliverySettings(FORMAT_PRESETS['ig-1x1']).audioCodec).toBe('none');
    expect(deliverySettings(FORMAT_PRESETS['ig-1x1'], { withAudio: true }).audioCodec).toBe('aac');
  });

  it('delivers limited range, the consumer-video default', () => {
    expect(deliverySettings(FORMAT_PRESETS['yt-1080p']).colorRange).toBe('limited');
  });

  it('carries the profile loudness target', () => {
    expect(deliverySettings(FORMAT_PRESETS['tiktok-9x16']).loudness).toEqual(
      FORMAT_PRESETS['tiktok-9x16'].loudness,
    );
  });
});

describe('masterSettings', () => {
  it('defaults to ProRes 422 HQ in a MOV', () => {
    // Intra-only and 10-bit, because every delivery is a second generation cut from it.
    const settings = masterSettings({ fps: 25 });
    expect(settings).toMatchObject({
      codec: 'prores',
      container: 'mov',
      pixelFormat: 'yuv422p10le',
    });
    expect(() => EncodeSettings.parse(settings)).not.toThrow();
  });

  it('uses a short GOP for an H.264 master, because deliveries trim into it', () => {
    const settings = masterSettings({ fps: 30, codec: 'h264' });
    expect(settings.container).toBe('mp4');
    expect(settings.gopSeconds).toBe(1);
    expect(settings.rateControl).toEqual({ mode: 'crf', crf: 16 });
  });

  it('uses uncompressed audio on a master when there is any', () => {
    expect(masterSettings({ fps: 25, withAudio: true }).audioCodec).toBe('pcm_s16le');
  });
});
