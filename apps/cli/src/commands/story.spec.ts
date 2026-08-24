import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StyleBible } from '@rv/contracts';
import { lock } from '@rv/core-domain';
import { toIso } from '@rv/shared-kernel';
import { findPreset, materialiseStyleBible } from '@rv/style-engine';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import { DOCUMENT_VERSION, StoryDocument } from '../store/documents';
import { writeJson } from '../store/json-file';
import { listProjects, type LoadedProject } from '../store/project';
import { projectNewCommand } from './project';
import { episodeCode, findEpisode, loadStory, seasonCode, storyNewCommand } from './story';

async function onlyProject(harness: Harness): Promise<LoadedProject> {
  const all = await listProjects(harness.workspaceRoot);
  if (!all.ok || all.value[0] === undefined) throw new Error('no project');
  return all.value[0];
}

async function writeStyle(
  harness: Harness,
  project: LoadedProject,
  options: { readonly locked: boolean },
): Promise<string> {
  const preset = findPreset('ink-comic');
  if (!preset.ok) throw preset.error;
  const bible = materialiseStyleBible({
    draft: preset.value.draft,
    id: harness.context.ids.styleBible(),
    clock: harness.clock,
  });
  const final = options.locked
    ? lock(bible, toIso(harness.clock.now()))
    : { ok: true as const, value: bible };
  if (!final.ok) throw final.error;
  const written = await writeJson(project.paths.style, StyleBible, final.value);
  if (!written.ok) throw written.error;
  return final.value.id;
}

describe('episode handles', () => {
  it('formats an ordinal as the code the docs and the demos use', () => {
    expect(episodeCode(1)).toBe('E01');
    expect(episodeCode(12)).toBe('E12');
    expect(seasonCode(1)).toBe('S01');
  });
});

describe('findEpisode', () => {
  const story = StoryDocument.parse({
    version: DOCUMENT_VERSION,
    projectId: 'prj_01J8ZQ4E7K9M2N4P6R8T0V0001',
    seriesId: 'ser_01J8ZQ4E7K9M2N4P6R8T0V0001',
    styleBibleId: 'sty_01J8ZQ4E7K9M2N4P6R8T0V0001',
    title: 'Test',
    premise: 'A premise long enough to be prose.',
    canonPolicy: { freezeOnAir: true, retcon: 'reveal-only', strictness: 'strict' },
    language: 'en',
    episodeDurationMs: 180_000,
    episodes: [
      {
        id: 'ep_01J8ZQ4E7K9M2N4P6R8T0V0001',
        ordinal: 1,
        code: 'E01',
        title: 'One',
        plannedSummary: 'What episode one must accomplish.',
        summary: 'What happens in episode one.',
      },
    ],
    createdAt: '2026-08-23T18:00:00.000Z',
  });

  it('resolves the human code a person types', () => {
    expect(findEpisode(story, 'E01')?.ordinal).toBe(1);
    expect(findEpisode(story, 'e01')?.ordinal).toBe(1);
  });

  it('resolves the stored id', () => {
    expect(findEpisode(story, 'ep_01J8ZQ4E7K9M2N4P6R8T0V0001')?.code).toBe('E01');
  });

  it('returns undefined rather than the nearest match', () => {
    expect(findEpisode(story, 'E99')).toBeUndefined();
  });
});

describe('rv story new', () => {
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

  it('exits 2 without an idea', async () => {
    expect(await storyNewCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });

  it('exits 2 on a lane that is not free or paid', async () => {
    const code = await storyNewCommand.run(
      harness.context,
      parseArgs(['--idea', 'a fox', '--lane', 'cheap']),
    );
    expect(code).toBe(EXIT.usage);
  });

  /**
   * A story records `styleBibleId`, and every asset the story implies is keyed on that
   * bible's checksum. Writing one against a style that can still change would produce
   * asset keys nothing could ever find again.
   */
  it('refuses to write a story before a style is locked', async () => {
    const code = await storyNewCommand.run(
      harness.context,
      parseArgs(['--idea', 'a fox who stole the city', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(JSON.stringify(jsonOut(harness.io))).toContain('style probe');
  });

  it('refuses an unlocked style bible even when one is present', async () => {
    const project = await onlyProject(harness);
    await writeStyle(harness, project, { locked: false });
    const code = await storyNewCommand.run(
      harness.context,
      parseArgs(['--idea', 'a fox who stole the city', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(JSON.stringify(jsonOut(harness.io))).toContain('not locked');
  });

  it('refuses a --style that is not the one the project locked', async () => {
    const project = await onlyProject(harness);
    await writeStyle(harness, project, { locked: true });
    const code = await storyNewCommand.run(
      harness.context,
      parseArgs(['--idea', 'a fox', '--style', 'sty_01J8ZQ4E7K9M2N4P6R8T0V0009', '--json'], {
        booleans: ['json'],
      }),
    );
    expect(code).toBe(EXIT.failed);
    expect(JSON.stringify(jsonOut(harness.io))).toContain("project's locked style");
  });

  /**
   * The harness environment has no keys, so a Gemini pin must be refused *before* any
   * prompt is composed rather than surfacing as a 401 from inside an adapter.
   */
  it('refuses a model binding this machine cannot serve, before spending anything', async () => {
    const project = await onlyProject(harness);
    await writeStyle(harness, project, { locked: true });
    const code = await storyNewCommand.run(
      harness.context,
      parseArgs(['--idea', 'a fox', '--model', 'gemini:gemini-3-flash', '--json'], {
        booleans: ['json'],
      }),
    );
    expect(code).toBe(EXIT.failed);
    expect(JSON.stringify(jsonOut(harness.io))).toContain('No backend is available');
  });

  it('refuses the paid lane without --yes, before any model is called', async () => {
    const project = await onlyProject(harness);
    await writeStyle(harness, project, { locked: true });
    const code = await storyNewCommand.run(
      harness.context,
      parseArgs(['--idea', 'a fox', '--lane', 'paid']),
    );
    expect(code).toBe(EXIT.spendRefused);
  });
});

describe('loadStory', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await projectNewCommand.run(harness.context, parseArgs(['demo']));
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('reports a missing story with the command that writes one', async () => {
    const project = await onlyProject(harness);
    const story = await loadStory(project.paths.story);
    expect(story.ok).toBe(false);
    if (!story.ok) expect(JSON.stringify(story.error.context)).toContain('rv story new');
  });
});
