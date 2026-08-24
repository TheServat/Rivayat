import { readdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StyleBible } from '@rv/contracts';
import { isLocked } from '@rv/core-domain';
import { STYLE_PRESETS, findPreset, materialiseStyleBible } from '@rv/style-engine';
import { toIso } from '@rv/shared-kernel';
import { lock } from '@rv/core-domain';
import { join } from 'node:path';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import { readJson, writeJson } from '../store/json-file';
import { listProjects, type LoadedProject } from '../store/project';
import { projectNewCommand } from './project';
import { styleListCommand, styleLockCommand, styleProbeCommand } from './style';

async function onlyProject(harness: Harness): Promise<LoadedProject> {
  const all = await listProjects(harness.workspaceRoot);
  if (!all.ok || all.value[0] === undefined) throw new Error('no project');
  return all.value[0];
}

describe('rv style list', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('lists the preset library from the engine, not from a copy', async () => {
    const code = await styleListCommand.run(
      harness.context,
      parseArgs(['--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.ok);
    const data = jsonOut(harness.io).data as { presets: { id: string }[] };
    expect(data.presets.map((preset) => preset.id)).toEqual(STYLE_PRESETS.map((p) => p.id));
  });

  it('prints the Persian name of every preset', async () => {
    await styleListCommand.run(harness.context, parseArgs([]));
    for (const preset of STYLE_PRESETS) {
      expect(harness.io.outText).toContain(preset.name.fa);
    }
  });
});

describe('rv style probe', () => {
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

  it('exits 2 without a preset', async () => {
    expect(await styleProbeCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });

  it('exits 2 on a lane that is not free or paid', async () => {
    const code = await styleProbeCommand.run(
      harness.context,
      parseArgs(['--preset', 'ink-comic', '--lane', 'cheap']),
    );
    expect(code).toBe(EXIT.usage);
  });

  it('exits 1 on a preset that is not on the shelf', async () => {
    const code = await styleProbeCommand.run(
      harness.context,
      parseArgs(['--preset', 'nonesuch', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(jsonOut(harness.io).code).toBe('NOT_FOUND');
  });

  /**
   * The money guard, and the stronger half of it: not only is nothing spent, nothing is
   * *written*. A refused probe that had already stored a candidate bible would leave a
   * style id in the project that no probe sheet exists for.
   */
  it('refuses the paid lane without --yes, and leaves no candidate behind', async () => {
    const code = await styleProbeCommand.run(
      harness.context,
      parseArgs(['--preset', 'ink-comic', '--lane', 'paid']),
    );
    expect(code).toBe(EXIT.spendRefused);

    const project = await onlyProject(harness);
    await expect(readdir(project.paths.stylesDir)).rejects.toThrow();
  });

  it('reports which lane is unavailable rather than throwing from inside an adapter', async () => {
    // The harness environment has no ComfyUI workflows and no key, so both lanes are
    // absent. A machine in that state must be told which one it is missing.
    const code = await styleProbeCommand.run(
      harness.context,
      parseArgs(['--preset', 'ink-comic', '--lane', 'paid', '--yes', '--json'], {
        booleans: ['json', 'yes'],
      }),
    );
    expect(code).toBe(EXIT.failed);
    const envelope = jsonOut(harness.io);
    expect(envelope.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(envelope)).toContain('GEMINI_API_KEY');
  });
});

describe('rv style lock', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await projectNewCommand.run(harness.context, parseArgs(['demo']));
    harness.io.stdout.length = 0;
  });
  afterEach(async () => {
    await harness.dispose();
  });

  async function seedCandidate(): Promise<{ project: LoadedProject; styleId: string }> {
    const project = await onlyProject(harness);
    const preset = findPreset('ink-comic');
    if (!preset.ok) throw preset.error;
    const bible = materialiseStyleBible({
      draft: preset.value.draft,
      id: harness.context.ids.styleBible(),
      clock: harness.clock,
    });
    const locked = lock(bible, toIso(harness.clock.now()));
    if (!locked.ok) throw locked.error;
    const written = await writeJson(
      join(project.paths.stylesDir, `${locked.value.id}.json`),
      StyleBible,
      locked.value,
    );
    if (!written.ok) throw written.error;
    return { project, styleId: locked.value.id };
  }

  it('exits 2 without --style', async () => {
    expect(await styleLockCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });

  it('exits 1 with a hint when no candidate has been probed', async () => {
    const code = await styleLockCommand.run(
      harness.context,
      parseArgs(['--style', 'sty_01J8ZQ4E7K9M2N4P6R8T0V0001', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(JSON.stringify(jsonOut(harness.io))).toContain('style probe');
  });

  /**
   * The checksum is a component of every asset dedup key, so approval has to write it
   * onto the project. A lock that only printed would leave every later `assets plan`
   * unable to say which style its keys were derived from.
   */
  it('promotes the candidate to the project and freezes its checksum', async () => {
    const { project, styleId } = await seedCandidate();
    const code = await styleLockCommand.run(
      harness.context,
      parseArgs(['--style', styleId, '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.ok);

    const stored = await readJson(project.paths.style, StyleBible, 'style bible');
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(isLocked(stored.value)).toBe(true);
    expect(stored.value.id).toBe(styleId);

    const refreshed = await onlyProject(harness);
    expect(refreshed.record.styleBibleId).toBe(styleId);
  });

  it('is idempotent: locking an already-locked candidate does not fail', async () => {
    const { styleId } = await seedCandidate();
    expect(await styleLockCommand.run(harness.context, parseArgs(['--style', styleId]))).toBe(
      EXIT.ok,
    );
    expect(await styleLockCommand.run(harness.context, parseArgs(['--style', styleId]))).toBe(
      EXIT.ok,
    );
  });
});
