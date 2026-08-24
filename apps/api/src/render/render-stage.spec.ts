/**
 * S10's joint: the payload it accepts, the address it files a render under, and what it
 * does when the pieces beneath it fail.
 *
 * The happy path is proved where it can only be proved - `resume.e2e-spec.ts`, with a
 * real Skia backend, a real FFmpeg and a `sha256`. What is left here is everything that
 * file cannot reach cheaply: the refusals, and the *key*, which is the single decision
 * the whole resume story rests on.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AnimationIR } from '@rv/contracts';
import {
  FfmpegEncoder,
  FfprobeReader,
  NodeProcessRunner,
  type FrameBackendId,
  type FrameRenderer,
} from '@rv/render-engine';
import { FixedClock, MemoryLogger, instant, isErr, toIso } from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunSummary, type RunStatus } from '../application/resources';
import { CompositionStore } from '../modules/compositions/composition.store';
import type { StageContext, StageProgress } from '../pipeline/stage';
import { RenderStagePayload, renderKey, renderSize } from './render-stage.contracts';
import { RenderStageHandler, renderLayout } from './render-stage.handler';

const SIZE = { width: 16, height: 16 };

function ir(overrides: { durationMs?: number; fill?: string } = {}): AnimationIR {
  return {
    irVersion: 1,
    id: 'anm_01J0000000000000000000000A',
    name: 'unit fixture',
    fps: 10,
    durationMs: overrides.durationMs ?? 1000,
    sceneSpace: { ...SIZE },
    seed: 7,
    nodes: [
      {
        kind: 'shape',
        id: 'nod_01J0000000000000000000000A',
        name: 'backdrop',
        parentId: null,
        depth: 0,
        shape: 'rect',
        fill: overrides.fill ?? '#204060',
        size: { ...SIZE },
        transform: { anchor: { x: 0.5, y: 0.5 } },
      },
    ],
    tracks: [],
    behaviours: [],
    markers: [],
  } as unknown as AnimationIR;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ir: ir(), size: { ...SIZE }, backend: 'napi-canvas', codec: 'h264', ...overrides };
}

function context(job: Record<string, unknown>): {
  readonly context: StageContext;
  readonly progress: StageProgress[];
} {
  const progress: StageProgress[] = [];
  const run = RunSummary.parse({
    id: 'run_01J0000000000000000000000A',
    projectId: 'prj_01J0000000000000000000000A',
    seriesId: null,
    status: 'running' satisfies RunStatus,
    requestedStages: ['render'],
    currentStage: 'render',
    stages: [],
    seed: 1,
    budgetNanoUsd: null,
    spentNanoUsd: 0,
    errorCode: null,
    startedAt: toIso(instant(0)),
    finishedAt: null,
  });

  return {
    progress,
    context: {
      run,
      job: {
        id: 'job_01J0000000000000000000000A',
        runId: run.id,
        stage: 'render',
        payload: job,
        attempt: 1,
      },
      reportProgress: (update) => {
        progress.push(update);
      },
      signal: new AbortController().signal,
    },
  };
}

describe('RenderStagePayload', () => {
  it('defaults the output size to the composition’s own scene space', () => {
    const parsed = RenderStagePayload.parse({ ir: ir() });
    expect(parsed.size).toBeNull();
    // A composition is authored format-agnostically, so "no size" means "as authored",
    // not "zero".
    expect(renderSize(parsed)).toEqual(SIZE);
  });

  it('defaults to a lane that finishes on a laptop', () => {
    const parsed = RenderStagePayload.parse({ ir: ir() });
    expect(parsed.codec).toBe('h264');
    expect(parsed.backend).toBe('auto');
    // A 1080p minute is 1,800 files: keeping them is an explicit request.
    expect(parsed.keepFrames).toBe(false);
  });

  it('refuses a payload that is not a composition', () => {
    expect(RenderStagePayload.safeParse({ ir: { irVersion: 1 } }).success).toBe(false);
  });
});

describe('renderKey', () => {
  it('is the same for the same content, whoever is rendering it', () => {
    const first = RenderStagePayload.parse(payload());
    const second = RenderStagePayload.parse(payload());
    // Nothing about the run, the job, the attempt or the clock is in it - which is
    // exactly what lets a new process, and a new run, find the frames.
    expect(renderKey(first)).toBe(renderKey(second));
  });

  it('changes when the composition changes, so an edited cut cannot reuse old frames', () => {
    const original = RenderStagePayload.parse(payload());
    const edited = RenderStagePayload.parse(payload({ ir: ir({ fill: '#ff0000' }) }));
    expect(renderKey(edited)).not.toBe(renderKey(original));
  });

  it('changes when the encode changes, because the master lives at the same address', () => {
    const h264 = RenderStagePayload.parse(payload());
    const prores = RenderStagePayload.parse(payload({ codec: 'prores' }));
    expect(renderKey(prores)).not.toBe(renderKey(h264));
  });

  it('changes when only the output size does, though the composition is identical', () => {
    const small = RenderStagePayload.parse(payload());
    const large = RenderStagePayload.parse(payload({ size: { width: 32, height: 32 } }));
    expect(renderKey(large)).not.toBe(renderKey(small));
  });
});

describe('renderLayout', () => {
  it('puts the frames, the checkpoint and the master under one content address', () => {
    const layout = renderLayout('/w', 'abc', 'h264');
    expect(layout.frames.startsWith(layout.root)).toBe(true);
    expect(layout.checkpoints.startsWith(layout.root)).toBe(true);
    expect(layout.master.endsWith('master.mp4')).toBe(true);
  });

  it('names the container the codec implies, rather than assuming mp4', () => {
    // ProRes in an mp4 is a file half the players in the world will not open.
    expect(renderLayout('/w', 'abc', 'prores').master.endsWith('master.mov')).toBe(true);
    expect(renderLayout('/w', 'abc', 'vp9').master.endsWith('master.webm')).toBe(true);
    // An unknown codec falls back rather than producing `master.undefined`.
    expect(renderLayout('/w', 'abc', 'nonesuch').master.endsWith('master.mp4')).toBe(true);
  });
});

describe('RenderStageHandler', () => {
  let workspace = '';

  function handler(renderers: ReadonlyMap<FrameBackendId, FrameRenderer> = new Map()) {
    return new RenderStageHandler({
      renderers,
      encoder: new FfmpegEncoder(new NodeProcessRunner()),
      prober: new FfprobeReader(new NodeProcessRunner()),
      compositions: store(),
      clock: new FixedClock(instant(0)),
      logger: new MemoryLogger(),
      workspaceDir: workspace,
    });
  }

  /** A real store over the scratch workspace: it is a directory, not a service. */
  function store(): CompositionStore {
    return new CompositionStore({
      workspaceDir: workspace,
      clock: new FixedClock(instant(0)),
      logger: new MemoryLogger(),
    });
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'rivayat-render-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('refuses a run that reached S10 without a composition, naming the field', async () => {
    const { context: ctx } = context({});
    const outcome = await handler().execute(ctx);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    // The path, not just a message: "expected an object" with no field name costs an
    // hour to act on.
    expect(JSON.stringify(outcome.error.context)).toContain('run.payload.render');
  });

  it('refuses a composition that does not validate, before drawing anything', async () => {
    const { context: ctx } = context({ render: { ir: { irVersion: 1 } } });
    const outcome = await handler().execute(ctx);
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
  });

  it('reports a backend it does not have rather than rendering with another one', async () => {
    // `selectBackend` picks `napi-canvas` for a shape-only composition; with an empty
    // renderer map there is nothing to pick up, and silently falling back would produce
    // a *different picture* from the one that was asked for.
    const { context: ctx } = context({ render: payload() });
    const outcome = await handler().execute(ctx);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('not-found');
  });

  it('reports a workspace it cannot write into, before drawing a frame', async () => {
    // FFmpeg does not create directories and discovers that after the whole filter graph
    // is built - which is a confusing failure at the *end* of a long render. Finding it
    // first costs one `mkdir`.
    const blocker = join(workspace, 'blocked');
    writeFileSync(blocker, 'not a directory', 'utf8');

    const blocked = new RenderStageHandler({
      renderers: new Map(),
      encoder: new FfmpegEncoder(new NodeProcessRunner()),
      prober: new FfprobeReader(new NodeProcessRunner()),
      compositions: store(),
      clock: new FixedClock(instant(0)),
      logger: new MemoryLogger(),
      workspaceDir: blocker,
    });

    const { context: ctx } = context({ render: payload() });
    const outcome = await blocked.execute(ctx);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    expect(JSON.stringify(outcome.error.context)).toContain('renders');
  });

  it('declares itself implemented, which is what the health endpoint reads', () => {
    expect(handler().implemented).toBe(true);
    expect(handler().stage).toBe('render');
  });
});
