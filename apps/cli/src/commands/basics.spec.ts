import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Ids } from '@rv/contracts';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import { assetsProduceCommand, characterCommand, doctorCommand } from './basics';
import { renderChecks, type Check } from './doctor';
import { resolveRunId } from './produce';

describe('renderChecks', () => {
  it('marks each check and says what it enables', () => {
    const checks: Check[] = [
      { name: 'Ollama', ok: true, detail: 'qwen3.5', enables: 'the free local text lane' },
      { name: 'Gemini key', ok: false, detail: 'absent', enables: 'the paid image lane' },
    ];
    const rendered = renderChecks(checks);
    expect(rendered).toContain('OK');
    expect(rendered).toContain('MISS');
    expect(rendered).toContain('the free local text lane');
  });
});

describe('rv doctor', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(async () => {
    await harness.dispose();
    vi.unstubAllGlobals();
  });

  /**
   * Every probe is stubbed. `doctor` is the one command whose job is to touch the
   * outside world, so the spec's job is to assert what it *concludes*, not to reach it.
   */
  it('exits 1 when a lane-blocking dependency is missing, naming it', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    const code = await doctorCommand.run(harness.context, parseArgs([]));
    // FFmpeg may genuinely be installed on the machine running this, so the assertion is
    // about Ollama, which the stub guarantees is unreachable.
    expect(code).toBe(EXIT.failed);
    expect(harness.io.errText).toContain('Ollama');
  });

  it('reports every check in the JSON envelope, blocking ones separately', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    await doctorCommand.run(harness.context, parseArgs(['--json'], { booleans: ['json'] }));
    const data = jsonOut(harness.io).data as {
      checks: { name: string }[];
      blocking: string[];
    };
    expect(data.checks.map((check) => check.name)).toContain('ComfyUI');
    expect(data.blocking).toContain('Ollama');
  });

  it('passes when every blocking dependency answers', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ models: [{ name: 'qwen3.5:latest' }] }), { status: 200 }),
      ),
    );
    const code = await doctorCommand.run(
      harness.context,
      parseArgs(['--json'], { booleans: ['json'] }),
    );
    const data = jsonOut(harness.io).data as { blocking: string[] };
    // FFmpeg is a real binary probe and may be absent; Ollama must not be in the list.
    expect(data.blocking).not.toContain('Ollama');
    expect([EXIT.ok, EXIT.failed]).toContain(code);
  });
});

describe('rv character', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('exits 2 without a premise', async () => {
    expect(await characterCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
    expect(harness.io.errText).toContain('premise');
  });
});

describe('rv assets produce', () => {
  let harness: Harness;
  let empty: string;

  beforeEach(async () => {
    empty = await mkdtemp(join(tmpdir(), 'rv-flows-'));
    harness = await makeHarness({ env: { RV_COMFYUI_WORKFLOW_DIR: empty } });
  });
  afterEach(async () => {
    await harness.dispose();
    await rm(empty, { recursive: true, force: true });
  });

  /**
   * The workflow check runs before the GPU is touched, so a checkout missing the graphs
   * fails in a second with a path rather than after a minute with a ComfyUI stack trace.
   */
  it('exits 1 naming the missing workflow, before anything is generated', async () => {
    const code = await assetsProduceCommand.run(
      harness.context,
      parseArgs(['--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(JSON.stringify(jsonOut(harness.io))).toContain('txt2img-lcm-draft.json');
  });
});

/**
 * The CLI's half of produce resumability.
 *
 * `DrizzleProduceCheckpointRepository` keys every checkpoint on
 * `(runId, assetKey, step, attempt)`, so a second invocation only skips work if it
 * claims the *same* run. That is this function's whole job, and getting it wrong looks
 * exactly like a working resume until you check the step tally.
 */
describe('resolveRunId', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rv-run-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the same id on a second call, so checkpoints are reachable', async () => {
    const ids = new Ids();
    const first = await resolveRunId(dir, { fresh: false, explicit: undefined, ids });
    const second = await resolveRunId(dir, { fresh: false, explicit: undefined, ids });
    expect(second).toBe(first);
  });

  it('claims a new id under --fresh, which is how every step re-runs', async () => {
    const ids = new Ids();
    const first = await resolveRunId(dir, { fresh: false, explicit: undefined, ids });
    const fresh = await resolveRunId(dir, { fresh: true, explicit: undefined, ids });
    expect(fresh).not.toBe(first);
  });

  it('honours an explicit run id without disturbing the stored one', async () => {
    const ids = new Ids();
    const stored = await resolveRunId(dir, { fresh: false, explicit: undefined, ids });
    const explicit = await resolveRunId(dir, {
      fresh: false,
      explicit: 'run_01J8ZQ4E7K9M2N4P6R8T0V0001',
      ids,
    });
    expect(explicit).toBe('run_01J8ZQ4E7K9M2N4P6R8T0V0001');
    expect(await resolveRunId(dir, { fresh: false, explicit: undefined, ids })).toBe(stored);
  });
});
