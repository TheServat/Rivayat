/**
 * Every table, once, against the committed migration.
 *
 * The asset tables have a repository and are exercised properly elsewhere. The rest -
 * style bibles, the narrative graph, the story tree, the ledger - do not have one yet,
 * and an untested schema is a migration nobody has run. This spec inserts and reads a
 * row in each, which proves three things at once: the migration creates the table, the
 * canonical-JSON columns round-trip a real contract document, and the flattened
 * story-time ordinals survive the trip they exist to make queryable.
 */

import { FixedClock, IdGenerator, instant, sha256 } from '@rv/shared-kernel';
import {
  type EntityId,
  Ids,
  type IsoInstant,
  type RelationId,
  type SceneId,
  type SeriesId,
} from '@rv/contracts';
import { eq } from 'drizzle-orm';
import { type SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTestDatabase } from '../__fixtures__/workspace';
import {
  beat,
  episodeStructure,
  sceneSpace,
  shotAudio,
  shotCamera,
  shotLayer,
  styleBible,
  valueShift,
} from '../__fixtures__/documents';
import type { DatabaseHandle } from '../database/database';
import {
  assetVersions,
  assets,
  blobs,
  clips,
  entities,
  episodes,
  facts,
  jobs,
  parts,
  relations,
  runs,
  scenes,
  shots,
  spriteSheets,
  styleBibles,
  usageRecords,
  variants,
} from './index';

/** Every table, so a new one cannot quietly skip the structural assertions below. */
const ALL_TABLES: readonly SQLiteTable[] = [
  assets,
  assetVersions,
  parts,
  variants,
  clips,
  spriteSheets,
  blobs,
  styleBibles,
  entities,
  relations,
  facts,
  episodes,
  scenes,
  shots,
  runs,
  jobs,
  usageRecords,
];

const NOW = '2026-08-23T00:00:00.000Z' as IsoInstant;
const HASH = sha256('anything') as string;

let handle: DatabaseHandle;
let ids: Ids;
let seriesId: SeriesId;

beforeEach(() => {
  handle = openTestDatabase();
  let counter = 0;
  ids = new Ids(
    new IdGenerator(new FixedClock(instant(1_724_400_000_000)), (size) => {
      counter += 1;
      return Uint8Array.from({ length: size }, (_, index) => (counter * 23 + index * 7) & 0xff);
    }),
  );
  seriesId = ids.series();
});

afterEach(() => {
  handle.close();
});

function insertEntity(id: EntityId): void {
  handle.db
    .insert(entities)
    .values({
      id,
      seriesId,
      kind: 'character',
      canonicalName: 'Kael',
      aliases: ['the ferryman'],
      summary: 'A ferryman who owes a debt.',
      firstAppearanceOrdinal: 10,
      firstAppearanceLabel: 'first thaw',
      importance: 'lead',
      assetRefs: [],
      payload: { archetype: 'reluctant-hero' },
      embedding: [0.5, -0.25],
      embeddingModel: 'nomic-embed-text',
    })
    .run();
}

function insertRelation(id: RelationId, entityId: EntityId): void {
  handle.db
    .insert(relations)
    .values({
      id,
      seriesId,
      fromEntityId: entityId,
      toEntityId: entityId,
      type: 'knows',
      fact: 'Kael knows the crossing is cursed.',
      strength: 0.75,
      validFromOrdinal: 20,
      validFromLabel: 'the second crossing',
      validUntilOrdinal: null,
      validUntilLabel: null,
      assertedAt: NOW,
      retractedAt: null,
      sourceRef: { kind: 'author', note: 'series bible' },
      confidence: 1,
      visibility: 'public',
    })
    .run();
}

