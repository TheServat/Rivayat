/**
 * One composition, previewed, rendered and delivered to every platform - over HTTP,
 * with the real FFmpeg, for `$0`.
 *
 * This is the end of the thread the three stages make: `POST /api/runs` with
 * `['preview', 'render', 'deliver']` and one payload, and what comes back is seven
 * files with a probe and a verdict each. Three properties are worth the wall time, and
 * none of them is provable anywhere cheaper:
 *
 *  1. **The preview does not lie.** It is rendered by the same evaluator and the same
 *     backend at a cadence that divides the master's, so preview frame `k` is master
 *     frame `2k` - and the assertion is a byte comparison of the two frame files, not a
 *     claim that they were produced by similar code.
 *  2. **The files satisfy the profiles they claim.** Probed with `ffprobe` after the
 *     fact, because everything before that reasons about intent. A delivery that came
 *     out 1920x1080 where Reels demands 1080x1920 looks identical from the inside.
 *  3. **It cost nothing.** No provider is configured in the harness, so the run's
 *     ledger is empty by construction - which is what RV-170's "the ledger shows
 *     `nanoUsd === 0` for the delivery run" means in practice.
 *
 * Skips loudly if FFmpeg is absent rather than failing: CI without a codec is a missing
 * tool, not a broken build.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import request from 'supertest';
import { FORMAT_PRESETS, type AnimationIR, type FormatProfileId } from '@rv/contracts';
import { frameFileName } from '@rv/render-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunSummary } from '../src/application/resources';
import type { RunDelivery } from '../src/render/delivery.contracts';
import { previewFps, previewSize } from '../src/render/preview-stage.contracts';
import { RenderStagePayload, renderKey } from '../src/render/render-stage.contracts';
import { CREATE_PROJECT } from './fixtures';
import { bootHarness, type Harness } from './harness';

const SIZE = { width: 320, height: 180 };
const FPS = 24;
const DURATION_MS = 500;
const ALL_FORMATS = Object.keys(FORMAT_PRESETS) as FormatProfileId[];

/** A subject that crosses the frame, so at least one crop has to travel with it. */
function composition(): AnimationIR {
  return {
    irVersion: 1,
    id: 'anm_01J000000000000000000000D9',
    name: 'delivery fixture',
    fps: FPS,
    durationMs: DURATION_MS,
    sceneSpace: { ...SIZE },
    seed: 4,
    nodes: [
      {
        kind: 'shape',
        id: 'nod_01J000000000000000000000B1',
        name: 'backdrop',
        parentId: null,
        depth: 100,
        shape: 'rect',
        fill: '#123a5e',
        size: { ...SIZE },
        transform: { anchor: { x: 0.5, y: 0.5 } },
      },
      {
        kind: 'shape',
        id: 'nod_01J000000000000000000000S1',
        name: 'subject',
        parentId: null,
        depth: 0,
        shape: 'ellipse',
        fill: '#ffcc33',
        stroke: '#000000',
        strokeWidth: 2,
        size: { width: 40, height: 40 },
        transform: { position: { x: -100, y: 0 }, anchor: { x: 0.5, y: 0.5 } },
      },
    ],
    tracks: [
      {
        id: 'trk_01J000000000000000000000S1',
        nodeId: 'nod_01J000000000000000000000S1',
        channel: 'position.x',
        keyframes: [
          { timeMs: 0, value: -100, easing: { kind: 'named', name: 'linear' } },
          { timeMs: DURATION_MS, value: 100, easing: { kind: 'named', name: 'linear' } },
        ],
        before: 'hold',
        after: 'hold',
        additive: false,
      },
    ],
    behaviours: [],
    markers: [],
    camera: {
      keyframes: [
        { timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
        { timeMs: DURATION_MS, position: { x: 20, y: 0 }, zoom: 1.1, rotation: 0 },
      ],
      focusNodeId: 'nod_01J000000000000000000000S1',
    },
  } as unknown as AnimationIR;
}

function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    probe.on('error', () => {
      resolve(false);
    });
    probe.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

/** `ffprobe`, for the assertions that must not trust our own prober. */
function ffprobe(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      path,
    ]);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => {
      resolve(out);
    });
  });
}

