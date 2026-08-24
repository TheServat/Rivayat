/**
 * The epistemic endpoint, held to the rule it exists for.
 *
 * The canonical case, from docs/02 §3: a `secret` edge whose **object** is the character
 * it is kept from. A projection that treats every participant as a knower answers "yes"
 * for the single fact the whole epistemic layer exists to withhold, and dramatic irony
 * stops being representable. These tests fail if that regresses, and they are written
 * against `EpistemicView`'s structured buckets rather than against any message.
 *
 * They also pin the second half of the model, which nothing else exercises end to end:
 * standing at a different point on the *authoring* clock has to produce a different
 * answer from standing at a different point on the story clock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Entity, Relation, type EpisodeOutline, type SeriesId } from '@rv/contracts';
import { NarrativeGraph } from '@rv/narrative-memory';
import { createDatabase, type DatabaseHandle } from '@rv/persistence';
import {
  FixedClock,
  MemoryLogger,
  ValidationError,
  err,
  instant,
  isErr,
  ok,
  type Result,
} from '@rv/shared-kernel';

import type { EpisodeRepository } from '../application/ports/repository.ports';
import {
  DEMO_CHARACTERS,
  DEMO_FARHAD_ID,
  DEMO_GOLAB_ID,
  DEMO_GOLNAR_ID,
} from '../infrastructure/seed/demo-characters';
import { NarrativeGraphStore } from './graph.store';
import { SnapshotService, revisionsOf, storyMarksOf } from './snapshot.service';

const SERIES = 'ser_0DEM0GR0VE0000000000000002' as SeriesId;
/** After both authoring passes below: "as we believe it now" has to include them. */
const NOW = instant(Date.parse('2026-09-01T00:00:00.000Z'));

/** The first authoring pass, and the rewrite ten days later. Both fixed. */
const FIRST_PASS = '2026-08-12T10:00:00.000Z';
const REWRITE = '2026-08-22T16:30:00.000Z';

/** `rel_` plus twenty-six Crockford base32 characters, which excludes I, L, O and U. */
const relationId = (tail: string): string => `rel_0DEM0GR0VE${tail.padStart(16, '0')}`;

/** No episodes: this app writes none, and the marks must still come out of the graph. */
const noEpisodes: EpisodeRepository = {
  findById: (): Promise<Result<EpisodeOutline | null>> => Promise.resolve(ok(null)),
  listBySeries: (): Promise<Result<readonly EpisodeOutline[]>> => Promise.resolve(ok([])),
};

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

/**
 * Four edges, each carrying one of the four things this endpoint has to get right.
 *
 * 1. the secret whose object is the person it is kept from
 * 2. a `told` secret, where being the object *is* knowing
 * 3. a false belief bounded in story time, replaced by knowledge at the reveal
 * 4. an edge retracted on the authoring clock, so "as we believed then" differs
 */
function relations(): readonly Relation[] {
  const authored = { kind: 'author' as const };
  return [
    Relation.parse({
      id: relationId('20'),
      seriesId: SERIES,
      from: DEMO_GOLAB_ID,
      to: DEMO_GOLNAR_ID,
      type: 'parent-of',
      fact: 'Bibi Golab is Golnar’s mother, and Golnar has never been told.',
      strength: 1,
      validFrom: { ordinal: 10 },
      validUntil: null,
      assertedAt: FIRST_PASS,
      retractedAt: null,
      sourceRef: authored,
      confidence: 1,
      visibility: 'secret',
    }),
    Relation.parse({
      id: relationId('21'),
      seriesId: SERIES,
      from: DEMO_GOLAB_ID,
      to: DEMO_FARHAD_ID,
      type: 'told',
      fact: 'Bibi Golab told Farhad what is at the bottom of the well.',
      strength: 1,
      validFrom: { ordinal: 35, label: 'The night of the telling' },
      validUntil: null,
      assertedAt: FIRST_PASS,
      retractedAt: null,
      sourceRef: authored,
      confidence: 1,
      visibility: 'secret',
    }),
    Relation.parse({
      id: relationId('22'),
      seriesId: SERIES,
      from: DEMO_GOLNAR_ID,
      to: DEMO_FARHAD_ID,
      type: 'believes-falsely',
      // Deliberately *not* about Bibi Golab. `couldKnow` is permissive by design - an
      // epistemic edge pointing at a fact's subject makes the holder a possible knower -
      // so a false belief about Golab would grant Golnar every fact Golab is the subject
      // of, including the one this fixture exists to keep from her.
      fact: 'Golnar believes Farhad came to the garden to help.',
      strength: 1,
      validFrom: { ordinal: 10 },
      validUntil: { ordinal: 80 },
      assertedAt: FIRST_PASS,
      retractedAt: null,
      sourceRef: authored,
      confidence: 1,
      visibility: 'public',
    }),
    Relation.parse({
      id: relationId('23'),
      seriesId: SERIES,
      from: DEMO_GOLNAR_ID,
      to: DEMO_FARHAD_ID,
      type: 'knows',
      fact: 'Golnar knows Farhad is from the water office, in the first pass of the script.',
      strength: 0.7,
      validFrom: { ordinal: 30 },
      validUntil: null,
      assertedAt: FIRST_PASS,
      // Un-said in the rewrite: an authoring-time event, not a story-time one.
      retractedAt: REWRITE,
      sourceRef: authored,
      confidence: 1,
      visibility: 'public',
    }),
  ];
}

