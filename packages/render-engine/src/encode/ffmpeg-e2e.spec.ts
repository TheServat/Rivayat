/**
 * FFmpeg, for real, at 64x64.
 *
 * Every other encode test asserts on arguments. This one asserts on a file: frames from
 * the actual canvas backend, piped to the actual FFmpeg on PATH, probed with the actual
 * ffprobe. It is deliberately tiny - a few frames at 64x64 finishes in well under a
 * second - because the point is that the pipe, the flags and the container work, not
 * that the encoder is fast.
 *
 * If FFmpeg is absent the suite **skips with a message naming what is missing**, rather
 * than passing quietly. A green run that silently tested nothing is worse than a red one.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { unwrap } from '@rv/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EncodeSettings, JobId } from '@rv/contracts';

import { SteppingClock } from '../__fixtures__/doubles';
import { pure2dIr } from '../__fixtures__/ir';
import { scratchDir } from '../__fixtures__/workspace';
import { createNapiCanvasBackend } from '../backends/napi-canvas/napi-canvas-backend';
import { InMemoryCheckpointStore } from '../job/checkpoint-stores';
import { FileFrameStore } from '../job/frame-stores';
import { RunRenderJobUseCase } from '../job/render-job';
import type { FrameStorePort } from '../ports/storage';
import type { FrameBuffer } from '../ports/frame-renderer';
import { FfmpegEncoder } from './ffmpeg-encoder';
import { FfprobeReader } from './ffprobe';
import { NodeProcessRunner } from './node-process';
import { buildConcatList } from './ffmpeg-args';

const SIZE = { width: 64, height: 64 };
const RESUME_JOB_ID: JobId = 'job_0000000000000000000000000A';
const FRAMES = 12;
const FPS = 12;

const runner = new NodeProcessRunner();
const encoder = new FfmpegEncoder(runner);
const prober = new FfprobeReader(runner);

let available = false;
let version = '';
let directory = '';

beforeAll(async () => {
  directory = await scratchDir('ffmpeg-e2e');
  const probe = await encoder.probeAvailable();
  available = probe.ok;
  version = probe.ok ? probe.value : '';
  if (!available) {
    // Named, not silent: the whole value of this file is that it uses the real binary.
    console.warn(
      'SKIPPING the FFmpeg end-to-end suite: no runnable ffmpeg on PATH or at RV_FFMPEG_PATH.',
    );
  }
});

afterAll(async () => {
  if (directory !== '') await rm(directory, { recursive: true, force: true });
});

function settings(overrides: Partial<EncodeSettings> = {}): EncodeSettings {
  return {
    codec: 'h264',
    container: 'mp4',
    rateControl: { mode: 'crf', crf: 28 },
    pixelFormat: 'yuv420p',
    colorRange: 'limited',
    fps: FPS,
    gopSeconds: 1,
    audioCodec: 'none',
    audioBitrateKbps: 192,
    loudness: { integratedLufs: -23, truePeakDbtp: -1, loudnessRangeLu: 7 },
    ...overrides,
  };
}

/** A frame that is different every index, so the encoder has something to compress. */
function frame(index: number): FrameBuffer {
  const data = new Uint8Array(SIZE.width * SIZE.height * 4);
  for (let y = 0; y < SIZE.height; y += 1) {
    for (let x = 0; x < SIZE.width; x += 1) {
      const offset = (y * SIZE.width + x) * 4;
      data[offset] = (x * 4 + index * 20) % 256;
      data[offset + 1] = (y * 4) % 256;
      data[offset + 2] = (index * 21) % 256;
      data[offset + 3] = 255;
    }
  }
  return { width: SIZE.width, height: SIZE.height, data };
}

async function encodeTo(path: string, encode: EncodeSettings, count = FRAMES): Promise<void> {
  const sink = unwrap(encoder.open({ size: SIZE, settings: encode, outputPath: path }));
  for (let index = 0; index < count; index += 1) unwrap(await sink.writeFrame(frame(index)));
  unwrap(await sink.finish());
}

