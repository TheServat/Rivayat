import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import { EPISODE_06, KAEL_ID, cleanWorld, contradictoryWorld } from '../__fixtures__/world';
import { WorldDocument } from '../store/documents';
import { writeJson } from '../store/json-file';
import { listProjects } from '../store/project';
import { continuityCheckCommand, graphFrom, graphShowCommand } from './graph';
import { projectNewCommand } from './project';

async function seed(harness: Harness, world: WorldDocument): Promise<void> {
  const all = await listProjects(harness.workspaceRoot);
  if (!all.ok) throw new Error('no projects');
  const project = all.value[0];
  if (project === undefined) throw new Error('no project');
  const written = await writeJson(project.paths.world, WorldDocument, {
    ...world,
    projectId: project.record.id,
  });
  if (!written.ok) throw written.error;
}

describe('graphFrom', () => {
  it('rebuilds a graph whose vitality ledger answers "was Kael alive then"', () => {
    const graph = graphFrom(contradictoryWorld());
    expect(graph.statusAt(KAEL_ID, { ordinal: 2 })).toBe('alive');
    expect(graph.statusAt(KAEL_ID, { ordinal: 6 })).toBe('dead');
  });
});

describe('rv continuity check', () => {
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

  /**
   * The gate the whole of non-negotiable #7 rests on. Exit code 3 rather than 1: the
   * checker worked perfectly and the episode did not, and a CI job that retries on 1
   * must not retry a contradiction.
   */
  it('exits non-zero on the seeded contradiction', async () => {
    await seed(harness, contradictoryWorld());
    const code = await continuityCheckCommand.run(
      harness.context,
      parseArgs(['--episode', EPISODE_06]),
    );
    expect(code).toBe(EXIT.findings);
    expect(code).not.toBe(EXIT.ok);
  });

  it('names the rule and the scene rather than saying "invalid"', async () => {
    await seed(harness, contradictoryWorld());
    await continuityCheckCommand.run(
      harness.context,
      parseArgs(['--episode', EPISODE_06, '--json'], { booleans: ['json'] }),
    );
    const data = jsonOut(harness.io).data as {
      blocked: boolean;
      errors: { rule: string; sceneId: string | null }[];
    };
    expect(data.blocked).toBe(true);
    expect(data.errors.map((issue) => issue.rule)).toContain('dead-character-acting');
    expect(data.errors[0]?.sceneId).not.toBeNull();
  });

  it('exits 0 when the same episode has nothing to report', async () => {
    await seed(harness, cleanWorld());
    const code = await continuityCheckCommand.run(
      harness.context,
      parseArgs(['--episode', EPISODE_06]),
    );
    expect(code).toBe(EXIT.ok);
    expect(harness.io.outText).toContain('not blocked');
  });

  it('runs the free rule pass and calls no provider unless --semantic is given', async () => {
    // The harness has an empty environment: no Ollama host, no keys. A pass that reached
    // for a model would fail rather than report, so a clean exit is the assertion.
    await seed(harness, cleanWorld());
    expect(
      await continuityCheckCommand.run(harness.context, parseArgs(['--episode', EPISODE_06])),
    ).toBe(EXIT.ok);
  });

  it('exits 2 without --episode', async () => {
    await seed(harness, cleanWorld());
    expect(await continuityCheckCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });

  it('exits 1, naming the episodes it does know, for an episode with no scenes', async () => {
    await seed(harness, cleanWorld());
    const code = await continuityCheckCommand.run(
      harness.context,
      parseArgs(['--episode', 'E99', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    const envelope = jsonOut(harness.io);
    expect(envelope.code).toBe('NOT_FOUND');
  });

  it('exits 1 with a hint when the project has no world model at all', async () => {
    const code = await continuityCheckCommand.run(
      harness.context,
      parseArgs(['--episode', 'E01', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(jsonOut(harness.io).code).toBe('NOT_FOUND');
  });
});

describe('rv graph show', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await projectNewCommand.run(harness.context, parseArgs(['demo']));
    await seed(harness, contradictoryWorld());
    harness.io.stdout.length = 0;
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('answers for a viewer named by entity id', async () => {
    const code = await graphShowCommand.run(
      harness.context,
      parseArgs(['--character', KAEL_ID, '--ordinal', '6', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.ok);
    const data = jsonOut(harness.io).data as { viewerId: string; knows: unknown[] };
    expect(data.viewerId).toBe(KAEL_ID);
    expect(Array.isArray(data.knows)).toBe(true);
  });

  it('exits 1 for a character the graph has never heard of', async () => {
    const code = await graphShowCommand.run(
      harness.context,
      parseArgs(['--character', 'nobody', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(jsonOut(harness.io).code).toBe('NOT_FOUND');
  });

  it('exits 2 without --character', async () => {
    expect(await graphShowCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });
});
