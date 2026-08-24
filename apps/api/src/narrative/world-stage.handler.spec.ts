/**
 * S4 as the pipeline runs it: scenes in, a bi-temporal graph out, and nothing deleted.
 *
 * The two properties that make this package unusual are what is asserted here.
 *
 * **A fact that stops being true is bounded, not deleted.** After a scene retracts a
 * relation, the row is still in the table, still readable, and still true at an earlier
 * story time. A fold that deleted it would pass every test about "the fact is no longer
 * current" and destroy the ability to ask what a character believed in episode five.
 *
 * **An entity the extractor introduced does not get a sheet invented for it.** The edges
 * that touch it are held back and reported, because a `CharacterPayload` needs
 * psychology, voice, arc, visual and motion signature, and a model asked for all of that
 * while extracting continuity produces confident filler.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Entity, Ids, Relation, type SeriesId } from '@rv/contracts';
import { createDatabase, type DatabaseHandle } from '@rv/persistence';
import { FixedStageBackends } from '@rv/story-engine';
import { MemoryLogger, isErr } from '@rv/shared-kernel';

import {
  DEMO_CHARACTERS,
  DEMO_GOLAB_ID,
  DEMO_GOLNAR_ID,
} from '../infrastructure/seed/demo-characters';
import {
  FakeStructuredBackend,
  RecordingMeter,
  RefusingMeter,
  fakeRouter,
  scratchWorkspace,
  stageContext,
  testClock,
} from '../story/__fixtures__/story-fakes';
import { StoryStore, emptyStoryDocument } from '../story/story.store';
import { NarrativeGraphStore } from './graph.store';
import { WorldStageHandler, participantsOf, scenesFromOutline } from './world-stage.handler';

const SERIES = 'ser_0DEM0GR0VE0000000000000002' as SeriesId;
const EPISODE = 'ep_0DEM0GR0VE0000000000000030';
const SCENE = 'scn_0DEM0GR0VE00000000000031';
const relationId = (tail: string): string => `rel_0DEM0GR0VE${tail.padStart(16, '0')}`;

function entities(): readonly Entity[] {
  return DEMO_CHARACTERS.map((sheet) =>
    Entity.parse({
      id: sheet.id,
      seriesId: SERIES,
      kind: 'character',
      canonicalName: sheet.canonicalName,
      aliases: sheet.aliases,
      summary: sheet.summary,
      firstAppearance: sheet.firstAppearance,
      importance: sheet.importance,
      assetRefs: [],
      embedding: [],
      payload: sheet.payload,
    }),
  );
}

/** One standing edge for the scene below to end. */
function standingTrust(): Relation {
  return Relation.parse({
    id: relationId('40'),
    seriesId: SERIES,
    from: DEMO_GOLNAR_ID,
    to: DEMO_GOLAB_ID,
    type: 'trusts',
    fact: 'Golnar trusts Bibi Golab.',
    strength: 0.8,
    validFrom: { ordinal: 5 },
    validUntil: null,
    assertedAt: '2026-08-12T10:00:00.000Z',
    retractedAt: null,
    sourceRef: { kind: 'author' },
    confidence: 1,
    visibility: 'public',
  });
}

/**
 * A `SceneObservations` the extractor's schema accepts.
 *
 * The names are the canonical ones the graph already holds, so the mention resolver
 * resolves them rather than introducing new nodes.
 */
function observations(overrides: Record<string, unknown> = {}): unknown {
  return {
    entities: [],
    relations: [
      {
        subject: DEMO_CHARACTERS[1]?.canonicalName ?? '',
        object: DEMO_CHARACTERS[0]?.canonicalName ?? '',
        type: 'trusts',
        polarity: 'retracted',
        fact: 'Golnar stops trusting Bibi Golab the night she sees her lie about the well.',
        strength: 0.8,
        visibility: 'public',
        confidence: 1,
      },
    ],
    movements: [],
    possessions: [],
    knowledge: [],
    vitality: [],
    setups: [],
    ...overrides,
  };
}

