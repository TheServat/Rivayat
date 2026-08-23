import { describe, expect, it } from 'vitest';
import {
  type AppError,
  type Result,
  ProviderError,
  err,
  isErr,
  isOk,
  ok,
  unwrap,
} from '@rv/shared-kernel';
import type { AnimationIR } from '@rv/contracts';

import { FramesExporter } from './frames-exporter';
import type { FrameSource } from '../port';
import type { RgbaImage } from '../pixels';
import { SharpPngEncoder, solid } from '../__fixtures__/images';
import { testClock } from '../__fixtures__/ids';
import { richIr, windIr } from '../__fixtures__/ir';
import { artifact, readJson } from '../__fixtures__/read';

interface Manifest {
  manifestVersion: number;
  generator: string;
  animationId: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  stride: number;
  effectiveFps: number;
  durationMs: number;
  frameCount: number;
  pattern: string;
  createdAt: string;
  frames: { index: number; frame: number; timeMs: number; file: string; sha256: string }[];
}

/** Records what it was asked for, so the timing decisions can be asserted directly. */
class RecordingFrameSource implements FrameSource {
  readonly times: number[] = [];

  render(_ir: AnimationIR, timeMs: number): Promise<Result<RgbaImage, AppError>> {
    this.times.push(timeMs);
    // A different colour per frame, so two frames never hash alike by accident.
    const shade = (this.times.length * 7) % 200;
    return Promise.resolve(ok(solid(4, 4, { r: shade, g: 10, b: 20, a: 255 })));
  }
}

function exporter(): FramesExporter {
  return new FramesExporter({ encoder: new SharpPngEncoder(), clock: testClock() });
}

describe('FramesExporter', () => {
  it('declares what it needs and what it writes', () => {
    expect(exporter().id).toBe('frame-sequence');
    expect(exporter().requires).toEqual(['frameSource']);
    expect(exporter().formatSpec).toContain('ffmpeg');
  });

  it('refuses to invent pixels it was not given', async () => {
    const result = await exporter().export({ ir: windIr(400) });
    expect(isErr(result)).toBe(true);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('validation');
  });

  it('emits one numbered PNG per frame plus a manifest', async () => {
    const source = new RecordingFrameSource();
    const output = unwrap(await exporter().export({ ir: windIr(200), frameSource: source }));

    // 200 ms at 30 fps is six frames, and the sequence stops before the seventh.
    expect(output.artifacts.map((entry) => entry.path)).toEqual([
      'frame_0000.png',
      'frame_0001.png',
      'frame_0002.png',
      'frame_0003.png',
      'frame_0004.png',
      'frame_0005.png',
      'manifest.json',
    ]);
    expect(source.times).toEqual([0, 1, 2, 3, 4, 5].map((frame) => (frame * 1000) / 30));
    expect(artifact(output, 'frame_0000.png').mediaType).toBe('image/png');
  });

  it('writes a manifest a muxer can act on', async () => {
    const ir = windIr(200);
    const output = unwrap(await exporter().export({ ir, frameSource: new RecordingFrameSource() }));
    const manifest = readJson<Manifest>(output, 'manifest.json');

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.generator).toBe('@rv/export-kit');
    expect(manifest.animationId).toBe(ir.id);
    expect(manifest.name).toBe('Wind Study');
    expect(manifest.width).toBe(1920);
    expect(manifest.height).toBe(1080);
    expect(manifest.fps).toBe(30);
    expect(manifest.effectiveFps).toBe(30);
    expect(manifest.pattern).toBe('frame_%04d.png');
    expect(manifest.frameCount).toBe(6);
    expect(manifest.frames[0]).toMatchObject({
      index: 0,
      frame: 0,
      timeMs: 0,
      file: 'frame_0000.png',
    });
    expect(manifest.frames[0]?.sha256).toBe(artifact(output, 'frame_0000.png').sha256);
  });

  it('reads its timestamp from the injected clock, never from the wall clock', async () => {
    const output = unwrap(
      await exporter().export({ ir: windIr(100), frameSource: new RecordingFrameSource() }),
    );
    expect(readJson<Manifest>(output, 'manifest.json').createdAt).toBe('2026-08-23T00:00:00.000Z');
  });

  it('drops the effective frame rate along with the stride, so playback stays real-time', async () => {
    const source = new RecordingFrameSource();
    const output = unwrap(
      await exporter().export({ ir: windIr(400), frameSource: source }, { frames: { stride: 3 } }),
    );
    const manifest = readJson<Manifest>(output, 'manifest.json');

    expect(manifest.stride).toBe(3);
    expect(manifest.effectiveFps).toBe(10);
    expect(manifest.frames.map((entry) => entry.frame)).toEqual([0, 3, 6, 9]);
    // Files stay contiguously numbered even though the source frames are not.
    expect(manifest.frames.map((entry) => entry.file)).toEqual([
      'frame_0000.png',
      'frame_0001.png',
      'frame_0002.png',
      'frame_0003.png',
    ]);
  });

  it('honours a prefix, a pad width and a directory', async () => {
    const output = unwrap(
      await exporter().export(
        { ir: windIr(100), frameSource: new RecordingFrameSource() },
        { frames: { prefix: 'shot-', padWidth: 6, directory: 'out' } },
      ),
    );
    expect(output.artifacts[0]?.path).toBe('out/shot-000000.png');
    expect(readJson<Manifest>(output, 'out/manifest.json').pattern).toBe('shot-%06d.png');
  });

  it('rejects options that cannot describe a sequence', async () => {
    const bad = [{ stride: 0 }, { padWidth: 0 }, { padWidth: 99 }];
    for (const frames of bad) {
      const result = await exporter().export(
        { ir: windIr(100), frameSource: new RecordingFrameSource() },
        { frames },
      );
      expect(isErr(result)).toBe(true);
    }
  });

  it('propagates a render failure instead of writing a short sequence', async () => {
    const failing: FrameSource = {
      render: () =>
        Promise.resolve(err(new ProviderError({ message: 'renderer died', provider: 'test' }))),
    };
    const result = await exporter().export({ ir: windIr(100), frameSource: failing });

    expect(isErr(result)).toBe(true);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('provider');
  });

  it('reports that nothing structural survives, and fails under strict', async () => {
    const source = new RecordingFrameSource();
    const output = unwrap(await exporter().export({ ir: richIr(), frameSource: source }));
    const features = output.warnings.map((warning) => warning.feature);

    expect(features).toContain('behaviour:blink');
    expect(features).toContain('camera:track');
    expect(features).toContain('node:asset-instance');
    expect(output.warnings.every((warning) => warning.disposition === 'dropped')).toBe(true);

    const strict = await exporter().export(
      { ir: richIr(), frameSource: new RecordingFrameSource() },
      { strict: true },
    );
    expect(isErr(strict)).toBe(true);
  });
});
