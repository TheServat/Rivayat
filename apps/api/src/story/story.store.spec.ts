/**
 * The two stopgap stores, held to the rule that makes them safe to be stopgaps.
 *
 * **A document that no longer parses fails loudly rather than reaching a use-case as
 * half a document.** That is the whole reason the read path goes through the schema, and
 * it is the difference between "the outline is gone" and "the outliner produced a tree
 * with no summaries and nobody noticed for a week".
 *
 * The one exception is `all()`, which is the lookup behind `PATCH /api/story/nodes/:id`.
 * There, one unreadable series must not make every other series' nodes unaddressable, so
 * a bad document is reported and skipped.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntityId, SeriesId } from '@rv/contracts';
import { MemoryLogger, ValidationError, err, isErr, ok } from '@rv/shared-kernel';

import { scratchWorkspace } from './__fixtures__/story-fakes';
import { CharacterStateStore, emptyStates } from './cast.store';
import {
  STORY_DOCUMENT_VERSION,
  StoryStore,
  emptyStoryDocument,
  styleBibleIdOf,
} from './story.store';

const SERIES = 'ser_01JQZK3M7X8YB4N2VTC6WPHRDF' as SeriesId;
const OTHER = 'ser_01JQZK3M7X8YB4N2VTC6WPHRDG' as SeriesId;
const ENTITY = 'ent_01JQZK3M7X8YB4N2VTC6WPHRDH' as EntityId;

describe('StoryStore', () => {
  let workspace: ReturnType<typeof scratchWorkspace>;
  let store: StoryStore;

  beforeEach(() => {
    workspace = scratchWorkspace();
    store = new StoryStore({ workspaceDir: workspace.dir, logger: new MemoryLogger() });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('answers an empty document for a series nobody has outlined', async () => {
    const loaded = await store.load(SERIES);

    expect(isErr(loaded)).toBe(false);
    if (isErr(loaded)) return;
    expect(loaded.value).toEqual(emptyStoryDocument(SERIES));
    expect(styleBibleIdOf(loaded.value)).toBeNull();
  });

  it('round-trips a document through the schema', async () => {
    const saved = await store.save({
      ...emptyStoryDocument(SERIES),
      styleBibleId: 'sty_01JQZK3M7X8YB4N2VTC6WPHRDC',
    });
    expect(isErr(saved)).toBe(false);

    const loaded = await store.load(SERIES);
    if (isErr(loaded)) return;
    expect(styleBibleIdOf(loaded.value)).toBe('sty_01JQZK3M7X8YB4N2VTC6WPHRDC');
  });

  it('fails loudly on a file that is not JSON', async () => {
    mkdirSync(join(workspace.dir, 'story'), { recursive: true });
    writeFileSync(join(workspace.dir, 'story', `${SERIES}.json`), 'not json at all', 'utf8');

    const loaded = await store.load(SERIES);

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('validation');
  });

  it('fails loudly on a document written by an older build', async () => {
    mkdirSync(join(workspace.dir, 'story'), { recursive: true });
    writeFileSync(
      join(workspace.dir, 'story', `${SERIES}.json`),
      JSON.stringify({ version: STORY_DOCUMENT_VERSION, seriesId: SERIES, nodes: 'not an array' }),
      'utf8',
    );

    const loaded = await store.load(SERIES);

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    // The path, not just the message: "expected array" with no field name costs an hour
    // of reading stored JSON to act on.
    expect(loaded.error.context.issues).toContain('nodes');
  });

  it('skips an unreadable series when scanning for a node, and keeps the rest', async () => {
    await store.save(emptyStoryDocument(SERIES));
    mkdirSync(join(workspace.dir, 'story'), { recursive: true });
    writeFileSync(join(workspace.dir, 'story', `${OTHER}.json`), '{', 'utf8');
    // Neither of these is a series document and neither may derail the scan.
    writeFileSync(join(workspace.dir, 'story', 'notes.txt'), 'hello', 'utf8');
    writeFileSync(join(workspace.dir, 'story', 'not-a-series-id.json'), '{}', 'utf8');

    const all = await store.all();

    expect(isErr(all)).toBe(false);
    if (isErr(all)) return;
    expect(all.value.map((document) => document.seriesId)).toEqual([SERIES]);
  });

  it('answers an empty list before anything has ever been written', async () => {
    const all = await store.all();

    expect(isErr(all)).toBe(false);
    if (isErr(all)) return;
    expect(all.value).toEqual([]);
  });

  it('does not write when the change refuses', async () => {
    await store.save({ ...emptyStoryDocument(SERIES), styleBibleId: 'sty_original' });

    const mutated = await store.mutate(SERIES, () =>
      err(new ValidationError({ message: 'the change refused' })),
    );

    expect(isErr(mutated)).toBe(true);
    const loaded = await store.load(SERIES);
    if (isErr(loaded)) return;
    expect(loaded.value.styleBibleId).toBe('sty_original');
  });

  it('propagates a read failure out of a mutation rather than overwriting the file', async () => {
    mkdirSync(join(workspace.dir, 'story'), { recursive: true });
    writeFileSync(join(workspace.dir, 'story', `${SERIES}.json`), '{', 'utf8');

    const mutated = await store.mutate(SERIES, (document) => ok(document));

    expect(isErr(mutated)).toBe(true);
  });

  it('answers a tree for a series whose document is unreadable, as a failure', async () => {
    mkdirSync(join(workspace.dir, 'story'), { recursive: true });
    writeFileSync(join(workspace.dir, 'story', `${SERIES}.json`), '{', 'utf8');

    const tree = await store.tree(SERIES);

    expect(isErr(tree)).toBe(true);
  });
});

describe('CharacterStateStore', () => {
  let workspace: ReturnType<typeof scratchWorkspace>;
  let store: CharacterStateStore;

  beforeEach(() => {
    workspace = scratchWorkspace();
    store = new CharacterStateStore({ workspaceDir: workspace.dir, logger: new MemoryLogger() });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  const cell = {
    semanticKey: 'char/golab/expression',
    variantKey: 'everyday-cornered',
    wardrobeSlug: 'everyday',
    stateSlug: 'cornered',
    stateKind: 'expression' as const,
    label: 'everyday / cornered',
    prompt: 'The exact text an image model receives, composed by the engine.',
    intensity: 0.7,
    status: 'missing' as const,
    estimateNanoUsd: 0,
  };

  it('answers an empty grid for a character S3 has not reached', async () => {
    const loaded = await store.load(SERIES, ENTITY);

    expect(isErr(loaded)).toBe(false);
    if (isErr(loaded)) return;
    expect(loaded.value).toEqual(emptyStates());
  });

  it('replaces one cell and answers with the cell rather than the grid', async () => {
    await store.save(SERIES, ENTITY, { identityFloor: 0.82, imageModel: null, cells: [cell] });

    const replaced = await store.replaceCell(SERIES, ENTITY, 'everyday-cornered', (current) => ({
      ...current,
      prompt: 'An art director’s correction, typed in place.',
      status: 'stale',
    }));

    expect(isErr(replaced)).toBe(false);
    if (isErr(replaced)) return;
    // An edited prompt is a different spec hash, so exactly this cell is a cache miss.
    expect(replaced.value.status).toBe('stale');

    const reread = await store.load(SERIES, ENTITY);
    if (isErr(reread)) return;
    expect(reread.value.cells[0]?.prompt).toContain('correction');
  });

  it('404s a cell nobody generated a demand for', async () => {
    await store.save(SERIES, ENTITY, { identityFloor: 0.82, imageModel: null, cells: [cell] });

    const missing = await store.replaceCell(SERIES, ENTITY, 'nope', (current) => current);

    expect(isErr(missing)).toBe(true);
    if (!isErr(missing)) return;
    expect(missing.error.kind).toBe('not-found');
  });

  it('fails loudly on a grid that is not JSON, and on one that no longer fits', async () => {
    mkdirSync(join(workspace.dir, 'cast', SERIES), { recursive: true });
    writeFileSync(join(workspace.dir, 'cast', SERIES, `${ENTITY}.json`), '{', 'utf8');
    expect(isErr(await store.load(SERIES, ENTITY))).toBe(true);

    writeFileSync(
      join(workspace.dir, 'cast', SERIES, `${ENTITY}.json`),
      JSON.stringify({ identityFloor: 3, cells: [] }),
      'utf8',
    );
    const drifted = await store.load(SERIES, ENTITY);
    expect(isErr(drifted)).toBe(true);
    if (!isErr(drifted)) return;
    expect(drifted.error.context.issues).toContain('identityFloor');
  });

  it('propagates a read failure out of a cell replacement', async () => {
    mkdirSync(join(workspace.dir, 'cast', SERIES), { recursive: true });
    writeFileSync(join(workspace.dir, 'cast', SERIES, `${ENTITY}.json`), '{', 'utf8');

    expect(isErr(await store.replaceCell(SERIES, ENTITY, 'x', (c) => c))).toBe(true);
  });
});
