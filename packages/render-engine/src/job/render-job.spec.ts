/**
 * The three properties the whole render path exists to have.
 *
 * **Determinism** - rendering frames 40..60 directly equals rendering 0..100 and taking
 * that slice, compared by pixel hash rather than by file size.
 * **Resume** - a render killed at frame 30 and restarted produces the same byte stream
 * as an uninterrupted one, and does not redraw the frames it already has.
 * **Sharding** - two shards concatenated equal one continuous render.
 *
 * These run against the *real* `napi-canvas` backend, so the pixels are real pixels.
 * Only FFmpeg is faked here, and only so the assertions can be about the byte stream
 * handed to it; `ffmpeg-e2e.spec.ts` runs the genuine encoder.
 */

import { unwrap, type Sha256 } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { EncodeSettings, JobId, RenderProgress } from '@rv/contracts';

import { FakeProcessRunner, SteppingClock } from '../__fixtures__/doubles';
import { pure2dIr } from '../__fixtures__/ir';
import { createNapiCanvasBackend } from '../backends/napi-canvas/napi-canvas-backend';
import { FfmpegEncoder } from '../encode/ffmpeg-encoder';
import { hashFrame, hashFrameSequence } from '../frames/frame-hash';
import { framesIn } from '../frames/frame-clock';
import type { FrameBuffer, FrameRenderer, FrameSource } from '../ports/frame-renderer';
import { RecordingProgress } from '../ports/progress';
import type { FrameStorePort } from '../ports/storage';
import { InMemoryCheckpointStore } from './checkpoint-stores';
import { InMemoryFrameStore } from './frame-stores';
import { RunRenderJobUseCase, type RunRenderJobInput } from './render-job';

const JOB_ID = 'job_0000000000000000000000000A' as JobId;
const SIZE = { width: 48, height: 36 };

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

/** Counts how many frames a backend was actually asked to draw. */
class CountingRenderer implements FrameRenderer {
  readonly drawn: number[] = [];
  readonly #inner = createNapiCanvasBackend();
  readonly id = this.#inner.id;
  readonly capabilities = this.#inner.capabilities;

  async open(spec: Parameters<FrameRenderer['open']>[0]): ReturnType<FrameRenderer['open']> {
    const session = await this.#inner.open(spec);
    if (!session.ok) return session;
    const inner = session.value;
    const drawn = this.drawn;
    const source: FrameSource = {
      backend: inner.backend,
      async renderFrame(frame) {
        drawn.push(frame);
        return inner.renderFrame(frame);
      },
      close: () => inner.close(),
    };
    return { ok: true, value: source };
  }
}

/** Aborts the run once a given frame has been stored, simulating a kill. */
class KillAfterStore implements FrameStorePort {
  constructor(
    private readonly inner: FrameStorePort,
    private readonly afterFrame: number,
    private readonly controller: AbortController,
  ) {}

  async put(frame: number, buffer: FrameBuffer): ReturnType<FrameStorePort['put']> {
    const result = await this.inner.put(frame, buffer);
    if (frame === this.afterFrame) this.controller.abort();
    return result;
  }
  get(frame: number): ReturnType<FrameStorePort['get']> {
    return this.inner.get(frame);
  }
  has(frame: number): Promise<boolean> {
    return this.inner.has(frame);
  }
  list(): Promise<readonly number[]> {
    return this.inner.list();
  }
  clear(): ReturnType<FrameStorePort['clear']> {
    return this.inner.clear();
  }
}

interface Harness {
  readonly useCase: RunRenderJobUseCase;
  readonly frames: FrameStorePort;
  readonly checkpoints: InMemoryCheckpointStore;
  readonly runner: FakeProcessRunner;
  readonly progress: RecordingProgress;
  readonly renderer: CountingRenderer;
}

function harness(
  overrides: { frames?: FrameStorePort; checkpoints?: InMemoryCheckpointStore } = {},
): Harness {
  const renderer = new CountingRenderer();
  const frames = overrides.frames ?? new InMemoryFrameStore();
  const checkpoints = overrides.checkpoints ?? new InMemoryCheckpointStore();
  const runner = new FakeProcessRunner();
  const progress = new RecordingProgress();
  return {
    renderer,
    frames,
    checkpoints,
    runner,
    progress,
    useCase: new RunRenderJobUseCase({
      renderers: new Map([['napi-canvas', renderer]]),
      frames,
      checkpoints,
      encoder: new FfmpegEncoder(runner),
      clock: new SteppingClock(),
      progress,
    }),
  };
}

