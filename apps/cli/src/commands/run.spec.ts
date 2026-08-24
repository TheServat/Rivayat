import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PIPELINE_STAGES, type RunId } from '@rv/contracts';

import { parseArgs } from '../cli/args';
import type { Command } from '../cli/command';
import { EXIT, type ExitCode } from '../cli/exit';
import { makeHarness, type Harness } from '../__fixtures__/harness';
import { listProjects, type LoadedProject } from '../store/project';
import { projectNewCommand } from './project';
import { STAGE_GAP, createRunCommand, runStages } from './run';

function counting(path: readonly string[], code: ExitCode = EXIT.ok): Command & { calls: number } {
  const command = {
    path,
    summary: 'counted',
    usage: ['x'],
    calls: 0,
    run(): Promise<ExitCode> {
      command.calls += 1;
      return Promise.resolve(code);
    },
  };
  return command;
}

describe('runStages', () => {
  let harness: Harness;
  let project: LoadedProject;

  beforeEach(async () => {
    harness = await makeHarness();
    await projectNewCommand.run(harness.context, parseArgs(['demo']));
    const all = await listProjects(harness.workspaceRoot);
    if (!all.ok || all.value[0] === undefined) throw new Error('no project');
    project = all.value[0];
  });
  afterEach(async () => {
    await harness.dispose();
  });

  const base = (): {
    context: Harness['context'];
    project: LoadedProject;
    lane: 'free';
    runId: RunId;
  } => ({
    context: harness.context,
    project,
    lane: 'free' as const,
    runId: 'run_01J8ZQ4E7K9M2N4P6R8T0V0001',
  });

  it('records every one of the twelve stages, in pipeline order', async () => {
    const records = await runStages({
      ...base(),
      commands: [],
      args: parseArgs([]),
      completed: new Set(),
      only: null,
    });
    expect(records.map((record) => record.stage)).toEqual([...PIPELINE_STAGES]);
  });

  /**
   * The RV-181 acceptance criterion, as a spy assertion: "completed stages are not
   * re-run". A resumed run that quietly re-executed S2 would look resumable and pay for
   * the story twice.
   */
  it('does not execute a stage already recorded as succeeded', async () => {
    const resolve = counting(['assets', 'plan']);
    const records = await runStages({
      ...base(),
      commands: [resolve],
      args: parseArgs(['--episode', 'E01']),
      completed: new Set(['resolve' as const]),
      only: new Set(['resolve' as const]),
    });
    expect(resolve.calls).toBe(0);
    expect(records[0]).toMatchObject({ stage: 'resolve', outcome: 'succeeded' });
    expect(records[0]?.detail).toContain('not re-executed');
  });

  it('executes a stage that is not yet complete', async () => {
    const resolve = counting(['assets', 'plan']);
    await runStages({
      ...base(),
      commands: [resolve],
      args: parseArgs(['--episode', 'E01']),
      completed: new Set(),
      only: new Set(['resolve' as const]),
    });
    expect(resolve.calls).toBe(1);
  });

  it('stops at the first failure rather than running the rest of the pipeline', async () => {
    const resolve = counting(['assets', 'plan'], EXIT.failed);
    const render = counting(['render']);
    const records = await runStages({
      ...base(),
      commands: [resolve, render],
      args: parseArgs(['--episode', 'E01']),
      completed: new Set(),
      only: new Set(['resolve' as const, 'render' as const]),
    });
    expect(resolve.calls).toBe(1);
    expect(render.calls).toBe(0);
    expect(records.at(-1)).toMatchObject({ stage: 'resolve', outcome: 'failed' });
  });

  /**
   * A `$0` total means nothing if the run silently omitted the stage that spends money.
   * Every unwired stage therefore names the package that owes it, from a data table.
   */
  it('records an unwired stage as skipped and names the package that owes it', async () => {
    const records = await runStages({
      ...base(),
      commands: [],
      args: parseArgs([]),
      completed: new Set(),
      only: new Set(['produce' as const, 'choreograph' as const]),
    });
    for (const record of records) {
      expect(record.outcome).toBe('skipped');
      expect(record.detail).toBe(STAGE_GAP[record.stage]);
      expect(record.detail).toMatch(/@rv\//);
    }
  });

  it('skips a stage whose input was not supplied, without calling anything', async () => {
    const story = counting(['story', 'new']);
    const records = await runStages({
      ...base(),
      commands: [story],
      // No `--idea`, so S0 has nothing to intake.
      args: parseArgs([]),
      completed: new Set(),
      only: new Set(['intake' as const]),
    });
    expect(story.calls).toBe(0);
    expect(records[0]?.outcome).toBe('skipped');
  });
});

describe('rv run', () => {
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

  it('writes a run record that a later --resume can read', async () => {
    const command = createRunCommand(() => []);
    const code = await command.run(
      harness.context,
      parseArgs(['--stages', 'S6', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.ok);

    const envelope = JSON.parse(harness.io.outText) as {
      data: { run: { id: string; stages: { stage: string }[]; lane: string; seed: number } };
    };
    expect(envelope.data.run.stages.map((s) => s.stage)).toEqual(['produce']);
    expect(envelope.data.run.lane).toBe('free');

    harness.io.stdout.length = 0;
    const resumed = await command.run(
      harness.context,
      parseArgs(['--resume', envelope.data.run.id, '--stages', 'S6', '--json'], {
        booleans: ['json'],
      }),
    );
    expect(resumed).toBe(EXIT.ok);
  });

  it('records the seed, because a replay that cannot name its seed cannot be replayed', async () => {
    const command = createRunCommand(() => []);
    await command.run(
      harness.context,
      parseArgs(['--stages', 'S6', '--json'], { booleans: ['json'] }),
    );
    const envelope = JSON.parse(harness.io.outText) as { data: { run: { seed: number } } };
    expect(envelope.data.run.seed).toBeGreaterThan(0);
  });

  it('exits 2 on an unknown stage name rather than silently running everything', async () => {
    const command = createRunCommand(() => []);
    expect(await command.run(harness.context, parseArgs(['--stages', 'S42']))).toBe(EXIT.usage);
  });

  it('exits 2 on a lane that is not free or paid', async () => {
    const command = createRunCommand(() => []);
    expect(await command.run(harness.context, parseArgs(['--lane', 'cheap']))).toBe(EXIT.usage);
  });

  it('exits 1 when asked to resume a run that was never recorded', async () => {
    const command = createRunCommand(() => []);
    const code = await command.run(
      harness.context,
      parseArgs(['--resume', 'run_01J8ZQ4E7K9M2N4P6R8T0V0009', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect((JSON.parse(harness.io.outText) as { code: string }).code).toBe('NOT_FOUND');
  });
});