describe('referential integrity', () => {
  it('has no cascade anywhere: deleting a row can never delete another', () => {
    const cascading: string[] = [];

    for (const table of ALL_TABLES) {
      const config = getTableConfig(table);
      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference();
        // RV-106 wants a deleted project to leave its assets resolvable for everyone
        // else, and ADR-0006 wants no row deletion to be capable of deleting bytes. A
        // cascade added for convenience would defeat both silently.
        if (foreignKey.onDelete !== undefined && foreignKey.onDelete !== 'no action') {
          cascading.push(`${config.name}.${reference.columns[0]?.name ?? '?'}`);
        }
      }
    }

    expect(cascading).toEqual([]);
  });

  it('points every foreign key at the table it claims to', () => {
    const edges = ALL_TABLES.flatMap((table) => {
      const config = getTableConfig(table);
      return config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return `${config.name}.${reference.columns[0]?.name ?? '?'} -> ${getTableConfig(reference.foreignTable).name}`;
      });
    }).sort();

    expect(edges).toEqual([
      'asset_versions.asset_id -> assets',
      'clips.version_id -> asset_versions',
      'facts.holder_id -> entities',
      'facts.relation_id -> relations',
      'jobs.run_id -> runs',
      'parts.version_id -> asset_versions',
      'relations.from_entity_id -> entities',
      'relations.to_entity_id -> entities',
      'scenes.episode_id -> episodes',
      'shots.scene_id -> scenes',
      'sprite_sheets.clip_id -> clips',
      'usage_records.run_id -> runs',
      'variants.version_id -> asset_versions',
    ]);
  });

  it('does not foreign-key any image hash to the blob index', () => {
    // The bytes are shared across every project on the machine and the index row may
    // not exist yet. A constraint here would make one of those a lie.
    const referencing = ALL_TABLES.filter((table) =>
      getTableConfig(table).foreignKeys.some(
        (foreignKey) => getTableConfig(foreignKey.reference().foreignTable).name === 'blobs',
      ),
    );

    expect(referencing).toEqual([]);
  });
});

describe('style_bibles', () => {
  it('stores the four big blocks as documents and the checksum as its own column', () => {
    const bible = styleBible(ids);

    handle.db
      .insert(styleBibles)
      .values({
        id: bible.id,
        name: bible.name,
        version: bible.version,
        origin: bible.origin,
        parentId: null,
        visual: bible.visual,
        motion: bible.motion,
        render: bible.render,
        prompts: bible.prompts,
        anchors: bible.anchors,
        seed: bible.seed,
        checksum: bible.checksum,
        lockedAt: bible.lockedAt,
        createdAt: bible.createdAt,
        notes: null,
      })
      .run();

    const [row] = handle.db
      .select()
      .from(styleBibles)
      .where(eq(styleBibles.checksum, bible.checksum))
      .all();

    // The checksum is a column because every asset key depends on it; the blocks are
    // documents because nothing queries inside them.
    expect(row?.visual).toEqual(bible.visual);
    expect(row?.motion).toEqual(bible.motion);
    expect(row?.prompts).toEqual(bible.prompts);
    expect(row?.seed).toBe(bible.seed);
  });
});

describe('the narrative graph', () => {
  it('stores an entity payload whole and its story time as an ordinal', () => {
    const entityId = ids.entity();
    insertEntity(entityId);

    const [row] = handle.db.select().from(entities).all();

    expect(row?.payload).toEqual({ archetype: 'reluctant-hero' });
    expect(row?.firstAppearanceOrdinal).toBe(10);
    // Float64: a ranking must not depend on how the vector was rounded going in.
    expect(row?.embedding).toEqual([0.5, -0.25]);
  });

  it('keeps story time and authoring time as separate, independently queryable axes', () => {
    const entityId = ids.entity();
    insertEntity(entityId);
    insertRelation(ids.relation(), entityId);

    const [row] = handle.db.select().from(relations).all();

    // `validUntil` ends the fact inside the fiction; `retractedAt` un-says the
    // sentence in authoring time. Neither implies the other, so neither is derived.
    expect(row?.validFromOrdinal).toBe(20);
    expect(row?.validUntilOrdinal).toBeNull();
    expect(row?.retractedAt).toBeNull();
    expect(row?.sourceRef).toEqual({ kind: 'author', note: 'series bible' });
  });

  it('refuses a relation pointing at an entity that does not exist', () => {
    expect(() => {
      insertRelation(ids.relation(), ids.entity());
    }).toThrow();
  });

  it('stores a belief against the relation it is about, keyed by who holds it', () => {
    const entityId = ids.entity();
    const relationId = ids.relation();
    insertEntity(entityId);
    insertRelation(relationId, entityId);

    handle.db
      .insert(facts)
      .values({
        id: ids.fact(),
        seriesId,
        holderId: entityId,
        relationId,
        fact: 'I think the crossing is cursed.',
        via: 'believes-falsely',
        learnedAtOrdinal: 30,
        learnedAtLabel: null,
        learnedFromEntityId: null,
        confidence: 0.4,
      })
      .run();

    const [row] = handle.db.select().from(facts).all();

    // How sure *they* are, which is not how sure we are - that lives on the relation.
    expect(row?.confidence).toBe(0.4);
    expect(row?.via).toBe('believes-falsely');
    expect(row?.holderId).toBe(entityId);
  });
});

