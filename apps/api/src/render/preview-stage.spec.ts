/**
 * The two dials, and the promise they are allowed to keep.
 *
 * A preview is only useful if it does not lie, so the assertions are about the
 * *relationship* between a preview and the render it stands in for: its instants are a
 * subset of the render's, its frame is the composition's shape, and asking for a
 * preview at full size and full rate produces the render itself - the same content
 * address, the same frames, no second draw.
 *
 * The picture is proved where it can only be proved, in `deliver.e2e-spec.ts`, which
 * renders both and compares the bytes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AnimationIR } from '@rv/contracts';
import { FfmpegEncoder, NodeProcessRunner } from '@rv/render-engine';
import { FixedClock, MemoryLogger, instant, isErr } from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CompositionStore } from '../modules/compositions/composition.store';
import { COMPOSITION_ARTIFACT_PREFIX } from './composition-source';
import { PreviewStageHandler } from './preview-stage.handler';
import { previewFps, previewSize } from './preview-stage.contracts';
import { RenderStagePayload, renderKey } from './render-stage.contracts';
import { stageContext, succeeded } from './__fixtures__/stage';

const SCENE = { width: 400, height: 300 };

function ir(): AnimationIR {
  return {
    irVersion: 1,
    id: 'anm_01J0000000000000000000000A',
    name: 'preview fixture',
    fps: 24,
    durationMs: 1000,
    sceneSpace: { ...SCENE },
    seed: 3,
    nodes: [
      {
        kind: 'shape',
        id: 'nod_01J0000000000000000000000A',
        name: 'backdrop',
        parentId: null,
        depth: 0,
        shape: 'rect',
        fill: '#204060',
        size: { ...SCENE },
        transform: { anchor: { x: 0.5, y: 0.5 } },
      },
    ],
    tracks: [],
    behaviours: [],
    markers: [],
  } as unknown as AnimationIR;
}

describe('previewFps', () => {
  it('snaps down to a divisor, so every preview instant is a render instant', () => {
    expect(previewFps(24, 12)).toBe(12);
    // 12 does not divide 25; 5 is the fastest cadence that does.
    expect(previewFps(25, 12)).toBe(5);
    expect(previewFps(24, 7)).toBe(6);
  });

  it('never exceeds the composition, and always has an answer', () => {
    expect(previewFps(24, 60)).toBe(24);
    // A prime rate with nothing below it: one frame per second is still a preview.
    expect(previewFps(23, 12)).toBe(1);
  });

  it('lands preview frames on master frames exactly, not nearly', () => {
    const fps = previewFps(24, 12);
    const ratio = 24 / fps;
    for (let frame = 0; frame < 12; frame += 1) {
      // `frameTimeMs` is `frame * 1000 / fps` in both cases, and both are one correctly
      // rounded division of exact integers - so this is equality, not closeness.
      expect((frame * 1000) / fps).toBe((frame * ratio * 1000) / 24);
    }
  });
});

describe('previewSize', () => {
  it('keeps the composition’s shape and both dimensions even', () => {
    expect(previewSize({ width: 1920, height: 1080 }, 640)).toEqual({ width: 640, height: 360 });
    // 1080 * (640/1920) = 360; an odd result would be floored to even, because libx264
    // refuses an odd dimension in yuv420p outright.
    expect(previewSize({ width: 1001, height: 777 }, 500)).toEqual({ width: 500, height: 388 });
  });

  it('never scales up, because a preview larger than the render costs more', () => {
    expect(previewSize({ width: 320, height: 180 }, 640)).toEqual({ width: 320, height: 180 });
  });
});

describe('PreviewStageHandler', () => {
  let workspace = '';

  function store(): CompositionStore {
    return new CompositionStore({
      workspaceDir: workspace,
      clock: new FixedClock(instant(0)),
      logger: new MemoryLogger(),
    });
  }

  function handler(): PreviewStageHandler {
    return new PreviewStageHandler({
      renderers: new Map(),
      encoder: new FfmpegEncoder(new NodeProcessRunner()),
      compositions: store(),
      clock: new FixedClock(instant(0)),
      logger: new MemoryLogger(),
      workspaceDir: workspace,
    });
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'rivayat-preview-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('is the render, at the render’s address, when nothing is turned down', () => {
    // The claim the whole stage rests on: a preview and a render differ by two numbers
    // in one payload. At full size and full rate they are the *same* payload, so they
    // share a render key and therefore share frames rather than drawing a second set.
    const composition = ir();
    const preview = RenderStagePayload.parse({
      ir: { ...composition, fps: previewFps(composition.fps, composition.fps) },
      size: previewSize(composition.sceneSpace, composition.sceneSpace.width),
      backend: 'napi-canvas',
      codec: 'h264',
    });
    const render = RenderStagePayload.parse({
      ir: composition,
      size: composition.sceneSpace,
      backend: 'napi-canvas',
      codec: 'h264',
    });

    expect(renderKey(preview)).toBe(renderKey(render));
  });

  it('previews the composition this run choreographed, with no payload at all', async () => {
    const stored = await store().store(ir());
    if (isErr(stored)) throw stored.error;

    const harness = stageContext({
      stage: 'preview',
      payload: {},
      stages: [succeeded('choreograph', [`${COMPOSITION_ARTIFACT_PREFIX}${stored.value.id}`])],
    });

    const outcome = await handler().execute(harness.context);

    // It got as far as *rendering*: the failure is a missing backend, not a missing
    // composition. That is the seam between S8 and S9 working - a run carries one
    // payload for every stage, so the run record is the only channel S8 has.
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('not-found');
    expect(JSON.stringify(outcome.error.context)).not.toContain('run.payload.preview');
  });

  it('refuses a preview of nothing, and says how to name a composition', async () => {
    const harness = stageContext({ stage: 'preview', payload: {} });
    const outcome = await handler().execute(harness.context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    expect(outcome.error.message).toContain('compositionId');
  });

  it('refuses a composition that does not validate, before drawing anything', async () => {
    const harness = stageContext({
      stage: 'preview',
      payload: { preview: { ir: { irVersion: 1 } } },
    });
    const outcome = await handler().execute(harness.context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
  });

  it('declares itself implemented, which is what the health endpoint reads', () => {
    expect(handler().implemented).toBe(true);
    expect(handler().stage).toBe('preview');
  });
});