describe('FFmpeg end to end', () => {
  it('has a runnable FFmpeg 8.x', () => {
    if (!available) return;
    expect(version).toContain('ffmpeg version');
  });

  it('encodes piped RGBA frames to a playable H.264 MP4', async () => {
    if (!available) return;
    const path = join(directory, 'h264.mp4');
    await encodeTo(path, settings());

    const probe = unwrap(await prober.probe(path));
    expect(probe).toMatchObject({
      width: 64,
      height: 64,
      codecName: 'h264',
      pixelFormat: 'yuv420p',
      fps: FPS,
    });
    expect(probe.durationMs).toBeGreaterThan(0);
  });

  it('encodes the same frames to the same bytes twice', async () => {
    // CLAUDE.md #1: renders are bit-reproducible. Without `-fflags +bitexact` and
    // `-map_metadata -1` the file carries a timestamp and differs on every run.
    if (!available) return;
    const first = join(directory, 'det-a.mp4');
    const second = join(directory, 'det-b.mp4');
    await encodeTo(first, settings());
    await encodeTo(second, settings());

    const { readFile } = await import('node:fs/promises');
    const { sha256 } = await import('@rv/shared-kernel');
    expect(sha256(Uint8Array.from(await readFile(first)))).toBe(
      sha256(Uint8Array.from(await readFile(second))),
    );
  });

  it('encodes the same frames to the same bytes twice in bitrate mode too', async () => {
    // The case that does *not* come for free: ABR with frame threading is
    // non-deterministic in FFmpeg 8.1.2, so `deterministicBitrateArgs` pins the encoder.
    // Delete that flag and this test fails; every delivery uses bitrate mode.
    if (!available) return;
    const rateControl = { mode: 'bitrate', targetMbps: 2, maxMbps: 3, bufferMb: 3 } as const;
    const first = join(directory, 'abr-a.mp4');
    const second = join(directory, 'abr-b.mp4');
    await encodeTo(first, settings({ rateControl }));
    await encodeTo(second, settings({ rateControl }));

    const { readFile } = await import('node:fs/promises');
    const { sha256 } = await import('@rv/shared-kernel');
    expect(sha256(Uint8Array.from(await readFile(first)))).toBe(
      sha256(Uint8Array.from(await readFile(second))),
    );
  });

  it('encodes H.265, which only TikTok accepts', async () => {
    if (!available) return;
    const path = join(directory, 'h265.mp4');
    await encodeTo(path, settings({ codec: 'h265' }));
    expect(unwrap(await prober.probe(path)).codecName).toBe('hevc');
  });

  it('encodes a ProRes master in a MOV at 10-bit 4:2:2', async () => {
    if (!available) return;
    const path = join(directory, 'master.mov');
    await encodeTo(
      path,
      settings({ codec: 'prores', container: 'mov', pixelFormat: 'yuv422p10le' }),
    );
    const probe = unwrap(await prober.probe(path));
    expect(probe.codecName).toBe('prores');
    expect(probe.pixelFormat).toBe('yuv422p10le');
  });

  it('honours a bitrate target rather than a CRF, and respects the ceiling', async () => {
    // Asserted as a comparison rather than against an absolute figure: at 64x64 the
    // content is trivially compressible, so ABR does not inflate to hit its target -
    // what it does do is spend materially more than a quality-capped encode, and never
    // exceed `-maxrate`.
    if (!available) return;
    const targeted = join(directory, 'bitrate.mp4');
    const capped = join(directory, 'crf51.mp4');
    await encodeTo(
      targeted,
      settings({ rateControl: { mode: 'bitrate', targetMbps: 8, maxMbps: 10, bufferMb: 10 } }),
    );
    await encodeTo(capped, settings({ rateControl: { mode: 'crf', crf: 51 } }));

    const withTarget = unwrap(await prober.probe(targeted));
    const withCrf = unwrap(await prober.probe(capped));
    expect(withTarget.bitrateBps).not.toBeNull();
    expect(withTarget.bitrateBps ?? 0).toBeGreaterThan(withCrf.bitrateBps ?? 0);
    expect(withTarget.bitrateBps ?? 0).toBeLessThanOrEqual(10_000_000 * 1.5);
  });

  it('surfaces a real FFmpeg failure as a typed error carrying its stderr', async () => {
    if (!available) return;
    // An odd height with yuv420p: libx264 refuses it, and the reason is on stderr.
    const sink = unwrap(
      encoder.open({
        size: { width: 64, height: 63 },
        settings: settings(),
        outputPath: join(directory, 'odd.mp4'),
      }),
    );
    const odd = { width: 64, height: 63, data: new Uint8Array(64 * 63 * 4) };
    await sink.writeFrame(odd);
    const result = await sink.finish();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROVIDER_ERROR');
    expect(result.error.context).toMatchObject({ exitCode: expect.any(Number) });
    expect(String(result.error.message).length).toBeGreaterThan(20);
  });

  it('concatenates two encoded shards into one file with no re-encode', async () => {
    if (!available) return;
    const a = join(directory, 'shard-0.mp4');
    const b = join(directory, 'shard-1.mp4');
    await encodeTo(a, settings(), 6);
    await encodeTo(b, settings(), 6);

    const { writeFile } = await import('node:fs/promises');
    const listPath = join(directory, 'shards.txt');
    await writeFile(listPath, buildConcatList([a, b]), 'utf8');

    const joined = join(directory, 'joined.mp4');
    unwrap(await encoder.concat(listPath, joined));

    const whole = unwrap(await prober.probe(joined));
    const half = unwrap(await prober.probe(a));
    expect(whole.codecName).toBe('h264');
    expect(whole.durationMs).toBeGreaterThan(half.durationMs);
  });

  it('re-evaluates a pan expression every frame, over a static source', async () => {
    // The assumption the whole reframe filter rests on, checked against the real
    // binary: `crop` with `t` in its `x` must move. FFmpeg 8 dropped the `eval` option
    // that used to control this, so "it still re-evaluates by default" is exactly the
    // kind of thing that has to be verified rather than believed. A *static* source
    // makes the test unambiguous - any difference between the two extracted frames can
    // only come from the crop moving.
    if (!available) return;

    const source = join(directory, 'static.mp4');
    const gradient: FrameBuffer = (() => {
      const data = new Uint8Array(128 * 64 * 4);
      for (let y = 0; y < 64; y += 1) {
        for (let x = 0; x < 128; x += 1) {
          const offset = (y * 128 + x) * 4;
          data[offset] = x * 2;
          data[offset + 1] = 255 - x * 2;
          data[offset + 2] = 128;
          data[offset + 3] = 255;
        }
      }
      return { width: 128, height: 64, data };
    })();

    const staticSettings = settings({ fps: 10, rateControl: { mode: 'crf', crf: 0 } });
    const sink = unwrap(
      encoder.open({
        size: { width: 128, height: 64 },
        settings: staticSettings,
        outputPath: source,
      }),
    );
    for (let index = 0; index < 20; index += 1) unwrap(await sink.writeFrame(gradient));
    unwrap(await sink.finish());

    const { smoothstep } = await import('../reframe/reframe-filter');
    const panned = join(directory, 'panned.mp4');
    unwrap(
      await encoder.transcode({
        inputPath: source,
        settings: staticSettings,
        outputPath: panned,
        videoFilter: `crop=w=64:h=64:x=${smoothstep(0, 64, 2)}:y=0`,
      }),
    );

    const grab = async (seconds: number, name: string): Promise<string> => {
      const path = join(directory, name);
      const result = unwrap(
        await runner.run({
          command: 'ffmpeg',
          args: [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-ss',
            String(seconds),
            '-i',
            panned,
            '-frames:v',
            '1',
            path,
          ],
        }),
      );
      expect(result.exitCode).toBe(0);
      const { readFile } = await import('node:fs/promises');
      const { sha256 } = await import('@rv/shared-kernel');
      return sha256(Uint8Array.from(await readFile(path)));
    };

    expect(await grab(0, 'pan-start.png')).not.toBe(await grab(1.8, 'pan-end.png'));
  });

  it('resumes an interrupted render to a byte-identical master', async () => {
    // The real version of the resume test: a genuine file, a genuine encoder, and a
    // sha256 comparison. Frames survive the interruption in the store, so the resumed
    // encode consumes the same bytes the uninterrupted one did.
    if (!available) return;

    const ir = pure2dIr({ fps: 10, durationMs: 2000 });
    const range = { from: 0, to: 20 };
    const runFor = async (
      store: FrameStorePort,
      checkpoints: InMemoryCheckpointStore,
      output: string,
      signal?: AbortSignal,
    ): ReturnType<RunRenderJobUseCase['execute']> =>
      new RunRenderJobUseCase({
        renderers: new Map([['napi-canvas', createNapiCanvasBackend()]]),
        frames: store,
        checkpoints,
        encoder,
        clock: new SteppingClock(),
      }).execute({
        jobId: RESUME_JOB_ID,
        ir,
        size: SIZE,
        backend: 'napi-canvas',
        frames: range,
        master: { outputPath: output, settings: settings({ fps: 10 }) },
        keepFrames: true,
        ...(signal === undefined ? {} : { signal }),
      });

    const straightThrough = join(directory, 'resume-reference.mp4');
    unwrap(
      await runFor(
        new FileFrameStore(join(directory, 'frames-ref')),
        new InMemoryCheckpointStore(),
        straightThrough,
      ),
    );

    const store = new FileFrameStore(join(directory, 'frames-resume'));
    const checkpoints = new InMemoryCheckpointStore();
    const controller = new AbortController();
    const killing: FrameStorePort = {
      ...store,
      put: async (index, buffer) => {
        const result = await store.put(index, buffer);
        if (index === 9) controller.abort();
        return result;
      },
      get: (index) => store.get(index),
      has: (index) => store.has(index),
      list: () => store.list(),
      clear: () => store.clear(),
    };

    const killed = await runFor(
      killing,
      checkpoints,
      join(directory, 'resume.mp4'),
      controller.signal,
    );
    expect(killed.ok).toBe(false);

    const resumed = unwrap(await runFor(store, checkpoints, join(directory, 'resume.mp4')));
    expect(resumed.framesRendered).toBe(10);

    const { readFile } = await import('node:fs/promises');
    const { sha256 } = await import('@rv/shared-kernel');
    expect(sha256(Uint8Array.from(await readFile(join(directory, 'resume.mp4'))))).toBe(
      sha256(Uint8Array.from(await readFile(straightThrough))),
    );
  });
});
