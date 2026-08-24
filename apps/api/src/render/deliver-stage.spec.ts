/**
 * What a delivery produces, what it refuses, and what it says about a file that came
 * out wrong.
 *
 * FFmpeg is faked here and only here: the fake writes a real file at the path the real
 * encoder would and answers `ffprobe` with real JSON, so everything between - the
 * reframe solve, the filter graph, `validateAgainstProfile`, the manifest - is the code
 * that ships. What the fake cannot prove is that FFmpeg agrees, and that is proved
 * against the real binary in `deliver.e2e-spec.ts` with seven real files.
 *
 * The verdict tests are the point. `RunSummary.stages[].artifacts` can say a file
 * exists; only a probe can say it is 1080x1920 H.264 at 30 fps, and only the comparison
 * can say whether that is what the platform asked for.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { FORMAT_PRESETS, type FormatProfileId } from '@rv/contracts';
import {
  FfmpegEncoder,
  FfprobeReader,
  type PipedProcess,
  type ProcessPort,
  type ProcessResult,
  type ProcessSpec,
} from '@rv/render-engine';
import {
  FixedClock,
  MemoryLogger,
  ValidationError,
  at,
  err,
  instant,
  isErr,
  ok,
  type AppError,
  type Result,
} from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CompositionStore } from '../modules/compositions/composition.store';
import { ChoreographyStore } from './choreography.store';
import { DeliverStageHandler } from './deliver-stage.handler';
import { RunDelivery } from './delivery.contracts';
import { renderLayout } from './render-stage.handler';
import { stageContext, succeeded } from './__fixtures__/stage';

const KEY = 'a'.repeat(64);
const MASTER = { width: 400, height: 300 };
const DURATION_MS = 1000;

/**
 * FFmpeg, without FFmpeg.
 *
 * `run` is the only entry point a delivery uses: a transcode is one process, and the
 * frames never come through this side. The fake writes the output file because the use
 * case reads and hashes it afterwards - a fake that only reported success would let a
 * delivery "succeed" with nothing on disk, which is exactly the failure mode the
 * manifest exists to catch.
 */
class FakeFfmpeg implements ProcessPort {
  /** Formats the probe should describe wrongly, and how. */
  readonly #wrong: ReadonlyMap<string, { width: number; height: number }>;
  readonly commands: string[] = [];

  constructor(wrong: ReadonlyMap<string, { width: number; height: number }> = new Map()) {
    this.#wrong = wrong;
  }

  run(spec: ProcessSpec): Promise<Result<ProcessResult, AppError>> {
    const path = at(spec.args, spec.args.length - 1, 'path');
    this.commands.push(`${basename(spec.command)} ${basename(path)}`);

    if (spec.command.includes('ffprobe')) {
      return Promise.resolve(ok({ exitCode: 0, stdout: this.#probe(path), stderr: '' }));
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `encoded ${basename(path)}`, 'utf8');
    return Promise.resolve(ok({ exitCode: 0, stdout: '', stderr: 'frame= 30 fps=30' }));
  }

  spawnPiped(): Result<PipedProcess, AppError> {
    return err(new ValidationError({ message: 'a delivery never streams frames' }));
  }

  /** Real ffprobe JSON, describing whatever the profile in the file name asks for. */
  #probe(path: string): string {
    const id = basename(path).replace(/\.[^.]+$/, '');
    const profile = FORMAT_PRESETS[id as FormatProfileId] as
      (typeof FORMAT_PRESETS)[FormatProfileId] | undefined;
    const size = this.#wrong.get(id) ?? profile?.size ?? MASTER;
    const fps = profile?.fps ?? 24;

    return JSON.stringify({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: size.width,
          height: size.height,
          pix_fmt: 'yuv420p',
          r_frame_rate: `${String(fps)}/1`,
          duration: String(DURATION_MS / 1000),
          nb_frames: String(Math.round((DURATION_MS / 1000) * fps)),
          bit_rate: '9000000',
        },
      ],
      format: { duration: String(DURATION_MS / 1000) },
    });
  }
}

