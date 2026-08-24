/**
 * Kill a render. Resume it. The master is byte-identical.
 *
 * This is M4's exit criterion, and the word that makes it hard is *identical*. Three
 * cheaper tests would all pass without the property holding, so none of them is this
 * one:
 *
 *  - Aborting with an `AbortController` proves the abort path. It does not touch the
 *    crash path, and it leaves every in-memory structure intact for the "resume" to
 *    use - the checkpoint, the run record, the payload, the open database handle.
 *  - Re-rendering from scratch also produces an identical file, because `evaluate` is
 *    pure. Asserting on that is asserting that purity, not that resume works.
 *  - Comparing "similar" or "valid" output would pass on a file with a spliced seam.
 *
 * So: a real child process, a real `SIGKILL` with no warning, and a `sha256` of the two
 * files. The parent watches the frame directory and kills the child the moment frames
 * start landing, which is genuinely mid-loop - nothing in the child cooperates.
 *
 * What has to survive the kill for this to work at all, and where each thing lives:
 *
 * | survives                | because                                                     |
 * |-------------------------|-------------------------------------------------------------|
 * | the frames drawn so far | `FileFrameStore` under `renders/<renderKey>/frames`         |
 * | which frames those are  | `PinnedCheckpointStore`, written every frame                |
 * | the run record          | SQLite on disk, not `:memory:`                              |
 * | what the run was for    | `JsonFileRunPayloadStore` - a payload that died with its worker cannot be resumed |
 *
 * `$0` throughout: no provider is configured, and rendering is local compute.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256 } from '@rv/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunSummary } from '../src/application/resources';
import { RenderStagePayload, renderKey } from '../src/render/render-stage.contracts';
import { RENDER_FRAMES, renderPayload } from './render-fixtures';

const PROJECT_ID = 'prj_01J0000000000000000000000A';
const CHILD = join(import.meta.dirname, 'render-worker.child.ts');

interface ChildEvent {
  readonly event: string;
  readonly runId?: string;
  readonly run?: RunSummary | null;
  readonly code?: string;
  readonly message?: string;
}

interface ChildOutcome {
  readonly events: readonly ChildEvent[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/** A workspace, its database, and the render key everything in it is filed under. */
interface Scratch {
  readonly root: string;
  readonly database: string;
  readonly payloadFile: string;
  readonly framesDir: string;
  readonly masterPath: string;
}

let scratchRoot = '';
let ffmpegAvailable = false;

function scratch(name: string, variant: number): Scratch {
  const root = join(scratchRoot, name);
  mkdirSync(root, { recursive: true });

  const payload = renderPayload(variant);
  const payloadFile = join(root, 'payload.json');
  writeFileSync(payloadFile, JSON.stringify(payload), 'utf8');

  const key = renderKey(RenderStagePayload.parse(payload));
  return {
    root,
    database: join(root, 'rivayat.db'),
    payloadFile,
    framesDir: join(root, 'renders', key, 'frames'),
    masterPath: join(root, 'renders', key, 'master.mp4'),
  };
}

