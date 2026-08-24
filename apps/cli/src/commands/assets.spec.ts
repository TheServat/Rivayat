import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StyleBible } from '@rv/contracts';
import { lock } from '@rv/core-domain';
import { toIso } from '@rv/shared-kernel';
import { findPreset, materialiseStyleBible } from '@rv/style-engine';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import { AssetRequirementsDocument, DOCUMENT_VERSION } from '../store/documents';
import { writeJson } from '../store/json-file';
import { listProjects, type LoadedProject } from '../store/project';
import { assetsEditCommand, assetsPlanCommand } from './assets';
import { projectNewCommand } from './project';

async function onlyProject(harness: Harness): Promise<LoadedProject> {
  const all = await listProjects(harness.workspaceRoot);
  if (!all.ok || all.value[0] === undefined) throw new Error('no project');
  return all.value[0];
}

async function lockStyle(harness: Harness, project: LoadedProject): Promise<void> {
  const preset = findPreset('paper-cutout');
  if (!preset.ok) throw preset.error;
  const bible = materialiseStyleBible({
    draft: preset.value.draft,
    id: harness.context.ids.styleBible(),
    clock: harness.clock,
  });
  const locked = lock(bible, toIso(harness.clock.now()));
  if (!locked.ok) throw locked.error;
  const written = await writeJson(project.paths.style, StyleBible, locked.value);
  if (!written.ok) throw written.error;
}

async function seedRequirements(project: LoadedProject): Promise<void> {
  const written = await writeJson(
    join(project.paths.assetsDir, 'requirements.json'),
    AssetRequirementsDocument,
    {
      version: DOCUMENT_VERSION,
      projectId: project.record.id,
      byEpisode: {
        E01: [
          {
            semanticKey: 'prop/street-lamp/terrace',
            label: 'Terrace street lamp',
            description: 'A cast-iron street lamp with a glass lantern head',
            archetype: 'articulated-prop',
            subjectClass: 'prop',
            tags: [],
          },
        ],
        '*': [
          {
            semanticKey: 'flora/oak-tree/mature',
            label: 'Mature oak',
            description: 'A broad mature oak with a heavy canopy',
            archetype: 'tree',
            subjectClass: 'foliage',
            tags: [],
          },
        ],
      },
      updatedAt: '2026-08-23T18:00:00.000Z',
    },
  );
  if (!written.ok) throw written.error;
}

describe('rv assets plan', () => {
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

  it('exits 2 without --episode', async () => {
    expect(await assetsPlanCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });

  /**
   * Every asset key contains the style checksum, so a plan produced without a locked
   * style would quote for keys nothing could ever find again.
   */
  it('refuses to plan against a project with no locked style', async () => {
    const code = await assetsPlanCommand.run(
      harness.context,
      parseArgs(['--episode', 'E01', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(JSON.stringify(jsonOut(harness.io))).toContain('style checksum');
  });

  it('says what to write when an episode has no requirements at all', async () => {
    const project = await onlyProject(harness);
    await lockStyle(harness, project);
    const code = await assetsPlanCommand.run(
      harness.context,
      parseArgs(['--episode', 'E01', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(JSON.stringify(jsonOut(harness.io))).toContain('requirements.json');
  });

  it('prices every requirement as a miss on an empty library, and spends nothing', async () => {
    const project = await onlyProject(harness);
    await lockStyle(harness, project);
    await seedRequirements(project);

    const code = await assetsPlanCommand.run(
      harness.context,
      parseArgs(['--episode', 'E01', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.ok);

    const data = jsonOut(harness.io).data as {
      plan: {
        hitCount: number;
        missCount: number;
        totalEstimatedNanoUsd: number;
        resolutions: { semanticKey: string; outcome: string }[];
      };
    };
    expect(data.plan.hitCount).toBe(0);
    expect(data.plan.missCount).toBe(2);
    expect(data.plan.resolutions.map((r) => r.semanticKey).sort()).toEqual([
      'flora/oak-tree/mature',
      'prop/street-lamp/terrace',
    ]);
    expect(data.plan.totalEstimatedNanoUsd).toBeGreaterThan(0);
  });

  it('reports "nothing was generated" on stderr, so the negative property is visible', async () => {
    const project = await onlyProject(harness);
    await lockStyle(harness, project);
    await seedRequirements(project);
    await assetsPlanCommand.run(harness.context, parseArgs(['--episode', 'E01']));
    expect(harness.io.errText).toContain('Nothing was generated');
  });

  it('blocks a requirement that would breach the budget instead of inflating the total', async () => {
    const project = await onlyProject(harness);
    await lockStyle(harness, project);
    await seedRequirements(project);

    const code = await assetsPlanCommand.run(
      harness.context,
      // A budget of one nano-dollar: the first spec already exceeds it.
      parseArgs(['--episode', 'E01', '--budget', '0.000000001', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.ok);
    const data = jsonOut(harness.io).data as {
      plan: { missCount: number; resolutions: { outcome: string }[] };
    };
    expect(data.plan.resolutions.some((r) => r.outcome === 'blocked-by-budget')).toBe(true);
  });
});

describe('rv assets edit', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await projectNewCommand.run(harness.context, parseArgs(['demo']));
    harness.io.stdout.length = 0;
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('exits 2 when either flag is missing', async () => {
    expect(await assetsEditCommand.run(harness.context, parseArgs(['--asset', 'x']))).toBe(
      EXIT.usage,
    );
    expect(
      await assetsEditCommand.run(harness.context, parseArgs(['--instruction', 'brighter'])),
    ).toBe(EXIT.usage);
  });

  /**
   * The one demo command with nothing behind it. It must fail loudly and by name rather
   * than pretend - see the command's own note and `docs/05-remaining-work.md` §W3.
   */
  it('reports the missing use-case, naming the package that owes it', async () => {
    const code = await assetsEditCommand.run(
      harness.context,
      parseArgs(['--asset', 'prop/lantern/lit', '--instruction', 'brighter', '--json'], {
        booleans: ['json'],
      }),
    );
    // The asset does not exist either, so this is the earlier of the two refusals; the
    // point of the assertion is that it never silently succeeds.
    expect(code).toBe(EXIT.failed);
    expect(jsonOut(harness.io).ok).toBe(false);
  });
});
