import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import { ProjectRecord } from '../store/documents';
import { projectListCommand, projectNewCommand } from './project';

const PERSIAN_NAME = 'دهکده';

describe('rv project new', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('writes a project that validates against its own schema', async () => {
    const code = await projectNewCommand.run(
      harness.context,
      parseArgs([PERSIAN_NAME, '--lang', 'fa']),
    );
    expect(code).toBe(EXIT.ok);

    const listed = await projectListCommand.run(
      harness.context,
      parseArgs(['--json'], { booleans: ['json'] }),
    );
    expect(listed).toBe(EXIT.ok);
  });

  /**
   * The M0 demo line is `pnpm rv project new "دهکده" --lang fa`. The assertion that
   * matters is not that it printed something - it is that the Persian name survived the
   * round trip through the filesystem byte for byte, because a name mangled on write is
   * a name every later screen shows wrong.
   */
  it('round-trips a Persian name through disk unchanged', async () => {
    await projectNewCommand.run(
      harness.context,
      parseArgs([PERSIAN_NAME, '--lang', 'fa', '--json'], { booleans: ['json'] }),
    );
    const data = jsonOut(harness.io).data as { project: { id: string }; path: string };

    const raw = await readFile(join(data.path, 'project.json'), 'utf8');
    const parsed = ProjectRecord.parse(JSON.parse(raw));
    expect(parsed.name).toBe(PERSIAN_NAME);
    expect([...parsed.name]).toHaveLength(5);
    expect(parsed.locale).toBe('fa');
    expect(parsed.styleBibleId).toBeNull();
  });

  it('prints the Persian name to the terminal unescaped', async () => {
    await projectNewCommand.run(harness.context, parseArgs([PERSIAN_NAME, '--lang', 'fa']));
    expect(harness.io.outText).toContain(PERSIAN_NAME);
    expect(harness.io.outText).not.toContain('\\u');
  });

  it('defaults the language to Persian, because the product is Persian-first', async () => {
    await projectNewCommand.run(
      harness.context,
      parseArgs(['Untitled', '--json'], { booleans: ['json'] }),
    );
    const data = jsonOut(harness.io).data as { project: { locale: string } };
    expect(data.project.locale).toBe('fa');
  });

  it('exits 2 with no name', async () => {
    expect(await projectNewCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });

  it('exits 2 on a language that is not in the Locale enum', async () => {
    const code = await projectNewCommand.run(
      harness.context,
      parseArgs(['x', '--lang', 'klingon']),
    );
    expect(code).toBe(EXIT.usage);
  });

  it('refuses to overwrite an existing project directory', async () => {
    // Two projects in a row get different ids, so the conflict has to be provoked by
    // reusing one. The guard exists because a second `project new` over a live project
    // would discard its locked style bible, and every asset key contains that checksum.
    await projectNewCommand.run(harness.context, parseArgs(['first']));
    const { createProject, listProjects } = await import('../store/project');
    const all = await listProjects(harness.workspaceRoot);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const existing = all.value[0];
    expect(existing).toBeDefined();
    if (existing === undefined) return;

    const again = await createProject({
      workspaceRoot: harness.workspaceRoot,
      id: existing.record.id,
      name: 'second',
      description: 'second',
      locale: 'fa',
      clock: harness.clock,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('CONFLICT');
  });
});

describe('rv project list', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('says so plainly when the workspace is empty', async () => {
    const code = await projectListCommand.run(harness.context, parseArgs([]));
    expect(code).toBe(EXIT.ok);
    expect(harness.io.outText).toContain('No projects yet');
  });

  it('lists every project it can read', async () => {
    await projectNewCommand.run(harness.context, parseArgs(['one']));
    // The clock is fixed, so the id generator's monotonic counter is what separates the
    // two ids - which is the property that keeps a replayed run reproducible.
    await projectNewCommand.run(harness.context, parseArgs(['two']));

    const { listProjects } = await import('../store/project');
    const all = await listProjects(harness.workspaceRoot);
    expect(all.ok && all.value.length).toBe(2);
  });
});
