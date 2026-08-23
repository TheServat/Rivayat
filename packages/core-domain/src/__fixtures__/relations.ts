/**
 * Relation fixtures for the temporal index tests.
 *
 * Everything goes through `Relation.parse`, so a fixture that drifts out of shape
 * fails loudly here rather than producing a test that passes against a fantasy.
 */

import { FixedClock, IdGenerator, instant } from '@rv/shared-kernel';
import { Ids, Relation, type EntityId, type RelationType, type StoryTime } from '@rv/contracts';

const ids = new Ids(new IdGenerator(new FixedClock(instant(1_724_400_000_000)), countingBytes()));

function countingBytes(): (size: number) => Uint8Array {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, i) => (counter * 11 + i * 17) & 0xff);
  };
}

export const CAST = {
  kael: ids.entity(),
  aria: ids.entity(),
  mentor: ids.entity(),
  village: ids.entity(),
  citadel: ids.entity(),
  lantern: ids.entity(),
} as const satisfies Record<string, EntityId>;

export const SERIES_ID = ids.series();
export const EPISODE_ID = ids.episode();

export function t(ordinal: number): StoryTime {
  return { ordinal };
}

export interface RelationOverrides {
  readonly from?: EntityId;
  readonly to?: EntityId;
  readonly type?: RelationType;
  readonly fact?: string;
  readonly strength?: number;
  readonly validFrom?: StoryTime | null;
  readonly validUntil?: StoryTime | null;
  readonly assertedAt?: string;
  readonly retractedAt?: string | null;
  readonly visibility?: 'public' | 'private' | 'secret';
  readonly confidence?: number;
}

/** A valid relation with sensible defaults; override exactly what the test is about. */
export function relation(overrides: RelationOverrides = {}): Relation {
  return Relation.parse({
    id: ids.relation(),
    seriesId: SERIES_ID,
    from: overrides.from ?? CAST.kael,
    to: overrides.to ?? CAST.aria,
    type: overrides.type ?? 'trusts',
    fact: overrides.fact ?? 'Kael trusts Aria.',
    strength: overrides.strength ?? 0.5,
    validFrom: overrides.validFrom === undefined ? t(0) : overrides.validFrom,
    validUntil: overrides.validUntil === undefined ? null : overrides.validUntil,
    assertedAt: overrides.assertedAt ?? '2026-01-01T00:00:00.000Z',
    retractedAt: overrides.retractedAt === undefined ? null : overrides.retractedAt,
    sourceRef: { kind: 'episode', episodeId: EPISODE_ID },
    confidence: overrides.confidence ?? 1,
    visibility: overrides.visibility ?? 'public',
  });
}

export { ids as fixtureIds };
