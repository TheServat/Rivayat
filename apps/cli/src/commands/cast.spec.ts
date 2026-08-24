import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import {
  CharacterStatesDocument,
  DOCUMENT_VERSION,
  type CharacterStateEntry,
} from '../store/documents';
import { writeJson } from '../store/json-file';
import { listProjects, type LoadedProject } from '../store/project';
import { castStatesCommand } from './cast';
import { projectNewCommand } from './project';

const SLUG = 'kael';

function states(): CharacterStateEntry[] {
  const expressions = Array.from({ length: 8 }, (_, index) => ({
    slug: `expression-${String(index)}`,
    kind: 'expression' as const,
    label: `Expression ${String(index)}`,
    description: 'Brow low, jaw set, weight on the back foot.',
    prompt: 'ink-comic style, brow low, jaw set, weight on the back foot',
  }));
  const poses = Array.from({ length: 6 }, (_, index) => ({
    slug: `pose-${String(index)}`,
    kind: 'pose' as const,
    label: `Pose ${String(index)}`,
    description: 'Hands loose, shoulders forward, about to run.',
    prompt: 'ink-comic style, hands loose, shoulders forward, about to run',
  }));
  const wardrobe = Array.from({ length: 2 }, (_, index) => ({
    slug: `wardrobe-${String(index)}`,
    kind: 'wardrobe' as const,
    label: `Outfit ${String(index)}`,
    description: 'Waxed canvas coat, worn at the cuffs.',
    prompt: 'ink-comic style, waxed canvas coat, worn at the cuffs',
  }));
  return [...expressions, ...poses, ...wardrobe];
}

async function onlyProject(harness: Harness): Promise<LoadedProject> {
  const all = await listProjects(harness.workspaceRoot);
  if (!all.ok || all.value[0] === undefined) throw new Error('no project');
  return all.value[0];
}

async function seedStates(harness: Harness): Promise<LoadedProject> {
  const project = await onlyProject(harness);
  const entries = states();
  const written = await writeJson(
    join(project.paths.castDir, `${SLUG}.json`),
    CharacterStatesDocument,
    {
      version: DOCUMENT_VERSION,
      projectId: project.record.id,
      characterSlug: SLUG,
      name: 'Kael',
      states: entries,
      variants: entries
        .filter((state) => state.kind !== 'wardrobe')
        .map((state) => ({
          semanticKey: `char/${SLUG}/${state.kind}`,
          variantKey: `wardrobe-0--${state.slug}`,
          label: `Outfit 0 / ${state.label}`,
          prompt: state.prompt,
        })),
      createdAt: '2026-08-23T18:00:00.000Z',
    },
  );
  if (!written.ok) throw written.error;
  return project;
}

describe('rv cast states --print', () => {
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

  it('exits 2 without --character', async () => {
    expect(await castStatesCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });

  /**
   * The M2 demo line: "8 expressions, 6 poses, 2 wardrobes, each with its prompt". The
   * counts are `STATE_MINIMA` in `@rv/story-engine`; what this asserts is that the read
   * path surfaces all of them, with a prompt behind every cell.
   */
  it('prints every state with the prompt that draws it', async () => {
    await seedStates(harness);
    const code = await castStatesCommand.run(
      harness.context,
      parseArgs(['--character', SLUG, '--print', '--json'], { booleans: ['print', 'json'] }),
    );
    expect(code).toBe(EXIT.ok);

    const data = jsonOut(harness.io).data as {
      states: { kind: string; prompt: string }[];
      variants: unknown[];
    };
    const byKind = (kind: string): number => data.states.filter((s) => s.kind === kind).length;
    expect(byKind('expression')).toBe(8);
    expect(byKind('pose')).toBe(6);
    expect(byKind('wardrobe')).toBe(2);
    expect(data.states.every((state) => state.prompt.length > 0)).toBe(true);
    expect(data.variants).toHaveLength(14);
  });

  it('renders the counts and the prompts for a human too', async () => {
    await seedStates(harness);
    await castStatesCommand.run(
      harness.context,
      parseArgs(['--character', SLUG, '--print'], { booleans: ['print'] }),
    );
    expect(harness.io.outText).toContain('expressions');
    expect(harness.io.outText).toContain('ink-comic style');
  });

  /**
   * `--print` must never fall through to generation. Nine model calls triggered by a
   * missing file would be the most expensive typo in the tool.
   */
  it('exits 1 rather than generating when --print finds nothing stored', async () => {
    const code = await castStatesCommand.run(
      harness.context,
      parseArgs(['--character', 'nobody', '--print', '--json'], { booleans: ['print', 'json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(jsonOut(harness.io).code).toBe('NOT_FOUND');
  });

  it('reads the stored set without a story document present', async () => {
    await seedStates(harness);
    const code = await castStatesCommand.run(harness.context, parseArgs(['--character', SLUG]));
    expect(code).toBe(EXIT.ok);
  });

  it('needs a story before it will generate a set that is not there', async () => {
    const code = await castStatesCommand.run(
      harness.context,
      parseArgs(['--character', SLUG, '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(JSON.stringify(jsonOut(harness.io))).toContain('rv story new');
  });

  it('exits 2 on a lane that is not free or paid', async () => {
    const code = await castStatesCommand.run(
      harness.context,
      parseArgs(['--character', SLUG, '--lane', 'cheap']),
    );
    expect(code).toBe(EXIT.usage);
  });
});