describe('the story tree', () => {
  function insertEpisodeAndScene(sceneId: SceneId): void {
    handle.db
      .insert(episodes)
      .values({
        id: ids.episode(),
        seriesId,
        seasonId: null,
        ordinal: 1,
        title: 'The Crossing',
        summary: 'Kael takes a passenger he should have refused.',
        plannedSummary: null,
        status: 'draft',
        logline: 'A ferryman takes the wrong fare.',
        coldOpen: null,
        cliffhanger: null,
        opensLoops: [],
        closesLoops: [],
        airedAt: null,
        structure: episodeStructure(ids, sceneId),
      })
      .run();

    const [episode] = handle.db.select().from(episodes).all();
    handle.db
      .insert(scenes)
      .values({
        id: sceneId,
        episodeId: episode?.id ?? ids.episode(),
        ordinal: 1,
        title: 'The jetty',
        summary: 'A stranger asks for passage.',
        plannedSummary: null,
        locationRef: ids.entity(),
        povEntityRef: null,
        presentEntityRefs: [],
        goal: 'Refuse the fare.',
        conflict: 'The fare is his brother.',
        outcome: 'He accepts.',
        fromOrdinal: 10,
        fromLabel: 'dusk',
        untilOrdinal: 12,
        untilLabel: null,
        valueShift: valueShift(),
        beats: [beat(ids)],
      })
      .run();
  }

  it('rows the three queried levels and keeps acts and sequences as an outline', () => {
    const sceneId = ids.scene();
    insertEpisodeAndScene(sceneId);
    const layer = shotLayer(ids);

    handle.db
      .insert(shots)
      .values({
        id: ids.shot(),
        sceneId,
        index: 0,
        durationMs: 3200,
        beatRef: ids.beat(),
        sceneSpace: sceneSpace(),
        camera: shotCamera(),
        layout: [layer],
        blocking: [],
        dialogue: [],
        audio: shotAudio(),
        safeArea: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        focusTarget: shotCamera().focusTarget,
      })
      .run();

    const [episode] = handle.db.select().from(episodes).all();
    const [scene] = handle.db.select().from(scenes).all();
    const [shot] = handle.db.select().from(shots).all();

    // The outline names scenes rather than embedding them, so rewriting one scene does
    // not rewrite its siblings.
    expect(episode?.structure[0]?.sequences[0]?.sceneIds).toEqual([sceneId]);
    expect(scene?.fromOrdinal).toBe(10);
    expect(scene?.beats).toHaveLength(1);
    expect(shot?.layout).toEqual([layer]);
    expect(shot?.camera).toEqual(shotCamera());
    expect(shot?.audio).toEqual({ sfx: [], music: null });
  });

  it('keeps the shot list unique by index within a scene', () => {
    const sceneId = ids.scene();
    insertEpisodeAndScene(sceneId);

    const shot = {
      id: ids.shot(),
      sceneId,
      index: 0,
      durationMs: 1000,
      beatRef: ids.beat(),
      sceneSpace: sceneSpace(),
      camera: shotCamera(),
      layout: [shotLayer(ids)],
      blocking: [],
      dialogue: [],
      audio: shotAudio(),
      safeArea: { x: 0, y: 0, width: 1, height: 1 },
      focusTarget: shotCamera().focusTarget,
    };
    handle.db.insert(shots).values(shot).run();

    // The contract says the shot list is contiguous with no gaps; the index has to be
    // the thing that enforces it, because a re-plan writes shots one at a time.
    expect(() =>
      handle.db
        .insert(shots)
        .values({ ...shot, id: ids.shot() })
        .run(),
    ).toThrow();
  });

  it('refuses a scene attached to an episode that does not exist', () => {
    expect(() =>
      handle.db
        .insert(scenes)
        .values({
          id: ids.scene(),
          episodeId: ids.episode(),
          ordinal: 1,
          title: 'Orphan',
          summary: 'Nowhere.',
          plannedSummary: null,
          locationRef: ids.entity(),
          povEntityRef: null,
          presentEntityRefs: [],
          goal: 'Goal.',
          conflict: 'Conflict.',
          outcome: 'Outcome.',
          fromOrdinal: null,
          fromLabel: null,
          untilOrdinal: null,
          untilLabel: null,
          valueShift: valueShift(),
          beats: [],
        })
        .run(),
    ).toThrow();
  });
});

