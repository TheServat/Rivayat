import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PIPELINE_STAGES } from '@rv/contracts';
import { resolveAll } from '@rv/settings';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import {
  loadStack,
  modelsListCommand,
  modelsSetCommand,
  parseStage,
  stageSettingKey,
} from './models';
import { projectNewCommand } from './project';
import { resolveProject } from '../store/project';

describe('parseStage', () => {
  it('accepts the S-code the docs use', () => {
    expect(parseStage('S2')).toBe('story');
    expect(parseStage('s11')).toBe('deliver');
  });

  it('accepts the enum key the code uses', () => {
    expect(parseStage('choreograph')).toBe('choreograph');
  });

  it('returns undefined for anything else, rather than guessing a stage', () => {
    expect(parseStage('S99')).toBeUndefined();
    expect(parseStage('storyboard')).toBeUndefined();
  });
});

describe('rv models list', () => {
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

  it('lists every one of the twelve stages', async () => {
    const code = await modelsListCommand.run(
      harness.context,
      parseArgs(['--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.ok);
    const data = jsonOut(harness.io).data as { stages: { stage: string; code: string }[] };
    expect(data.stages.map((row) => row.stage)).toEqual([...PIPELINE_STAGES]);
  });

  it('reports the provenance of every binding, not just its value', async () => {
    await modelsListCommand.run(harness.context, parseArgs(['--json'], { booleans: ['json'] }));
    const data = jsonOut(harness.io).data as {
      stages: { origin: string; binding: string | null }[];
    };
    expect(data.stages.every((row) => row.origin === 'default')).toBe(true);
    expect(data.stages.every((row) => row.binding === null)).toBe(true);
  });

  it('offers alternatives drawn from the catalogue, not from a hand-written list', async () => {
    await modelsListCommand.run(harness.context, parseArgs(['--json'], { booleans: ['json'] }));
    const data = jsonOut(harness.io).data as {
      stages: { stage: string; alternatives: string[] }[];
    };
    const produce = data.stages.find((row) => row.stage === 'produce');
    // S6 makes images, so its alternatives must be image models and must not include
    // Ollama, which generates none. That is the registry's rule, asserted through the CLI.
    expect(produce?.alternatives.some((ref) => ref.startsWith('ollama:'))).toBe(false);
    expect(produce?.alternatives.length).toBeGreaterThan(0);
  });

  it('works with no project at all, showing the machine layer only', async () => {
    const empty = await makeHarness();
    try {
      const code = await modelsListCommand.run(empty.context, parseArgs([]));
      expect(code).toBe(EXIT.ok);
      expect(empty.io.errText).toContain('machine layer only');
    } finally {
      await empty.dispose();
    }
  });
});

describe('rv models set', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await projectNewCommand.run(harness.context, parseArgs(['demo']));
    harness.io.stdout.length = 0;
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('pins a stage at project scope and the resolver reports that provenance', async () => {
    const code = await modelsSetCommand.run(
      harness.context,
      parseArgs(['--stage', 'S2', '--binding', 'gemini:gemini-3-flash', '--json'], {
        booleans: ['json'],
      }),
    );
    expect(code).toBe(EXIT.ok);
    const data = jsonOut(harness.io).data as { value: string; origin: string; stage: string };
    expect(data).toMatchObject({
      stage: 'story',
      value: 'gemini:gemini-3-flash',
      origin: 'project',
    });
  });

  it('survives a fresh process: the pin is on disk, not in memory', async () => {
    await modelsSetCommand.run(
      harness.context,
      parseArgs(['--stage', 'story', '--binding', 'ollama:qwen3.5:latest']),
    );

    const project = await resolveProject({
      workspaceRoot: harness.workspaceRoot,
      explicit: undefined,
      env: {},
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    const resolved = resolveAll(await loadStack(harness.context, project.value));
    expect(resolved.get(stageSettingKey('story'))?.value).toBe('ollama:qwen3.5:latest');
  });

  it('merges rather than replaces, so pinning S3 does not clear S2', async () => {
    await modelsSetCommand.run(
      harness.context,
      parseArgs(['--stage', 'S2', '--binding', 'gemini:gemini-3-flash']),
    );
    await modelsSetCommand.run(
      harness.context,
      parseArgs(['--stage', 'S3', '--binding', 'ollama:qwen3.5:latest']),
    );

    const project = await resolveProject({
      workspaceRoot: harness.workspaceRoot,
      explicit: undefined,
      env: {},
    });
    if (!project.ok) throw new Error('no project');
    const resolved = resolveAll(await loadStack(harness.context, project.value));
    expect(resolved.get(stageSettingKey('story'))?.value).toBe('gemini:gemini-3-flash');
    expect(resolved.get(stageSettingKey('cast'))?.value).toBe('ollama:qwen3.5:latest');
  });

  it('clears a pin with --binding none', async () => {
    await modelsSetCommand.run(
      harness.context,
      parseArgs(['--stage', 'S2', '--binding', 'gemini:gemini-3-flash']),
    );
    harness.io.stdout.length = 0;
    const code = await modelsSetCommand.run(
      harness.context,
      parseArgs(['--stage', 'S2', '--binding', 'none', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.ok);
    const data = jsonOut(harness.io).data as { value: string | null };
    expect(data.value).toBeNull();
  });

  it('exits 2 when either flag is missing', async () => {
    expect(await modelsSetCommand.run(harness.context, parseArgs(['--stage', 'S2']))).toBe(
      EXIT.usage,
    );
    expect(await modelsSetCommand.run(harness.context, parseArgs(['--binding', 'a:b']))).toBe(
      EXIT.usage,
    );
  });

  it('exits 2 on a stage that does not exist', async () => {
    const code = await modelsSetCommand.run(
      harness.context,
      parseArgs(['--stage', 'S42', '--binding', 'ollama:x']),
    );
    expect(code).toBe(EXIT.usage);
  });

  it('exits 2 on a binding that is not provider:model', async () => {
    const code = await modelsSetCommand.run(
      harness.context,
      parseArgs(['--stage', 'S2', '--binding', 'justamodel']),
    );
    expect(code).toBe(EXIT.usage);
  });
});