function job(overrides: Partial<RunRenderJobInput> = {}): RunRenderJobInput {
  return {
    jobId: JOB_ID,
    ir: pure2dIr(),
    size: SIZE,
    backend: 'auto',
    frames: null,
    master: null,
    ...overrides,
  };
}

/** The hashes of a stored frame range, in order. */
async function sequenceHash(store: FrameStorePort, from: number, to: number): Promise<Sha256> {
  const hashes: Sha256[] = [];
  for (const frame of framesIn({ from, to }))
    hashes.push(hashFrame(unwrap(await store.get(frame))));
  return hashFrameSequence(hashes);
}

function pipedBytes(runner: FakeProcessRunner): Uint8Array {
  const record = runner.piped[runner.piped.length - 1];
  if (record === undefined) return new Uint8Array();
  const total = record.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of record.chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe('determinism', () => {
  it('rendering 40..60 directly equals rendering 0..100 and slicing', async () => {
    // The property every other guarantee is a corollary of: frame `f` is a pure
    // function of `(ir, f)` and knows nothing about the frames around it.
    const whole = harness();
    unwrap(await whole.useCase.execute(job({ jobId: JOB_ID })));

    const slice = harness();
    const sliced = unwrap(
      await slice.useCase.execute(job({ jobId: JOB_ID, frames: { from: 40, to: 60 } })),
    );

    expect(sliced.frameStreamHash).toBe(await sequenceHash(whole.frames, 40, 60));
  });

  it('produces a different hash for a different slice, so the comparison is not vacuous', async () => {
    const whole = harness();
    unwrap(await whole.useCase.execute(job()));
    expect(await sequenceHash(whole.frames, 40, 60)).not.toBe(
      await sequenceHash(whole.frames, 41, 61),
    );
  });

  it('renders the same composition to the same bytes twice', async () => {
    const first = harness();
    const second = harness();
    const a = unwrap(await first.useCase.execute(job({ frames: { from: 0, to: 20 } })));
    const b = unwrap(await second.useCase.execute(job({ frames: { from: 0, to: 20 } })));
    expect(a.frameStreamHash).toBe(b.frameStreamHash);
  });

  it('refuses a frame range outside the timeline', async () => {
    const { useCase } = harness();
    const result = await useCase.execute(job({ frames: { from: 90, to: 120 } }));
    expect(result.ok).toBe(false);
  });
});

describe('resume', () => {
  it('survives a kill at frame 30 and produces the same encoder input', async () => {
    const uninterrupted = harness();
    unwrap(
      await uninterrupted.useCase.execute(
        job({ master: { outputPath: '/w/master.mp4', settings: SETTINGS }, keepFrames: true }),
      ),
    );
    const expected = pipedBytes(uninterrupted.runner);

    const store = new InMemoryFrameStore();
    const checkpoints = new InMemoryCheckpointStore();
    const controller = new AbortController();
    const killed = harness({ frames: new KillAfterStore(store, 29, controller), checkpoints });
    const first = await killed.useCase.execute(
      job({
        master: { outputPath: '/w/master.mp4', settings: SETTINGS },
        keepFrames: true,
        signal: controller.signal,
      }),
    );
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe('CANCELLED');
    expect(killed.renderer.drawn).toEqual([...framesIn({ from: 0, to: 30 })]);

    const resumed = harness({ frames: store, checkpoints });
    const second = unwrap(
      await resumed.useCase.execute(
        job({ master: { outputPath: '/w/master.mp4', settings: SETTINGS }, keepFrames: true }),
      ),
    );

    // Frames 0-29 were not recomputed.
    expect(resumed.renderer.drawn[0]).toBe(30);
    expect(second.framesRendered).toBe(70);
    // And the bytes handed to the encoder are the bytes an uninterrupted run produced.
    expect(pipedBytes(resumed.runner)).toEqual(expected);
  });

  it('leaves a checkpoint behind when it is cancelled', async () => {
    const controller = new AbortController();
    const store = new InMemoryFrameStore();
    const checkpoints = new InMemoryCheckpointStore();
    const killed = harness({ frames: new KillAfterStore(store, 9, controller), checkpoints });
    await killed.useCase.execute(job({ signal: controller.signal }));

    const saved = unwrap(await checkpoints.load(JOB_ID));
    expect(saved?.completedRanges).toEqual([{ from: 0, to: 10 }]);
    expect(saved?.lastFrameHash).not.toBeNull();
  });

  it('ignores a checkpoint whose IR no longer matches', async () => {
    // Continuing would splice two different films together.
    const store = new InMemoryFrameStore();
    const checkpoints = new InMemoryCheckpointStore();
    await checkpoints.save(JOB_ID, {
      jobId: JOB_ID,
      completedRanges: [{ from: 0, to: 50 }],
      irHash: 'a-different-composition',
      lastFrameHash: null,
      updatedAtIso: '2026-08-23T00:00:00.000Z',
    });
    const run = harness({ frames: store, checkpoints });
    const result = unwrap(await run.useCase.execute(job({ frames: { from: 0, to: 10 } })));
    expect(result.framesRendered).toBe(10);
  });

  it('re-renders a frame the checkpoint claims but the store does not hold', async () => {
    // A process killed between writing the frame and writing the checkpoint leaves the
    // two disagreeing; trusting the checkpoint alone would encode a hole.
    const store = new InMemoryFrameStore();
    const checkpoints = new InMemoryCheckpointStore();
    const first = harness({ frames: store, checkpoints });
    unwrap(await first.useCase.execute(job({ frames: { from: 0, to: 5 } })));
    await store.clear();

    const second = harness({ frames: store, checkpoints });
    const result = unwrap(await second.useCase.execute(job({ frames: { from: 0, to: 5 } })));
    expect(result.framesRendered).toBe(5);
  });

  it('does no work at all when everything is already done', async () => {
    const store = new InMemoryFrameStore();
    const checkpoints = new InMemoryCheckpointStore();
    const first = harness({ frames: store, checkpoints });
    unwrap(await first.useCase.execute(job({ frames: { from: 0, to: 8 } })));

    const second = harness({ frames: store, checkpoints });
    const result = unwrap(await second.useCase.execute(job({ frames: { from: 0, to: 8 } })));
    expect(result.framesRendered).toBe(0);
    expect(second.renderer.drawn).toEqual([]);
  });
});

describe('sharding', () => {
  it('two shards concatenated equal one continuous render', async () => {
    const continuous = harness();
    const whole = unwrap(await continuous.useCase.execute(job({ frames: { from: 0, to: 40 } })));

    const shared = new InMemoryFrameStore();
    for (const index of [0, 1]) {
      const worker = harness({ frames: shared, checkpoints: new InMemoryCheckpointStore() });
      unwrap(
        await worker.useCase.execute(
          job({
            jobId: `job_000000000000000000000000${String(index)}A`.slice(0, 30),
            frames: { from: 0, to: 40 },
            shard: { index, count: 2 },
          }),
        ),
      );
    }

    expect(await sequenceHash(shared, 0, 40)).toBe(whole.frameStreamHash);
  });

  it('renders only its own range', async () => {
    const worker = harness();
    const result = unwrap(
      await worker.useCase.execute(
        job({ frames: { from: 0, to: 40 }, shard: { index: 1, count: 4 } }),
      ),
    );
    expect(result.range).toEqual({ from: 10, to: 20 });
    expect(worker.renderer.drawn).toEqual([...framesIn({ from: 10, to: 20 })]);
  });

  it('fails a shard that owns no frames rather than reporting success', async () => {
    const worker = harness();
    const result = await worker.useCase.execute(
      job({ frames: { from: 0, to: 2 }, shard: { index: 5, count: 8 } }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('encoding and cleanup', () => {
  it('streams every frame of the range into the encoder, in order', async () => {
    const run = harness();
    unwrap(
      await run.useCase.execute(
        job({ frames: { from: 0, to: 6 }, master: { outputPath: '/w/m.mp4', settings: SETTINGS } }),
      ),
    );
    expect(pipedBytes(run.runner).length).toBe(6 * SIZE.width * SIZE.height * 4);
  });

  it('drops the frames after a successful encode unless asked to keep them', async () => {
    // A 1080p minute is 1,800 files.
    const run = harness();
    unwrap(
      await run.useCase.execute(
        job({ frames: { from: 0, to: 4 }, master: { outputPath: '/w/m.mp4', settings: SETTINGS } }),
      ),
    );
    expect(await run.frames.list()).toEqual([]);

    const kept = harness();
    unwrap(
      await kept.useCase.execute(
        job({
          frames: { from: 0, to: 4 },
          master: { outputPath: '/w/m.mp4', settings: SETTINGS },
          keepFrames: true,
        }),
      ),
    );
    expect(await kept.frames.list()).toHaveLength(4);
  });

  it('keeps the frames when there is no master to encode - the shard worker case', async () => {
    const run = harness();
    unwrap(await run.useCase.execute(job({ frames: { from: 0, to: 4 } })));
    expect(await run.frames.list()).toHaveLength(4);
  });

  it('fails rather than encoding a hole when the store cannot produce a frame', async () => {
    // The checkpoint and the frames can disagree after a crash. Encoding what is there
    // and skipping what is not would splice the film silently.
    const store = new InMemoryFrameStore();
    const emptied: FrameStorePort = {
      put: (frame, buffer) => store.put(frame, buffer),
      get: () =>
        Promise.resolve({ ok: false, error: new (class extends Error {})('gone') } as never),
      has: (frame) => store.has(frame),
      list: () => store.list(),
      clear: () => store.clear(),
    };
    const run = harness({ frames: emptied });
    const result = await run.useCase.execute(
      job({ frames: { from: 0, to: 2 }, master: { outputPath: '/w/m.mp4', settings: SETTINGS } }),
    );
    expect(result.ok).toBe(false);
  });

  it('fails a frames-only run when the store cannot produce a frame', async () => {
    const store = new InMemoryFrameStore();
    const emptied: FrameStorePort = {
      put: (frame, buffer) => store.put(frame, buffer),
      get: () =>
        Promise.resolve({ ok: false, error: new (class extends Error {})('gone') } as never),
      has: (frame) => store.has(frame),
      list: () => store.list(),
      clear: () => store.clear(),
    };
    const run = harness({ frames: emptied });
    expect((await run.useCase.execute(job({ frames: { from: 0, to: 2 } }))).ok).toBe(false);
  });

  it('stops when a frame cannot be written to the store', async () => {
    const store = new InMemoryFrameStore();
    const unwritable: FrameStorePort = {
      put: () =>
        Promise.resolve({ ok: false, error: new (class extends Error {})('disk full') } as never),
      get: (frame) => store.get(frame),
      has: (frame) => store.has(frame),
      list: () => store.list(),
      clear: () => store.clear(),
    };
    const run = harness({ frames: unwritable });
    expect((await run.useCase.execute(job({ frames: { from: 0, to: 2 } }))).ok).toBe(false);
  });

  it('reports a failed encode', async () => {
    const run = harness();
    run.runner.pipedResult = { exitCode: 1, stdout: '', stderr: 'Invalid data found' };
    const result = await run.useCase.execute(
      job({ frames: { from: 0, to: 2 }, master: { outputPath: '/w/m.mp4', settings: SETTINGS } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Invalid data found');
  });
});

describe('reporting', () => {
  it('picks the canvas backend for a pure 2D composition and says why', async () => {
    const run = harness();
    const result = unwrap(await run.useCase.execute(job({ frames: { from: 0, to: 2 } })));
    expect(result.backend).toBe('napi-canvas');
    expect(result.decision.reason).toBe('canvas-sufficient');
  });

  it('fails clearly when the chosen backend is not registered', async () => {
    const run = harness();
    const result = await run.useCase.execute(job({ backend: 'pixi-playwright' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
    expect(result.error.context).toMatchObject({ requested: 'pixi-playwright' });
  });

  it('emits progress carrying phase, counts and an ETA slot', async () => {
    const run = harness();
    unwrap(await run.useCase.execute(job({ frames: { from: 0, to: 12 } })));
    const ticks: readonly RenderProgress[] = run.progress.ticks;
    expect(ticks[0]?.phase).toBe('preparing');
    expect(ticks.some((tick) => tick.phase === 'rendering')).toBe(true);
    expect(ticks.at(-1)?.phase).toBe('finalising');
    for (const tick of ticks) {
      expect(tick.framesTotal).toBe(12);
      expect(tick.framesDone).toBeLessThanOrEqual(12);
      expect(tick).toHaveProperty('etaMs');
    }
  });

  it('returns a checkpoint that describes the whole finished range', async () => {
    const run = harness();
    const result = unwrap(await run.useCase.execute(job({ frames: { from: 0, to: 15 } })));
    expect(result.checkpoint.completedRanges).toEqual([{ from: 0, to: 15 }]);
    expect(result.checkpoint.lastCompletedFrame).toBe(14);
    expect(result.framesTotal).toBe(15);
  });

  it('honours a wider checkpoint interval', async () => {
    const run = harness();
    unwrap(await run.useCase.execute(job({ frames: { from: 0, to: 10 }, checkpointEvery: 5 })));
    // Two interval saves plus the final one.
    expect(run.checkpoints.history).toHaveLength(3);
  });
});
