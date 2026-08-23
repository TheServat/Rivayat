/**
 * The id surface.
 *
 * `Ids` is the one place an untyped generated string is widened into a branded type, so
 * a wrong prefix here is a wrong id everywhere and the brand is what stops the compiler
 * catching it. Every minting method therefore gets exercised against the schema for the
 * type it claims to return - a `season()` that quietly minted a `ser_` id would compile,
 * pass its own type check, and only fail much later at a database foreign key.
 */

import { FixedClock, IdGenerator, instant } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  ActId,
  AnimationId,
  AssetId,
  AssetVersionId,
  BeatId,
  BehaviourId,
  BoneId,
  ClipId,
  CommunityId,
  EntityId,
  EpisodeId,
  FactId,
  ID_PREFIXES,
  Ids,
  IssueId,
  JobId,
  MarkerId,
  NodeId,
  OpenLoopId,
  PartId,
  ProjectId,
  RelationId,
  RigId,
  RunId,
  SceneId,
  SeasonId,
  SequenceId,
  SeriesId,
  SheetId,
  ShotId,
  StyleBibleId,
  TrackId,
  UsageId,
  VariantId,
} from './ids';
import type { IdKind } from './ids';

/** A deterministic generator, so a failure is reproducible rather than a coin toss. */
function fixedIds(): Ids {
  let counter = 0;
  return new Ids(
    new IdGenerator(new FixedClock(instant(1_724_400_000_000)), (size) => {
      counter += 1;
      return Uint8Array.from({ length: size }, (_, i) => (counter * 11 + i * 7) & 0xff);
    }),
  );
}

/**
 * Every minting method, the kind it claims, and the schema that kind must satisfy.
 *
 * A table rather than a loop over `ID_PREFIXES`, because the thing under test is
 * precisely that each *named method* reaches the *right* entry - deriving the
 * expectation from the same lookup the implementation uses would test nothing.
 */
const MINTERS: readonly (readonly [keyof Ids, IdKind, z.ZodType])[] = [
  ['project', 'project', ProjectId],
  ['series', 'series', SeriesId],
  ['season', 'season', SeasonId],
  ['episode', 'episode', EpisodeId],
  ['act', 'act', ActId],
  ['sequence', 'sequence', SequenceId],
  ['scene', 'scene', SceneId],
  ['shot', 'shot', ShotId],
  ['beat', 'beat', BeatId],
  ['entity', 'entity', EntityId],
  ['relation', 'relation', RelationId],
  ['fact', 'fact', FactId],
  ['openLoop', 'openLoop', OpenLoopId],
  ['community', 'community', CommunityId],
  ['styleBible', 'styleBible', StyleBibleId],
  ['asset', 'asset', AssetId],
  ['assetVersion', 'assetVersion', AssetVersionId],
  ['part', 'part', PartId],
  ['variant', 'variant', VariantId],
  ['clip', 'clip', ClipId],
  ['rig', 'rig', RigId],
  ['bone', 'bone', BoneId],
  ['sheet', 'sheet', SheetId],
  ['animation', 'animation', AnimationId],
  ['node', 'node', NodeId],
  ['track', 'track', TrackId],
  ['behaviour', 'behaviour', BehaviourId],
  ['marker', 'marker', MarkerId],
  ['run', 'run', RunId],
  ['job', 'job', JobId],
  ['usage', 'usage', UsageId],
  ['issue', 'issue', IssueId],
];

describe('Ids mints an id of the kind its method name promises', () => {
  it('covers every kind in the prefix registry, so no entity type is unmintable', () => {
    expect(MINTERS.map(([, kind]) => kind).sort()).toEqual(Object.keys(ID_PREFIXES).sort());
  });

  it('mints an id that satisfies its own schema, for every kind', () => {
    const ids = fixedIds();
    for (const [method, kind, schema] of MINTERS) {
      const minted = (ids[method] as () => string)();
      const result = schema.safeParse(minted);
      expect(result.success, `${method}() -> ${minted}`).toBe(true);
      expect(minted.startsWith(`${ID_PREFIXES[kind]}_`), `${method}() -> ${minted}`).toBe(true);
    }
  });

  it('mints an id that no other kind will parse, so a mix-up cannot survive validation', () => {
    const ids = fixedIds();
    // Prefixes that are a prefix of another prefix would let one id parse as two kinds.
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);

    const minted = ids.scene();
    for (const [, kind, schema] of MINTERS) {
      if (kind === 'scene') continue;
      expect(schema.safeParse(minted).success, kind).toBe(false);
    }
  });

  it('never repeats an id inside one generator', () => {
    const ids = fixedIds();
    const minted = MINTERS.map(([method]) => (ids[method] as () => string)());
    expect(new Set(minted).size).toBe(minted.length);
  });

  it('mints the same sequence from the same generator, so a replay reproduces its ids', () => {
    const first = MINTERS.map(([method]) => (fixedIds()[method] as () => string)());
    const second = MINTERS.map(([method]) => (fixedIds()[method] as () => string)());
    expect(second).toEqual(first);
  });

  it('takes a live generator by default rather than requiring one at every call site', () => {
    expect(AssetId.safeParse(new Ids().asset()).success).toBe(true);
  });

  it('rejects a well-shaped id carrying the wrong prefix', () => {
    const body = new Ids().scene().split('_')[1] ?? '';
    expect(SceneId.safeParse(`scn_${body}`).success).toBe(true);
    expect(SceneId.safeParse(`ser_${body}`).success).toBe(false);
  });

  it('rejects a ULID body using the letters Crockford base32 leaves out', () => {
    for (const forbidden of ['I', 'L', 'O', 'U']) {
      expect(SceneId.safeParse(`scn_${forbidden.repeat(26)}`).success, forbidden).toBe(false);
    }
  });
});