describe('WorldStageHandler', () => {
  let workspace: ReturnType<typeof scratchWorkspace>;
  let handle: DatabaseHandle;
  let graph: NarrativeGraphStore;
  let story: StoryStore;

  beforeEach(async () => {
    workspace = scratchWorkspace();
    const opened = createDatabase(':memory:');
    if (isErr(opened)) throw opened.error;
    handle = opened.value;
    graph = new NarrativeGraphStore({ database: handle, logger: new MemoryLogger() });
    story = new StoryStore({ workspaceDir: workspace.dir, logger: new MemoryLogger() });

    const written = graph.write({ entities: entities(), relations: [standingTrust()] });
    if (isErr(written)) throw written.error;
    await story.save(emptyStoryDocument(SERIES));
  });

  afterEach(() => {
    handle.sqlite.close();
    workspace.cleanup();
  });

  function handler(
    backend: FakeStructuredBackend,
    meter: RecordingMeter | RefusingMeter = new RecordingMeter(),
  ): WorldStageHandler {
    return new WorldStageHandler({
      graph,
      story,
      backends: new FixedStageBackends([backend]),
      ids: new Ids(),
      meter,
      router: fakeRouter,
      clock: testClock(),
      logger: new MemoryLogger(),
    });
  }

  const scene = {
    sceneId: SCENE,
    episodeId: EPISODE,
    at: { ordinal: 50 },
    text: 'Golnar watches from the wall as Bibi Golab seals the well and says nothing.',
  };

  it('bounds a fact the scene ended, and keeps the row', async () => {
    const backend = new FakeStructuredBackend([observations()]);
    const { context } = stageContext({
      seriesId: SERIES,
      payload: { world: { scenes: [scene] } },
    });

    const outcome = await handler(backend).execute(context);

    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;
    expect(outcome.value.artifacts.some((a) => a.startsWith('bounded-facts:'))).toBe(true);

    const after = graph.load(SERIES);
    if (isErr(after)) return;
    const trust = after.value.relations.find((relation) => relation.id === relationId('40'));

    // Still there. This is the whole reason the store carries a story clock.
    expect(trust).toBeDefined();
    expect(trust?.validUntil?.ordinal).toBe(50);
    // Story time, not authoring time. A scene ending a fact is "it was true and now is
    // not"; retraction is "we were wrong to have written it" and no scene may perform one.
    expect(trust?.retractedAt).toBeNull();

    // And the earlier standpoint still answers.
    expect(after.value.index.query({ storyAt: { ordinal: 20 } }).map((r) => r.id)).toContain(
      relationId('40'),
    );
    expect(after.value.index.query({ storyAt: { ordinal: 60 } }).map((r) => r.id)).not.toContain(
      relationId('40'),
    );
  });

  it('holds back an edge that touches an entity nobody has written a sheet for', async () => {
    const backend = new FakeStructuredBackend([
      observations({
        entities: [
          {
            mention: 'the tin box',
            kind: 'prop',
            importance: 'supporting',
            summary: 'A rusted tin box with a birth certificate inside it.',
          },
        ],
        relations: [
          {
            subject: DEMO_CHARACTERS[1]?.canonicalName ?? '',
            object: 'the tin box',
            type: 'owns',
            polarity: 'asserted',
            fact: 'Golnar brings the tin box up from the bottom of the well.',
            strength: 1,
            visibility: 'public',
            confidence: 1,
          },
        ],
      }),
    ]);
    const { context } = stageContext({
      seriesId: SERIES,
      payload: { world: { scenes: [scene] } },
    });

    const outcome = await handler(backend).execute(context);

    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;
    // Reported, not persisted against a node nobody wrote - and not silently dropped
    // either, which is how "the extractor saw it and we lost it" stays distinguishable
    // from "the extractor never saw it".
    expect(outcome.value.artifacts).toContain('entities-awaiting-a-sheet:1');

    const after = graph.load(SERIES);
    if (isErr(after)) return;
    expect(after.value.entities.map((entity) => entity.kind)).not.toContain('prop');
  });

  it('refuses when there is nothing to fold, naming the level to expand first', async () => {
    const backend = new FakeStructuredBackend();
    const { context } = stageContext({ seriesId: SERIES, payload: {} });

    const outcome = await handler(backend).execute(context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({
      reason: 'world-without-scenes',
      owner: '@rv/story-engine',
    });
    expect(backend.requests).toHaveLength(0);
  });

  it('spends nothing when the guard refuses', async () => {
    const backend = new FakeStructuredBackend([observations()]);
    const { context } = stageContext({
      seriesId: SERIES,
      payload: { world: { scenes: [scene] } },
    });

    const outcome = await handler(backend, new RefusingMeter()).execute(context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('budget');
    expect(backend.requests).toHaveLength(0);
  });

  it('reports the graph state hash, so two folds of the same delta are comparable', async () => {
    const backend = new FakeStructuredBackend([observations()]);
    const { context } = stageContext({
      seriesId: SERIES,
      payload: { world: { scenes: [scene] } },
    });

    const outcome = await handler(backend).execute(context);

    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;
    expect(outcome.value.artifacts.some((a) => a.startsWith('graph-state:'))).toBe(true);
  });
});

describe('reading scenes off the outline', () => {
  const node = (
    id: string,
    parentId: string | null,
    level: string,
    ordinal: number,
    title: string,
  ): {
    id: string;
    parentId: string | null;
    level: string;
    ordinal: number;
    title: string;
    summary: string;
  } => ({
    id,
    parentId,
    level,
    ordinal,
    title,
    summary: `What happens in ${title}.`,
  });

  it('walks the tree in playing order and spaces the ordinals', () => {
    const scenes = scenesFromOutline([
      node('s', null, 'series', 1, 'Series'),
      node('se', 's', 'season', 1, 'Season'),
      node('e1', 'se', 'episode', 1, 'Episode one'),
      node('e2', 'se', 'episode', 2, 'Episode two'),
      // Out of array order on purpose: the walk sorts by ordinal, not by insertion.
      node('sc2', 'e1', 'scene', 2, 'The wall'),
      node('sc1', 'e1', 'scene', 1, 'The gate'),
      node('sc3', 'e2', 'scene', 1, 'The rope'),
    ]);

    expect(scenes.map((s) => s.sceneId)).toEqual(['sc1', 'sc2', 'sc3']);
    expect(scenes.map((s) => s.episodeId)).toEqual(['e1', 'e1', 'e2']);
    // Spaced by ten so a scene inserted later has somewhere to go without renumbering
    // everything after it.
    expect(scenes.map((s) => s.at.ordinal)).toEqual([10, 20, 30]);
  });

  it('skips a scene with no episode above it, because no report could be run for it', () => {
    const scenes = scenesFromOutline([node('orphan', null, 'scene', 1, 'Nowhere')]);

    expect(scenes).toEqual([]);
  });
});

describe('participantsOf', () => {
  it('dedupes both ends of every edge', () => {
    const trust = standingTrust();
    expect(participantsOf([trust, trust])).toEqual([DEMO_GOLNAR_ID, DEMO_GOLAB_ID]);
  });
});
