/**
 * A world model with one seeded contradiction.
 *
 * The M2 demo line is `pnpm rv continuity check --episode E06  # exits non-zero on the
 * seeded contradiction`, so the fixture's job is to contain exactly one, of a kind the
 * *free* rule pass can decide: Kael dies at story ordinal 3 and acts at ordinal 6.
 * `dead-character-acting` needs only the vitality ledger and the scene's acting list, so
 * the fixture stays small and no entity payload has to be invented.
 */

import type { WorldDocument } from '../store/documents';

function id(prefix: string, tail: string): string {
  return `${prefix}_01J8ZQ4E7K9M2N4P6R8T0V${tail.toUpperCase().padStart(4, '0')}`;
}

export const SERIES_ID = id('ser', '001');
export const KAEL_ID = id('ent', '010');
export const LOCATION_ID = id('ent', '011');
export const EPISODE_06 = id('ep', '006');
export const SCENE_ID = id('scn', '060');

const NOW = '2026-08-23T18:00:00.000Z';

/** A graph in which Kael is dead from ordinal 3 and acts at ordinal 6. */
export function contradictoryWorld(): WorldDocument {
  return {
    version: 1,
    projectId: id('prj', '001'),
    seriesId: SERIES_ID,
    entities: [],
    relations: [],
    facts: [],
    openLoops: [],
    vitality: [
      {
        entityId: KAEL_ID,
        status: 'dead',
        at: { ordinal: 3 },
        sourceRef: { kind: 'author', note: 'seeded for the continuity demo' },
      },
    ],
    episodeOrder: [EPISODE_06],
    airedEpisodes: [],
    scenesByEpisode: {
      [EPISODE_06]: [
        {
          sceneId: SCENE_ID,
          at: { ordinal: 6 },
          locationId: LOCATION_ID,
          presentEntityIds: [KAEL_ID],
          actingEntityIds: [KAEL_ID],
          usesKnowledge: [],
          wardrobe: [],
          props: [],
          statedAges: [],
        },
      ],
    },
    updatedAt: NOW,
  };
}

/** The same shape with the death moved after the scene. Nothing to report. */
export function cleanWorld(): WorldDocument {
  const world = contradictoryWorld();
  return {
    ...world,
    vitality: world.vitality.map((record) => ({ ...record, at: { ordinal: 9 } })),
  };
}
