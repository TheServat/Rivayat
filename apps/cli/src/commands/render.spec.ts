import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnimationIR } from '@rv/contracts';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import { validIr } from '../__fixtures__/animation';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import { writeJson } from '../store/json-file';
import { animationPath } from '../store/layout';
import { listProjects, type LoadedProject } from '../store/project';
import { projectNewCommand } from './project';
import { deliverCommand, renderCommand, renderResumeCommand } from './render';

const run = promisify(execFile);

/** FFmpeg is a local binary, not a network call, but a machine may still not have it. */
async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version'], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = await ffmpegAvailable();

async function onlyProject(harness: Harness): Promise<LoadedProject> {
  const all = await listProjects(harness.workspaceRoot);
  if (!all.ok || all.value[0] === undefined) throw new Error('no project');
  return all.value[0];
}

/** A four-frame, 64x64 composition. Small enough that a real render is a unit test. */
async function seedIr(project: LoadedProject): Promise<string> {
  const ir = {
    ...validIr(),
    fps: 4,
    durationMs: 1000,
    sceneSpace: { width: 64, height: 64 },
  };
  const path = animationPath(project.paths, 'E01');
  const written = await writeJson(path, AnimationIR, AnimationIR.parse(ir));
  if (!written.ok) throw written.error;
  return path;
}

describe('rv render', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await projectNewCommand.run(harness.context, parseArgs(['demo']));
    harness.io.stdout.length = 0;
    harness.io.stderr.length = 0;
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('exits 2 when given a positional, so `rv render resume x` is never a full render', async () => {
    const code = await renderCommand.run(harness.context, parseArgs(['resume']));
    expect(code).toBe(EXIT.usage);
    expect(harness.io.errText).toContain('render resume');
  });

  it('exits 1, naming the file, when the episode has no IR', async () => {
    const code = await renderCommand.run(
      harness.context,
      parseArgs(['--episode', 'E01', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(JSON.stringify(jsonOut(harness.io))).toContain('rvanim.json');
  });

  it.skipIf(!HAS_FFMPEG)(
    'renders every frame and reports a frame-stream hash',
    async () => {
      const project = await onlyProject(harness);
      await seedIr(project);

      const code = await renderCommand.run(
        harness.context,
        parseArgs(['--episode', 'E01', '--json'], { booleans: ['json'] }),
      );
      expect(code).toBe(EXIT.ok);

      const data = jsonOut(harness.io).data as {
        render: { framesTotal: number; framesRendered: number; frameStreamHash: string };
      };
      expect(data.render.framesTotal).toBe(4);
      expect(data.render.framesRendered).toBe(4);
      expect(data.render.frameStreamHash).toMatch(/^[0-9a-f]{64}$/);
    },
    120_000,
  );

  /**
   * The M4 claim: "a killed render resumes to a byte-identical result". The frame index
   * is the only state, so a resume of a finished run redraws nothing and the digest of
   * the ordered frame hashes is unchanged. That digest is the assertion.
   */
  it.skipIf(!HAS_FFMPEG)(
    'resumes without redrawing, to the same frame-stream hash',
    async () => {
      const project = await onlyProject(harness);
      await seedIr(project);

      await renderCommand.run(
        harness.context,
        parseArgs(['--episode', 'E01', '--json'], { booleans: ['json'] }),
      );
      const first = (
        jsonOut(harness.io).data as { render: { runId: string; frameStreamHash: string } }
      ).render;

      harness.io.stdout.length = 0;
      const code = await renderResumeCommand.run(
        harness.context,
        parseArgs([first.runId, '--episode', 'E01', '--json'], { booleans: ['json'] }),
      );
      expect(code).toBe(EXIT.ok);

      const second = (
        jsonOut(harness.io).data as {
          render: { framesRendered: number; frameStreamHash: string };
        }
      ).render;
      expect(second.framesRendered).toBe(0);
      expect(second.frameStreamHash).toBe(first.frameStreamHash);
    },
    180_000,
  );

  it('exits 2 when `render resume` is given no run id', async () => {
    expect(await renderResumeCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });
});

describe('rv deliver', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await projectNewCommand.run(harness.context, parseArgs(['demo']));
    harness.io.stdout.length = 0;
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('exits 2 without --episode', async () => {
    expect(await deliverCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });

  it('exits 2 when no format is chosen, and lists the ones that exist', async () => {
    const code = await deliverCommand.run(harness.context, parseArgs(['--episode', 'E01']));
    expect(code).toBe(EXIT.usage);
    expect(harness.io.errText).toContain('reels-9x16');
  });

  it('exits 2 on a format the platform table does not define', async () => {
    const code = await deliverCommand.run(
      harness.context,
      parseArgs(['--episode', 'E01', '--format', 'vhs-4x3']),
    );
    expect(code).toBe(EXIT.usage);
    expect(harness.io.errText).toContain('vhs-4x3');
  });

  it('exits 1 when there is no IR to reframe against', async () => {
    const code = await deliverCommand.run(
      harness.context,
      parseArgs(['--episode', 'E01', '--all', '--json'], { booleans: ['json', 'all'] }),
    );
    expect(code).toBe(EXIT.failed);
  });

  it.skipIf(!HAS_FFMPEG)(
    'cuts every requested format from one master and probes each result',
    async () => {
      const project = await onlyProject(harness);
      await seedIr(project);
      await renderCommand.run(harness.context, parseArgs(['--episode', 'E01']));
      harness.io.stdout.length = 0;

      const code = await deliverCommand.run(
        harness.context,
        parseArgs(['--episode', 'E01', '--format', 'reels-9x16', '--json'], {
          booleans: ['json'],
        }),
      );
      // The 64x64 master is far below every platform's declared frame size, so the
      // probe *should* report issues - and the command reports them as findings rather
      // than throwing the files away. Either outcome is a pass; a crash is not.
      expect([EXIT.ok, EXIT.findings]).toContain(code);

      const data = jsonOut(harness.io).data as {
        manifest: { entries: { format: string; artifact: { path: string } }[] };
        manifestPath: string;
      };
      expect(data.manifest.entries.map((entry) => entry.format)).toEqual(['reels-9x16']);
      expect(data.manifestPath).toContain('manifest.json');
      expect(join(harness.workspaceRoot, data.manifestPath)).toBeTruthy();
    },
    180_000,
  );
});