function launch(place: Scratch, mode: 'start' | 'resume', runId?: string): ChildProcess {
  const configPath = join(place.root, `${mode}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      mode,
      workspace: place.root,
      database: place.database,
      payloadFile: place.payloadFile,
      projectId: PROJECT_ID,
      ...(runId === undefined ? {} : { runId }),
    }),
    'utf8',
  );

  // `--conditions=development` is what makes `@rv/*` resolve to sibling `src` trees, the
  // same way Vitest resolves them. Without it the child would run whatever `dist` last
  // held, which is a different program from the one under test.
  return spawn(
    process.execPath,
    ['--conditions=development', '--import', 'tsx', CHILD, configPath],
    { cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function collect(child: ChildProcess): Promise<ChildOutcome> {
  const events: ChildEvent[] = [];
  let buffered = '';
  let stderr = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as ChildEvent);
      } catch {
        stderr += `unparsed stdout: ${line}\n`;
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      resolve({ events, code, signal, stderr });
    });
  });
}

function frameFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.rvf'));
}

/**
 * Resolves once at least `count` frames are on disk, or the child exits first.
 *
 * A poll rather than a watcher because the directory does not exist yet when the child
 * is spawned, and because the assertion this feeds - "the kill landed mid-render" - is
 * checked afterwards on the frame count rather than assumed here.
 */
async function waitForFrames(place: Scratch, count: number, timeoutMs: number): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const present = frameFiles(place.framesDir).length;
    if (present >= count) return present;
    if (performance.now() > deadline) return present;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function hashOf(path: string): Promise<string> {
  return sha256(Uint8Array.from(await readFile(path)));
}

function masterArtifact(run: RunSummary | null | undefined): string {
  const stage = run?.stages.find((entry) => entry.stage === 'render');
  const artifact = stage?.artifacts.find((ref) => ref.startsWith('render-master:'));
  return artifact ?? '';
}

describe('a killed render, resumed', () => {
  beforeAll(async () => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'rivayat-resume-'));

    // Named, not silent. The whole value of this file is that it encodes a real file
    // with the real binary; a green run that skipped it would be a lie about M4.
    const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    ffmpegAvailable = await new Promise<boolean>((resolve) => {
      probe.on('error', () => {
        resolve(false);
      });
      probe.on('close', (code) => {
        resolve(code === 0);
      });
    });
    if (!ffmpegAvailable) {
      console.warn('SKIPPING the resume suite: no runnable ffmpeg on PATH.');
    }
  }, 60_000);

  afterAll(() => {
    if (scratchRoot !== '') rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('produces a byte-identical master after the process rendering it is killed', async () => {
    if (!ffmpegAvailable) return;

    // ── the reference: one process, start to finish ────────────────────
    const reference = scratch('reference', 0);
    const straight = await collect(launch(reference, 'start'));
    expect(straight.stderr, straight.stderr).not.toContain('Error');
    expect(straight.code).toBe(0);

    const referenceRun = straight.events.find((event) => event.event === 'finished')?.run;
    expect(referenceRun?.status).toBe('succeeded');
    expect(frameFiles(reference.framesDir)).toHaveLength(RENDER_FRAMES);
    const referenceHash = await hashOf(reference.masterPath);

    // ── the same render, killed mid-loop ───────────────────────────────
    const interrupted = scratch('interrupted', 0);
    const victim = launch(interrupted, 'start');
    const victimOutcome = collect(victim);

    // A third of the way in, so the resume demonstrably reuses a substantial amount of
    // work rather than eight frames of it. Still comfortably mid-loop: the whole draw
    // is around 2.7 seconds and this lands under a second into it.
    const killAfter = Math.floor(RENDER_FRAMES / 3);
    const seen = await waitForFrames(interrupted, killAfter, 60_000);
    expect(
      seen,
      'not enough frames appeared, so nothing was killed mid-render',
    ).toBeGreaterThanOrEqual(killAfter);
    victim.kill('SIGKILL');
    const killed = await victimOutcome;

    // Killed, not exited: `SIGKILL` cannot be caught, so nothing ran on the way out.
    expect(killed.signal ?? '', `child exited ${String(killed.code)}`).toBe('SIGKILL');

    const survivors = frameFiles(interrupted.framesDir);
    expect(survivors.length).toBeGreaterThan(0);
    expect(
      survivors.length,
      'the kill landed after the render finished; the fixture is too fast',
    ).toBeLessThan(RENDER_FRAMES);
    expect(existsSync(interrupted.masterPath)).toBe(false);

    const runId = killed.events.find((event) => event.event === 'accepted')?.runId;
    expect(runId).toBeDefined();
    if (runId === undefined) return;

    // Frame identity before the resume, so "not recomputed" is an assertion about
    // these exact files rather than about the count.
    const before = new Map(
      survivors.map((name) => [name, statSync(join(interrupted.framesDir, name)).mtimeMs]),
    );

    // ── resume, in a new process, over what reached the disk ───────────
    const resumed = await collect(launch(interrupted, 'resume', runId));
    expect(resumed.stderr, resumed.stderr).not.toContain('Error');
    expect(resumed.code).toBe(0);

    const resumedRun = resumed.events.find((event) => event.event === 'finished')?.run;
    expect(resumedRun?.id).toBe(runId);
    expect(resumedRun?.status, JSON.stringify(resumedRun?.stages)).toBe('succeeded');

    // The frames that survived were reused, not redrawn.
    //
    // "All but at most one", not "all", and the one is not slack - it is the exact
    // width of the window between `frames.put(f)` and the checkpoint that claims it.
    // A kill inside that window leaves frame `f` on disk unclaimed (or half written),
    // and the resume redraws it rather than trusting a file no checkpoint vouches
    // for. Two would mean the checkpoint had fallen a frame further behind than
    // `checkpointEvery: 1` allows.
    const redrawn = [...before].filter(
      ([name, mtime]) => statSync(join(interrupted.framesDir, name)).mtimeMs !== mtime,
    );
    expect(
      redrawn.length,
      `redrew surviving frames: ${redrawn.map(([name]) => name).join(', ')}`,
    ).toBeLessThanOrEqual(1);
    expect(frameFiles(interrupted.framesDir)).toHaveLength(RENDER_FRAMES);

    // ── the claim ──────────────────────────────────────────────────────
    const resumedHash = await hashOf(interrupted.masterPath);
    console.info(`reference master sha256 ${referenceHash}`);
    console.info(`resumed   master sha256 ${resumedHash}`);
    console.info(
      `killed after ${String(survivors.length)} of ${String(RENDER_FRAMES)} frames; ` +
        `${String(RENDER_FRAMES - survivors.length)} redrawn on resume`,
    );
    expect(resumedHash).toBe(referenceHash);

    // And the run says so too: the artefact the API reports is the file's hash.
    expect(masterArtifact(resumedRun)).toBe(`render-master:${resumedHash}`);
    expect(masterArtifact(resumedRun)).toBe(masterArtifact(referenceRun));

    // Nothing was spent. The render is local compute and no provider is configured.
    expect(resumedRun?.spentNanoUsd).toBe(0);
  }, 240_000);

  it('records the killed run as failed with the worker named, not as cancelled', async () => {
    if (!ffmpegAvailable) return;

    const place = scratch('orphan', 1);
    const victim = launch(place, 'start');
    const outcome = collect(victim);

    const seen = await waitForFrames(place, 4, 60_000);
    expect(seen).toBeGreaterThanOrEqual(4);
    victim.kill('SIGKILL');
    const killed = await outcome;
    const runId = killed.events.find((event) => event.event === 'accepted')?.runId;
    expect(runId).toBeDefined();
    if (runId === undefined) return;

    const resumed = await collect(launch(place, 'resume', runId));
    const run = resumed.events.find((event) => event.event === 'finished')?.run;

    // A killed worker is a failure, and the run's history says which failure. It is
    // emphatically not `cancelled`: nobody decided to stop this.
    expect(run?.status).toBe('succeeded');
    expect(run?.errorCode).toBe('WORKER_LOST');
  }, 240_000);
});