describe('DeliverStageHandler', () => {
  let workspace = '';

  function seedMaster(size = MASTER): string {
    const layout = renderLayout(workspace, KEY, 'h264');
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.master, 'a master', 'utf8');

    const manifest: RunDelivery = {
      renderKey: KEY,
      composition: size,
      files: [
        {
          kind: 'master',
          path: `renders/${KEY}/master.mp4`,
          format: null,
          sha256: 'b'.repeat(64),
          bytes: 8,
          durationMs: DURATION_MS,
          size,
          codecName: 'h264',
          pixelFormat: 'yuv420p',
          fps: 24,
          bitrateBps: null,
          frameCount: 24,
          hasAudio: false,
          issues: [],
          inSpec: null,
        },
      ],
      needsAttention: false,
      createdAt: '2026-08-24T00:00:00.000Z',
    };
    writeFileSync(layout.manifest, JSON.stringify(manifest), 'utf8');
    return layout.manifest;
  }

  function handler(process: ProcessPort): DeliverStageHandler {
    return new DeliverStageHandler({
      encoder: new FfmpegEncoder(process),
      prober: new FfprobeReader(process),
      compositions: new CompositionStore({
        workspaceDir: workspace,
        clock: new FixedClock(instant(0)),
        logger: new MemoryLogger(),
      }),
      choreography: new ChoreographyStore(workspace),
      clock: new FixedClock(instant(1_760_000_000_000)),
      logger: new MemoryLogger(),
      workspaceDir: workspace,
    });
  }

  function context(formats: readonly FormatProfileId[]) {
    return stageContext({
      stage: 'deliver',
      payload: { deliver: { formats } },
      stages: [succeeded('render', [`render-key:${KEY}`, 'render-master:abc'])],
    });
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'rivayat-deliver-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('cuts a file per format and records a verdict for each', async () => {
    const manifestPath = seedMaster();
    const harness = context(['ig-1x1', 'shorts-9x16']);

    const outcome = await handler(new FakeFfmpeg()).execute(harness.context);
    if (isErr(outcome)) throw outcome.error;

    // The files exist, at an address that says which aspect they were cut for.
    expect(existsSync(join(workspace, 'deliveries', KEY, '1x1', 'ig-1x1.mp4'))).toBe(true);
    expect(existsSync(join(workspace, 'deliveries', KEY, '9x16', 'shorts-9x16.mp4'))).toBe(true);

    const manifest = RunDelivery.parse(
      JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>,
    );
    expect(manifest.files.map((file) => file.format)).toEqual([null, 'ig-1x1', 'shorts-9x16']);

    const square = manifest.files.find((file) => file.format === 'ig-1x1');
    // Everything `render-master:<sha>` cannot carry, measured rather than asserted.
    expect(square?.size).toEqual({ width: 1080, height: 1080 });
    expect(square?.codecName).toBe('h264');
    expect(square?.fps).toBe(30);
    expect(square?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(square?.issues).toEqual([]);
    expect(square?.inSpec).toBe(true);
    expect(manifest.needsAttention).toBe(false);

    // The master survives the rewrite: a run that rendered and delivered has both.
    expect(manifest.files[0]?.kind).toBe('master');
    // One timeline's worth of video, not two files' worth: `deliveredMs` is the
    // denominator of cost per delivered minute.
    expect(outcome.value.deliveredMs).toBe(DURATION_MS);
    expect(outcome.value.artifacts).toContain(`render-key:${KEY}`);
  });

  it('says a file is out of spec when the bytes disagree with the profile', async () => {
    // Encoded landscape where Reels demands 1080x1920. Nothing upstream notices: the
    // job succeeded, the manifest lists it, the file plays.
    const manifestPath = seedMaster();
    const process = new FakeFfmpeg(new Map([['reels-9x16', { width: 1920, height: 1080 }]]));

    const outcome = await handler(process).execute(context(['reels-9x16']).context);
    if (isErr(outcome)) throw outcome.error;

    const manifest = RunDelivery.parse(
      JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>,
    );
    const reels = manifest.files.find((file) => file.format === 'reels-9x16');
    expect(reels?.inSpec).toBe(false);
    expect(reels?.issues.map((issue) => issue.code)).toContain('resolution-mismatch');
    // The list that needs eyes says so, which is the whole point of the verdict.
    expect(manifest.needsAttention).toBe(true);
  });

  it('groups the formats by aspect, so each is solved once', async () => {
    seedMaster();
    const process = new FakeFfmpeg();
    const outcome = await handler(process).execute(
      context(['yt-1080p', 'yt-2160p', 'shorts-9x16']).context,
    );
    if (isErr(outcome)) throw outcome.error;

    // Two aspects, three files: the 16:9 pair shares a solve and a directory.
    expect(existsSync(join(workspace, 'deliveries', KEY, '16x9', 'yt-1080p.mp4'))).toBe(true);
    expect(existsSync(join(workspace, 'deliveries', KEY, '16x9', 'yt-2160p.mp4'))).toBe(true);
    expect(existsSync(join(workspace, 'deliveries', KEY, '9x16', 'shorts-9x16.mp4'))).toBe(true);
    expect(process.commands.filter((command) => command.startsWith('ffmpeg'))).toHaveLength(3);
  });

  it('refuses a run that has rendered nothing, and says what to do', async () => {
    const harness = stageContext({ stage: 'deliver', payload: {} });
    const outcome = await handler(new FakeFfmpeg()).execute(harness.context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    expect(outcome.error.message).toContain('renderKey');
  });

  it('refuses a master that does not present the composition undistorted', async () => {
    // A 400x300 composition rendered into a 1000x300 master: every crop below would be
    // a fraction of the wrong rectangle.
    seedMaster({ width: 1000, height: 300 });
    const composition = { width: 400, height: 300 };
    const harness = stageContext({
      stage: 'deliver',
      payload: {
        deliver: { formats: ['ig-1x1'] },
        render: { ir: irOf(composition) },
      },
      stages: [succeeded('render', [`render-key:${KEY}`])],
    });

    const outcome = await handler(new FakeFfmpeg()).execute(harness.context);
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    expect(outcome.error.message).toContain('aspect');
  });

  it('refuses a render whose manifest is missing, rather than guessing the master', async () => {
    const layout = renderLayout(workspace, KEY, 'h264');
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.master, 'a master', 'utf8');

    const outcome = await handler(new FakeFfmpeg()).execute(context(['ig-1x1']).context);
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    expect(outcome.error.message).toContain('masterPath');
  });

  it('declares itself implemented, which is what the health endpoint reads', () => {
    expect(handler(new FakeFfmpeg()).implemented).toBe(true);
    expect(handler(new FakeFfmpeg()).stage).toBe('deliver');
  });
});

function irOf(size: { width: number; height: number }): Record<string, unknown> {
  return {
    irVersion: 1,
    id: 'anm_01J0000000000000000000000A',
    name: 'deliver fixture',
    fps: 24,
    durationMs: DURATION_MS,
    sceneSpace: size,
    seed: 1,
    nodes: [
      {
        kind: 'shape',
        id: 'nod_01J0000000000000000000000A',
        name: 'backdrop',
        parentId: null,
        depth: 0,
        shape: 'rect',
        fill: '#204060',
        size,
      },
    ],
    tracks: [],
    behaviours: [],
    markers: [],
  };
}