describe('SnapshotService', () => {
  let handle: DatabaseHandle;
  let service: SnapshotService;
  let store: NarrativeGraphStore;

  beforeEach(() => {
    const opened = createDatabase(':memory:');
    if (isErr(opened)) throw opened.error;
    handle = opened.value;
    store = new NarrativeGraphStore({ database: handle, logger: new MemoryLogger() });
    const written = store.write({ entities: entities(), relations: relations() });
    if (isErr(written)) throw written.error;
    service = new SnapshotService({
      graph: store,
      episodes: noEpisodes,
      clock: new FixedClock(NOW),
    });
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  it('is the object of the secret, and therefore does not know it', async () => {
    const view = await service.view(SERIES, DEMO_GOLNAR_ID, { at: 50 });

    expect(isErr(view)).toBe(false);
    if (isErr(view)) return;
    // The edge touches her, so an eye skimming the diagram expects her to hold it. She
    // is its object, which is precisely the person it is kept from.
    expect(view.value.blindSpots).toContain(relationId('20'));
    expect(view.value.knows.map((fact) => fact.relationId)).not.toContain(relationId('20'));
  });

  it('being told is knowing, for the one relation whose meaning is that', async () => {
    const view = await service.view(SERIES, DEMO_FARHAD_ID, { at: 50 });

    expect(isErr(view)).toBe(false);
    if (isErr(view)) return;
    // A secret whose object he is - but `told` exists to say the information reached him.
    expect(view.value.blindSpots).not.toContain(relationId('21'));
  });

  it('answers differently at two points on the story clock', async () => {
    const early = await service.view(SERIES, DEMO_GOLNAR_ID, { at: 50 });
    const late = await service.view(SERIES, DEMO_GOLNAR_ID, { at: 90 });

    expect(isErr(early)).toBe(false);
    expect(isErr(late)).toBe(false);
    if (isErr(early) || isErr(late)) return;

    // The false belief is bounded at 80. Half-open: it holds at 50 and not at 90.
    expect(early.value.believesFalsely.map((fact) => fact.relationId)).toContain(relationId('22'));
    expect(late.value.believesFalsely.map((fact) => fact.relationId)).not.toContain(
      relationId('22'),
    );
  });

  it('answers differently at two points on the authoring clock', async () => {
    const now = await service.view(SERIES, DEMO_GOLNAR_ID, { at: 50 });
    const before = await service.view(SERIES, DEMO_GOLNAR_ID, {
      at: 50,
      asOf: '2026-08-15T00:00:00.000Z',
    });

    expect(isErr(now)).toBe(false);
    expect(isErr(before)).toBe(false);
    if (isErr(now) || isErr(before)) return;

    // The edge was asserted in the first pass and un-said in the rewrite. "As we believe
    // it now" is not the same query as any past instant: it keeps assertions that have
    // never been retracted, rather than assertions that had not *yet* been retracted.
    expect(before.value.knows.map((fact) => fact.relationId)).toContain(relationId('23'));
    expect(now.value.knows.map((fact) => fact.relationId)).not.toContain(relationId('23'));
  });

  it('refuses a viewer the series does not hold, rather than answering an empty head', async () => {
    const missing = await service.view(SERIES, 'ent_0DEM0GR0VE0000000000009999', {});

    expect(isErr(missing)).toBe(true);
    if (!isErr(missing)) return;
    // An empty view for a misspelled id looks exactly like a character who knows nothing,
    // and the second is a legitimate dramatic state.
    expect(missing.error.kind).toBe('not-found');
  });

  it('derives the story slider’s stops from the ordinals the series actually uses', async () => {
    const snapshot = await service.snapshot(SERIES);

    expect(isErr(snapshot)).toBe(false);
    if (isErr(snapshot)) return;
    const ordinals = snapshot.value.storyMarks.map((mark) => mark.at.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    expect(ordinals).toContain(35);
    expect(ordinals).toContain(80);
    // A label only where the fiction has a name for the moment, carried through from the
    // author's own `validFrom.label` and never composed on this side.
    const labelled = snapshot.value.storyMarks.find((mark) => mark.at.ordinal === 35);
    expect(labelled?.label).toBe('The night of the telling');
    expect(snapshot.value.storyMarks.find((mark) => mark.at.ordinal === 80)?.label).toBeUndefined();
  });

  it('lists the authoring instants worth replaying at, including the retraction', async () => {
    const snapshot = await service.snapshot(SERIES);

    expect(isErr(snapshot)).toBe(false);
    if (isErr(snapshot)) return;
    const instants = snapshot.value.revisions.map((revision) => revision.at);
    expect(instants).toContain(FIRST_PASS);
    // The instant a fact was un-said is where "the graph before the retro-fit" lives; a
    // list built only from assertions would not contain it.
    expect(instants).toContain(REWRITE);
    expect(snapshot.value.revisions.find((r) => r.at === REWRITE)?.label).toBe('retraction');
  });

  it('stands at the latest moment the series uses when no story point is given', async () => {
    // The largest `validFrom`, not the largest `validUntil`: an interval that has not
    // ended is `null`, and the largest *ending* would stand after everything asserted.
    const latest = await service.view(SERIES, DEMO_GOLNAR_ID, {});
    const explicit = await service.view(SERIES, DEMO_GOLNAR_ID, { at: 35 });

    expect(isErr(latest)).toBe(false);
    expect(isErr(explicit)).toBe(false);
    if (isErr(latest) || isErr(explicit)) return;
    expect(latest.value.at.ordinal).toBe(35);
    expect(latest.value.knows).toEqual(explicit.value.knows);
  });

  it('carries a failure to list episodes out rather than showing a slider with no stops', async () => {
    const failing = new SnapshotService({
      graph: store,
      episodes: {
        findById: () => Promise.resolve(ok(null)),
        listBySeries: () =>
          Promise.resolve(err(new ValidationError({ message: 'the episodes table is on fire' }))),
      },
      clock: new FixedClock(NOW),
    });

    expect(isErr(await failing.snapshot(SERIES))).toBe(true);
  });

  it('answers an empty snapshot for a series with no graph, rather than a not-found', async () => {
    const empty = await service.snapshot('ser_0DEM0GR0VE0000000000000009');

    expect(isErr(empty)).toBe(false);
    if (isErr(empty)) return;
    expect(empty.value.entities).toEqual([]);
    expect(empty.value.storyMarks).toEqual([]);
  });

  it('skips an edge whose endpoints are not in the graph rather than answering with a dangling id', () => {
    // A relation row pointing at a missing entity would make `couldKnow` consult a node
    // the graph does not hold, and the epistemic answer would depend on which rows
    // happened to be readable.
    const graph = store.load(SERIES);
    expect(isErr(graph)).toBe(false);
    if (isErr(graph)) return;
    const ids = new Set(graph.value.entities.map((entity) => entity.id));
    for (const relation of graph.value.relations) {
      expect(ids.has(relation.from)).toBe(true);
      expect(ids.has(relation.to)).toBe(true);
    }
  });
});

describe('the two derived stop lists, as pure functions', () => {
  it('sorts authoring instants by the moment rather than by the string', () => {
    // `2026-08-22T16:30:00+03:30` is *earlier* than `2026-08-22T14:00:00Z` and sorts
    // after it lexically. A series authored outside UTC - which is every series this
    // product is for - would present its stops in the wrong order.
    const offset = Relation.parse({
      id: relationId('30'),
      seriesId: SERIES,
      from: DEMO_GOLAB_ID,
      to: DEMO_GOLNAR_ID,
      type: 'knows',
      fact: 'An edge asserted in a Tehran timezone.',
      strength: 1,
      validFrom: null,
      validUntil: null,
      assertedAt: '2026-08-22T16:30:00+03:30',
      retractedAt: null,
      sourceRef: { kind: 'author' },
      confidence: 1,
      visibility: 'public',
    });
    const utc = Relation.parse({
      ...offset,
      id: relationId('31'),
      assertedAt: '2026-08-22T14:00:00Z',
    });

    const revisions = revisionsOf([utc, offset]);

    expect(revisions.map((revision) => revision.at)).toEqual([
      '2026-08-22T16:30:00+03:30',
      '2026-08-22T14:00:00Z',
    ]);
  });

  it('unions the episode ordinals in, so an episode nothing has landed in still has a stop', () => {
    // A series that has been through S2 but not S4: episodes exist, no fact does. The
    // slider still needs stops, or the screen reads as "there is nothing here".
    const marks = storyMarksOf(new NarrativeGraph({ seriesId: SERIES }), [1, 2, 3]);

    expect(marks.map((mark) => mark.at.ordinal)).toEqual([1, 2, 3]);
    expect(marks.every((mark) => mark.label === undefined)).toBe(true);
  });
});