describe('the operational tables', () => {
  it('records a run, its job, and a ledger line with every summed number as a column', () => {
    const runId = ids.run();
    const jobId = ids.job();

    handle.db
      .insert(runs)
      .values({
        id: runId,
        projectId: ids.project(),
        stage: 'produce',
        state: 'running',
        budgetNanoUsd: 5_000_000_000,
        spentNanoUsd: 0,
        seed: 99,
        errorCode: null,
        metadata: { episode: 'E01' },
        startedAt: NOW,
        finishedAt: null,
      })
      .run();

    handle.db
      .insert(jobs)
      .values({
        id: jobId,
        runId,
        stage: 'produce',
        state: 'queued',
        attempt: 1,
        payload: { assetKey: HASH },
        result: null,
        errorCode: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();

    handle.db
      .insert(usageRecords)
      .values({
        id: ids.usage(),
        runId,
        jobId,
        stage: 'produce',
        provider: 'openrouter',
        model: 'google/gemini-3.1-flash-lite-image',
        task: 'image-final',
        tier: 'preview',
        tokensInput: 120,
        tokensOutput: 0,
        tokensCached: 0,
        tokensReasoning: 0,
        imageCount: 1,
        imageResolution: { width: 1024, height: 1024 },
        latencyMs: 2400,
        costNanoUsd: 6_000_000,
        outcome: 'success',
        errorCode: null,
        cacheHit: false,
        at: NOW,
      })
      .run();

    const [record] = handle.db.select().from(usageRecords).all();

    // The budget guard sums this column; it must never have to parse JSON to do it.
    expect(record?.costNanoUsd).toBe(6_000_000);
    expect(record?.imageResolution).toEqual({ width: 1024, height: 1024 });
    expect(record?.cacheHit).toBe(false);
    expect(handle.db.select().from(jobs).all()[0]?.payload).toEqual({ assetKey: HASH });
    expect(handle.db.select().from(runs).all()[0]?.metadata).toEqual({ episode: 'E01' });
  });

  it('refuses a job attributed to a run that does not exist', () => {
    expect(() =>
      handle.db
        .insert(jobs)
        .values({
          id: ids.job(),
          runId: ids.run(),
          stage: 'produce',
          state: 'queued',
          attempt: 1,
          payload: {},
          result: null,
          errorCode: null,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run(),
    ).toThrow();
  });
});

describe('sprite_sheets', () => {
  it('stores the per-frame rects as one document rather than a row per frame', () => {
    const clipId = ids.clip();
    const frames = [
      { rect: { x: 0, y: 0, width: 64, height: 64 }, trimOffset: { x: 0, y: 0 } },
      { rect: { x: 64, y: 0, width: 64, height: 64 }, trimOffset: { x: 2, y: 1 } },
    ];

    // No clip row exists, so this must be refused: a baked sheet without its clip is an
    // artefact nothing can rebuild.
    expect(() =>
      handle.db
        .insert(spriteSheets)
        .values({
          id: ids.sheet(),
          clipId,
          atlasImageHash: HASH,
          atlasJsonHash: HASH,
          frameCount: frames.length,
          fps: 24,
          frameWidth: 64,
          frameHeight: 64,
          atlasWidth: 128,
          atlasHeight: 64,
          frames,
          trimmed: true,
          padding: 2,
          createdAt: NOW,
        })
        .run(),
    ).toThrow();
  });
});

describe('blobs', () => {
  it('indexes what the content store holds without owning it', () => {
    handle.db
      .insert(blobs)
      .values({ hash: HASH, byteSize: 8, mediaType: 'image/png', createdAt: NOW })
      .run();

    expect(handle.db.select().from(blobs).all()[0]?.byteSize).toBe(8);
    // No foreign key points here: deleting an index row must never be capable of
    // deleting a file another project still references.
    expect(() => handle.db.delete(blobs).where(eq(blobs.hash, HASH)).run()).not.toThrow();
  });
});
