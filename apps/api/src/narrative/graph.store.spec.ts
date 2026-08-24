/**
 * The joint between two tables and a pure engine.
 *
 * Three properties, each of which has a failure mode that is silent if it regresses:
 * both clocks survive the round trip through flattened columns; a row that no longer
 * parses is skipped and reported rather than reaching the epistemic projection as half
 * an entity; and an edge whose endpoints are missing is dropped, because `couldKnow`
 * consulting a node the graph does not hold makes the answer depend on which rows
 * happened to be readable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Entity, Relation, type SeriesId } from '@rv/contracts';
import { entities as entityTable, createDatabase, type DatabaseHandle } from '@rv/persistence';
import { MemoryLogger, isErr } from '@rv/shared-kernel';

import {
  DEMO_CHARACTERS,
  DEMO_GOLAB_ID,
  DEMO_GOLNAR_ID,
} from '../infrastructure/seed/demo-characters';
import { NarrativeGraphStore } from './graph.store';

const SERIES = 'ser_0DEM0GR0VE0000000000000002' as SeriesId;
const relationId = (tail: string): string => `rel_0DEM0GR0VE${tail.padStart(16, '0')}`;

function entities(): readonly Entity[] {
  return DEMO_CHARACTERS.slice(0, 2).map((sheet) =>
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

const BOUNDED = Relation.parse({
  id: relationId('50'),
  seriesId: SERIES,
  from: DEMO_GOLNAR_ID,
  to: DEMO_GOLAB_ID,
  type: 'trusts',
  fact: 'Golnar trusts Bibi Golab, for a while.',
  strength: 0.8,
  validFrom: { ordinal: 20, label: 'Episode two' },
  validUntil: { ordinal: 45, label: 'The night of the confession' },
  assertedAt: '2026-08-12T10:00:00.000Z',
  retractedAt: null,
  sourceRef: { kind: 'author' },
  confidence: 1,
  visibility: 'public',
});

describe('NarrativeGraphStore', () => {
  let handle: DatabaseHandle;
  let store: NarrativeGraphStore;
  let logger: MemoryLogger;

  beforeEach(() => {
    const opened = createDatabase(':memory:');
    if (isErr(opened)) throw opened.error;
    handle = opened.value;
    logger = new MemoryLogger();
    store = new NarrativeGraphStore({ database: handle, logger });
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  it('round-trips both clocks, labels included', () => {
    const written = store.write({ entities: entities(), relations: [BOUNDED] });
    expect(isErr(written)).toBe(false);

    const loaded = store.load(SERIES);
    expect(isErr(loaded)).toBe(false);
    if (isErr(loaded)) return;

    const edge = loaded.value.relations[0];
    // The ordinal is a column and the label rides alongside it; both have to come back,
    // and an interval end that is `null` has to stay `null` rather than becoming 0.
    expect(edge?.validFrom).toEqual({ ordinal: 20, label: 'Episode two' });
    expect(edge?.validUntil).toEqual({ ordinal: 45, label: 'The night of the confession' });
    expect(edge?.retractedAt).toBeNull();
  });

  it('answers an empty graph for a series with no rows', () => {
    const loaded = store.load(SERIES);

    expect(isErr(loaded)).toBe(false);
    if (isErr(loaded)) return;
    expect(loaded.value.entities).toEqual([]);
    expect(loaded.value.relations).toEqual([]);
  });

  it('is idempotent: writing the same graph twice changes nothing', () => {
    store.write({ entities: entities(), relations: [BOUNDED] });
    const second = store.write({ entities: entities(), relations: [BOUNDED] });

    expect(isErr(second)).toBe(false);
    if (isErr(second)) return;
    // `onConflictDoNothing`, not an upsert: an upsert would let a re-run silently rewrite
    // the story clock of an edge somebody has already built a scene on.
    expect(second.value).toBe(0);
  });

  it('skips a row that no longer satisfies its schema, and says so', () => {
    store.write({ entities: entities(), relations: [] });
    // A payload from an older build. Rewritten under the row rather than inserted, so
    // the rest of the series is unaffected.
    handle.db
      .update(entityTable)
      .set({ payload: { nothing: 'that a CharacterPayload would accept' } })
      .run();

    const loaded = store.load(SERIES);

    expect(isErr(loaded)).toBe(false);
    if (isErr(loaded)) return;
    expect(loaded.value.entities).toEqual([]);
    expect(logger.records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('bounds an edge in place, and never writes a retraction while doing it', () => {
    const unbounded = Relation.parse({ ...BOUNDED, validUntil: null });
    store.write({ entities: entities(), relations: [unbounded] });

    const bounded = store.bound([Relation.parse({ ...unbounded, validUntil: { ordinal: 60 } })]);

    expect(isErr(bounded)).toBe(false);
    const loaded = store.load(SERIES);
    if (isErr(loaded)) return;
    const edge = loaded.value.relations[0];
    // The row survives; only its story-time end moves. A scene ending a fact is "it was
    // true and now is not"; retraction is "we were wrong to have written it".
    expect(edge?.validUntil?.ordinal).toBe(60);
    expect(edge?.retractedAt).toBeNull();
  });

  it('lists the entity ids a caller is about to add to', () => {
    store.write({ entities: entities(), relations: [] });

    const ids = store.entityIds(SERIES);

    expect(isErr(ids)).toBe(false);
    if (isErr(ids)) return;
    expect([...ids.value].sort()).toEqual([DEMO_GOLAB_ID, DEMO_GOLNAR_ID].sort());
  });
});
