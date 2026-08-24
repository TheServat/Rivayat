/**
 * Reading a manifest back, and the four ways there is nothing to read.
 *
 * All four are 404s to a client and four different things to the person debugging one,
 * so the body has to say which. "This run does not exist", "it never rendered", "it
 * rendered and wrote no manifest" and "the manifest is not readable" have different
 * fixes and only one of them is a bug.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProjectId, RunId } from '@rv/contracts';
import { InternalError, isErr, ok, toIso, instant, type Result } from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunRepository } from '../application/ports/repository.ports';
import { RunSummary, type RunStageResult } from '../application/resources';
import { DeliveryService, renderKeyOf } from './delivery.service';
import { renderLayout } from './render-stage.handler';

const PROJECT = 'prj_01J0000000000000000000000A' as ProjectId;
const RUN = 'run_01J0000000000000000000000A' as RunId;
const KEY = 'a'.repeat(64);

function stage(overrides: Partial<RunStageResult> = {}): RunStageResult {
  return {
    stage: 'render',
    status: 'succeeded',
    costNanoUsd: 0,
    durationMs: 10,
    artifacts: [`render-master:${'b'.repeat(64)}`, `render-key:${KEY}`],
    errorCode: null,
    inputHash: null,
    deliveredMs: 6000,
    ...overrides,
  };
}

function run(stages: readonly RunStageResult[]): RunSummary {
  return RunSummary.parse({
    id: RUN,
    projectId: PROJECT,
    seriesId: null,
    status: 'succeeded',
    requestedStages: ['render'],
    currentStage: null,
    stages,
    seed: 1,
    budgetNanoUsd: null,
    spentNanoUsd: 0,
    errorCode: null,
    startedAt: toIso(instant(0)),
    finishedAt: toIso(instant(1000)),
  });
}

class StubRuns implements Partial<RunRepository> {
  value: RunSummary | null = null;
  fail = false;

  findById(): Promise<Result<RunSummary | null>> {
    return Promise.resolve(
      this.fail
        ? { ok: false, error: new InternalError({ message: 'no database' }) }
        : ok(this.value),
    );
  }
}

describe('renderKeyOf', () => {
  it('finds the key a successful render recorded', () => {
    expect(renderKeyOf(run([stage()]))).toBe(KEY);
  });

  it('ignores a render that did not succeed', () => {
    // A cancelled render wrote frames and no master. Pointing a delivery view at its
    // directory would show a manifest describing a file that is not there.
    expect(renderKeyOf(run([stage({ status: 'cancelled', artifacts: [] })]))).toBeNull();
    expect(renderKeyOf(run([stage({ status: 'failed' })]))).toBeNull();
  });

  it('ignores a stage that is not the render', () => {
    expect(
      renderKeyOf(run([stage({ stage: 'intake', artifacts: [`render-key:${KEY}`] })])),
    ).toBeNull();
  });

  it('answers null for a successful render that recorded no key', () => {
    expect(renderKeyOf(run([stage({ artifacts: ['render-master:x'] })]))).toBeNull();
  });
});

describe('DeliveryService', () => {
  let workspace = '';
  let runs: StubRuns;
  let service: DeliveryService;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'rivayat-delivery-'));
    runs = new StubRuns();
    service = new DeliveryService({
      runs: runs as unknown as RunRepository,
      workspaceDir: workspace,
    });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function writeManifest(body: unknown): void {
    const layout = renderLayout(workspace, KEY, 'h264');
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.manifest, JSON.stringify(body), 'utf8');
  }

  const validManifest = {
    renderKey: KEY,
    composition: { width: 192, height: 192 },
    files: [
      {
        kind: 'master',
        path: 'renders/x/master.mp4',
        format: null,
        sha256: 'b'.repeat(64),
        bytes: 1234,
        durationMs: 6000,
        size: { width: 192, height: 192 },
        codecName: 'h264',
        pixelFormat: 'yuv420p',
        fps: 24,
        bitrateBps: 100_000,
        frameCount: 144,
        hasAudio: false,
        issues: [],
        inSpec: null,
      },
    ],
    needsAttention: false,
    createdAt: '2026-08-24T00:00:00.000Z',
  };

  it('returns the manifest the render wrote', async () => {
    runs.value = run([stage()]);
    writeManifest(validManifest);

    const found = await service.forRun(RUN);
    if (isErr(found)) throw found.error;
    expect(found.value.files[0]?.codecName).toBe('h264');
    expect(found.value.renderKey).toBe(KEY);
  });

  it('reports a storage failure rather than an empty delivery', async () => {
    runs.fail = true;
    expect(isErr(await service.forRun(RUN))).toBe(true);
  });

  it('404s a run that does not exist', async () => {
    runs.value = null;
    const missing = await service.forRun(RUN);
    expect(isErr(missing)).toBe(true);
    if (!isErr(missing)) return;
    expect(missing.error.kind).toBe('not-found');
    expect(missing.error.context).not.toHaveProperty('renderKey');
  });

  it('404s a run that never rendered, and says so', async () => {
    runs.value = run([stage({ stage: 'intake', artifacts: [] })]);
    const missing = await service.forRun(RUN);
    expect(isErr(missing)).toBe(true);
    if (!isErr(missing)) return;
    expect(String((missing.error.context as { reason?: string }).reason)).toContain('render');
  });

  it('404s when the render left no manifest, naming the key it looked under', async () => {
    runs.value = run([stage()]);
    const missing = await service.forRun(RUN);
    expect(isErr(missing)).toBe(true);
    if (!isErr(missing)) return;
    expect(missing.error.context).toMatchObject({ renderKey: KEY });
  });

  it('404s a manifest that is not JSON, rather than serving half a document', async () => {
    runs.value = run([stage()]);
    writeManifest('{"files": [');
    // `writeManifest` JSON-encodes, so write the broken text directly.
    const layout = renderLayout(workspace, KEY, 'h264');
    writeFileSync(layout.manifest, '{"files": [', 'utf8');

    const broken = await service.forRun(RUN);
    expect(isErr(broken)).toBe(true);
    if (!isErr(broken)) return;
    expect(String((broken.error.context as { reason?: string }).reason)).toContain('readable');
  });

  it('404s a manifest written by an older build, listing the fields that moved', async () => {
    runs.value = run([stage()]);
    writeManifest({ ...validManifest, files: [{ kind: 'master' }] });

    const stale = await service.forRun(RUN);
    expect(isErr(stale)).toBe(true);
    if (!isErr(stale)) return;
    // The paths, not just a message: a screen that renders half a card and a blank
    // verdict is worse than one that says the manifest is unreadable.
    expect((stale.error.context as { issues?: string[] }).issues?.length).toBeGreaterThan(0);
  });
});
