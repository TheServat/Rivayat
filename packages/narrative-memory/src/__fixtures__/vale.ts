/**
 * The Vale - the fixture docs/02 §3 describes, built.
 *
 * > - `truth`: `(Aria) —parent-of→ (Kael)`, `visibility: secret`, valid from year 0
 * > - `belief`: `(Kael) —believes-falsely→ "my parents died in the fire"`, valid E01-E08
 * > - `reveal`: at E08 the belief edge gets `validUntil = E08`, and
 * >   `(Kael) —knows→ (Aria is my mother)` opens
 *
 * This is the case the whole epistemic layer exists for, so it is the case the tests are
 * written against. Story ordinals are episode number × 100, leaving room to insert
 * scenes and flashbacks between them without renumbering anything - which is what
 * `StoryTime`'s "gaps are expected and useful" is for.
 *
 * One graph, not two. The belief is bounded at E08 and the `knows` edge opens at E08, so
 * the same graph answers "what did Kael know in E05" and "what does he know in E09"
 * differently - which is the property under test, and which two separate fixtures would
 * quietly fail to check.
 */

import type { Entity, EntityId, Relation } from '@rv/contracts';

import { NarrativeGraph } from '../graph/narrative-graph';
import {
  SERIES_ID,
  character,
  entityId,
  episodeId,
  location,
  prop,
  relation,
  relationFact,
  seriesSummary,
  storyTime,
} from './builders';

/** Episode N sits at ordinal N × 100. */
export function episodeOrdinal(episode: number): number {
  return episode * 100;
}

export const KAEL = entityId('kael');
export const ARIA = entityId('aria');
export const FIRE = entityId('the fire');
export const VALE = entityId('the vale');
export const KEEP = entityId('the keep');
export const SWORD = entityId('the sword');

export const REVEAL_ORDINAL = episodeOrdinal(8);

export const EPISODES = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => episodeId(`e0${String(index)}`));

export function valeEntities(): readonly Entity[] {
  return [
    character('kael', {
      canonicalName: 'Kael',
      aliases: ['Kael Ardent', 'the boy'],
      importance: 'lead',
      summary: 'A ward of the Vale who believes he is an orphan.',
      firstAppearance: storyTime(0),
      payload: {
        identity: {
          age: '19',
          ageYears: 19,
          gender: 'male',
          species: 'human',
          occupation: 'ward of the keep',
          origin: 'the Vale',
        },
        visual: {
          silhouetteNote: 'a boy in a coat two sizes too large',
          build: 'lean',
          height: 'average',
          palette: [],
          distinguishingMarks: [],
          wardrobe: [
            {
              slug: 'wardrobe-winter',
              label: 'Winter coat',
              description: 'A heavy oiled coat, cuffs worn through.',
              validity: { from: storyTime(0), until: storyTime(600) },
              palette: [],
            },
            {
              slug: 'wardrobe-mourning',
              label: 'Mourning grey',
              description: 'Undyed wool, no fastenings.',
              validity: { from: storyTime(600), until: null },
              palette: [],
            },
          ],
          expressionSet: [],
          poseSet: [],
          propAffinities: [],
        },
      },
    }),
    character('aria', {
      canonicalName: 'Aria',
      aliases: ['the steward'],
      importance: 'lead',
      summary: 'Steward of the keep, and the only person who knows whose son Kael is.',
      firstAppearance: storyTime(0),
      payload: {
        identity: {
          age: '44',
          ageYears: 44,
          gender: 'female',
          species: 'human',
          occupation: 'steward',
          origin: 'the Vale',
        },
      },
    }),
    {
      kind: 'event',
      id: FIRE,
      seriesId: SERIES_ID,
      canonicalName: 'the fire',
      aliases: ['the night of the fire'],
      summary: 'The fire that took the lower town, and supposedly Kael’s parents.',
      firstAppearance: storyTime(-1000),
      importance: 'recurring',
      assetRefs: [],
      embedding: [],
      payload: {
        eventType: 'disaster',
        occurredAt: storyTime(-1000),
        place: VALE,
        participants: [],
        account: 'The lower town burned. Two bodies were never identified.',
        consequences: 'Kael was taken into the keep as a ward.',
        disputed: true,
      },
    },
    location('the vale', { canonicalName: 'the Vale', importance: 'recurring' }),
    location('the keep', { canonicalName: 'the Keep', importance: 'recurring' }),
    prop('the sword', { canonicalName: 'the sword', importance: 'recurring' }),
  ];
}