describe('one composition, seven deliverables', () => {
  let harness: Harness;
  let available = false;
  let projectId = '';

  beforeAll(async () => {
    harness = await bootHarness();
    available = await ffmpegAvailable();
    if (!available) {
      console.warn('SKIPPING the delivery suite: no runnable ffmpeg on PATH.');
      return;
    }

    const created = await request(harness.server)
      .post('/api/projects')
      .send(CREATE_PROJECT)
      .expect(201);
    projectId = (created.body as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  it('previews, renders and delivers in one run, and every file is in spec', async () => {
    if (!available) return;

    const ir = composition();
    const started = await request(harness.server)
      .post('/api/runs')
      .send({
        projectId,
        stages: ['preview', 'render', 'deliver'],
        seed: 17,
        payload: {
          // Kept so the preview's honesty can be checked against the master's own frames.
          preview: { keepFrames: true },
          render: { ir, size: SIZE, backend: 'napi-canvas', codec: 'h264', keepFrames: true },
          deliver: { formats: ALL_FORMATS },
        },
      })
      .expect(202);

    const runId = (started.body as RunSummary).id;
    const run = await settle(harness, runId);
    expect(run.status, describe_(run)).toBe('succeeded');

    // ── the run said what it did ───────────────────────────────────────────
    const stages = new Map(run.stages.map((stage) => [stage.stage, stage]));
    expect(stages.get('preview')?.status).toBe('succeeded');
    expect(stages.get('render')?.status).toBe('succeeded');
    expect(stages.get('deliver')?.status).toBe('succeeded');
    // One timeline's worth of video, not eight: the denominator of cost per minute.
    expect(stages.get('deliver')?.deliveredMs).toBe(DURATION_MS);
    // A preview is not a deliverable, so it claims no delivered milliseconds at all.
    expect(stages.get('preview')?.deliveredMs).toBeNull();

    // ── the verdict route ──────────────────────────────────────────────────
    const delivery = (await request(harness.server).get(`/api/runs/${runId}/delivery`).expect(200))
      .body as RunDelivery;

    expect(delivery.files).toHaveLength(ALL_FORMATS.length + 1);
    expect(delivery.needsAttention).toBe(false);

    for (const format of ALL_FORMATS) {
      const file = delivery.files.find((entry) => entry.format === format);
      const profile = FORMAT_PRESETS[format];
      expect(file, format).toBeDefined();
      if (file === undefined) continue;

      // The verdict, and the measurements behind it.
      expect({ format, inSpec: file.inSpec }).toEqual({ format, inSpec: true });
      expect(file.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
      expect(file.size).toEqual(profile.size);
      expect(file.codecName).toBe('h264');
      expect(file.fps).toBeCloseTo(profile.fps, 2);
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      // Workspace-relative: a manifest outlives the workspace it was written in.
      expect(file.path.startsWith('/')).toBe(false);

      // Trust nothing: the file on disk, read by the platform's own tool.
      const probe = JSON.parse(
        await ffprobe(join(harness.config.paths.workspaceDir, file.path)),
      ) as { streams: { codec_type: string; width?: number; height?: number }[] };
      const video = probe.streams.find((stream) => stream.codec_type === 'video');
      expect({ format, width: video?.width, height: video?.height }).toEqual({
        format,
        width: profile.size.width,
        height: profile.size.height,
      });
    }
  }, 600_000);

  it('renders a preview frame that is exactly a master frame', () => {
    if (!available) return;

    const ir = composition();
    const master = RenderStagePayload.parse({
      ir,
      size: SIZE,
      backend: 'napi-canvas',
      codec: 'h264',
      keepFrames: true,
    });
    const cadence = previewFps(ir.fps, 12);
    const preview = RenderStagePayload.parse({
      ir: { ...ir, fps: cadence },
      size: previewSize(ir.sceneSpace, 640),
      backend: 'auto',
      codec: 'h264',
      keepFrames: true,
    });

    const workspace = harness.config.paths.workspaceDir;
    const frame = (key: string, index: number): string =>
      join(workspace, 'renders', key, 'frames', frameFileName(index));

    const ratio = ir.fps / cadence;
    expect(existsSync(frame(renderKey(preview), 0))).toBe(true);

    for (let index = 0; index * ratio < (DURATION_MS / 1000) * ir.fps; index += 1) {
      const previewFrame = readFileSync(frame(renderKey(preview), index));
      const masterFrame = readFileSync(frame(renderKey(master), index * ratio));
      // Byte-identical, not similar. The preview is the render at a coarser cadence,
      // so a difference here would mean one of them is drawing something else.
      expect(previewFrame.equals(masterFrame), `frame ${String(index)}`).toBe(true);
    }
  }, 120_000);

  it('costs nothing, because a delivery calls no provider', async () => {
    if (!available) return;

    const started = await request(harness.server)
      .post('/api/render/deliveries')
      .send({ projectId, renderKey: 'deadbeef', formats: ['ig-1x1'] })
      .expect(202);

    // The route exists and starts a run; the run fails because that master does not
    // exist, which is the honest outcome for a key nobody rendered.
    const run = await settle(harness, (started.body as RunSummary).id);
    expect(run.status).toBe('failed');
    expect(run.spentNanoUsd).toBe(0);
  }, 60_000);

  it('starts a delivery from the run that rendered the master', async () => {
    if (!available) return;

    const rendered = await request(harness.server)
      .post('/api/runs')
      .send({
        projectId,
        stages: ['render'],
        seed: 21,
        payload: {
          render: { ir: composition(), size: SIZE, backend: 'napi-canvas', codec: 'h264' },
        },
      })
      .expect(202);
    const renderRun = await settle(harness, (rendered.body as RunSummary).id);
    expect(renderRun.status, describe_(renderRun)).toBe('succeeded');

    // What the screen has is a finished run and a button.
    const started = await request(harness.server)
      .post('/api/render/deliveries')
      .send({ projectId, runId: renderRun.id, formats: ['ig-1x1', 'tiktok-9x16'] })
      .expect(202);

    const deliveryRun = await settle(harness, (started.body as RunSummary).id);
    expect(deliveryRun.status, describe_(deliveryRun)).toBe('succeeded');

    // A delivery-only run can still say what it produced: it records the render key it
    // cut from, so the verdict route resolves for it too.
    const delivery = (
      await request(harness.server).get(`/api/runs/${deliveryRun.id}/delivery`).expect(200)
    ).body as RunDelivery;
    expect(delivery.files.filter((file) => file.kind === 'delivery')).toHaveLength(2);
    expect(deliveryRun.spentNanoUsd).toBe(0);
  }, 300_000);

  it('refuses to start a delivery for a run that has rendered nothing', async () => {
    const started = await request(harness.server)
      .post('/api/runs')
      .send({ projectId, stages: ['intake'], seed: 3, payload: { brief: {} } })
      .expect(202);
    const run = await settle(harness, (started.body as RunSummary).id);

    const refused = await request(harness.server)
      .post('/api/render/deliveries')
      .send({ projectId, runId: run.id })
      .expect(400);

    expect((refused.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  }, 60_000);
});

/** Why a run failed, in the assertion message, so a red e2e is diagnosable. */
function describe_(run: RunSummary): string {
  return run.stages
    .map((stage) => `${stage.stage}:${stage.status}:${stage.errorCode ?? '-'}`)
    .join(' ');
}

/** Polls until the run reaches a terminal state, which is what a client does. */
async function settle(harness: Harness, runId: string): Promise<RunSummary> {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    const current = (await request(harness.server).get(`/api/runs/${runId}`).expect(200))
      .body as RunSummary;
    if (current.status === 'succeeded' || current.status === 'failed') return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${runId} never settled`);
}