export function valeRelations(): readonly Relation[] {
  return [
    // The truth. Secret, and true from before the story opens.
    relation({
      slug: 'aria-parent-of-kael',
      from: ARIA,
      to: KAEL,
      type: 'parent-of',
      fact: 'Aria is Kael’s mother.',
      validFrom: storyTime(0),
      validUntil: null,
      visibility: 'secret',
    }),
    // The lie he lives in, bounded at the reveal rather than deleted by it.
    relation({
      slug: 'kael-believes-fire',
      from: KAEL,
      to: FIRE,
      type: 'believes-falsely',
      fact: 'Kael believes his parents died in the fire.',
      validFrom: storyTime(episodeOrdinal(1)),
      validUntil: storyTime(REVEAL_ORDINAL),
      visibility: 'public',
    }),
    // The reveal. Opens exactly where the belief closes: half-open intervals mean there
    // is no moment where he holds both and no moment where he holds neither.
    relation({
      slug: 'kael-knows-aria',
      from: KAEL,
      to: ARIA,
      type: 'knows',
      fact: 'Kael knows Aria is his mother.',
      validFrom: storyTime(REVEAL_ORDINAL),
      validUntil: null,
      visibility: 'public',
      sourceRef: { kind: 'episode', episodeId: episodeId('e08') },
    }),
    relation({
      slug: 'kael-in-vale',
      from: KAEL,
      to: VALE,
      type: 'located-in',
      fact: 'Kael is in the Vale.',
      validFrom: storyTime(0),
      validUntil: null,
    }),
    relation({
      slug: 'aria-in-keep',
      from: ARIA,
      to: KEEP,
      type: 'located-in',
      fact: 'Aria is in the Keep.',
      validFrom: storyTime(0),
      validUntil: null,
    }),
    relation({
      slug: 'aria-carries-sword',
      from: ARIA,
      to: SWORD,
      type: 'carries',
      fact: 'Aria carries the sword.',
      validFrom: storyTime(0),
      validUntil: null,
    }),
  ];
}

/** The whole fixture, with facts mirroring every edge so retrieval has candidates. */
export function valeGraph(
  overrides: Partial<Parameters<typeof buildGraph>[0]> = {},
): NarrativeGraph {
  return buildGraph(overrides);
}

function buildGraph(overrides: {
  readonly relations?: readonly Relation[];
  readonly entities?: readonly Entity[];
  readonly airedEpisodes?: readonly ReturnType<typeof episodeId>[];
}): NarrativeGraph {
  const relations = overrides.relations ?? valeRelations();
  return new NarrativeGraph({
    seriesId: SERIES_ID,
    entities: overrides.entities ?? valeEntities(),
    relations,
    facts: relations.map((edge, index) => relationFact(`vale-fact-${String(index)}`, edge)),
    seriesSummary: seriesSummary(),
    episodeOrder: EPISODES,
    ...(overrides.airedEpisodes !== undefined ? { airedEpisodes: overrides.airedEpisodes } : {}),
  });
}

/** The parentage edge, which is what "acting on a secret" means in these tests. */
export function parentageEdge(graph: NarrativeGraph): Relation {
  const found = graph.relations.find((edge) => edge.type === 'parent-of');
  if (found === undefined) throw new Error('fixture is missing the parentage edge');
  return found;
}

export function nameOf(graph: NarrativeGraph, id: EntityId): string {
  return graph.entity(id)?.canonicalName ?? id;
}
