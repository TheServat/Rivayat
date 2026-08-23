/**
 * Builders for the shapes the engine reads.
 *
 * `Entity` is nine payloads under one envelope and a `CharacterPayload` alone is thirty
 * required fields; a test that spells all of them out to assert one thing about
 * retrieval is a test nobody will maintain. These builders fill the boring 90 % with
 * defaults and let each test override the two or three fields it is actually about.
 *
 * Ids are **derived from the slug**, not minted, so a fixture reads as
 * `entityId('kael')` everywhere and every run produces the same graph. That is the same
 * mechanism the engine itself uses (`derive-id.ts`), which means the fixtures exercise
 * it rather than working around it.
 */

import type {
  CharacterEntity,
  Entity,
  EntityId,
  EpisodeId,
  EpisodeSummary,
  Fact,
  FactId,
  LocationEntity,
  OpenLoop,
  OpenLoopId,
  PropEntity,
  Relation,
  RelationId,
  RelationSource,
  RelationType,
  SceneId,
  SeasonId,
  SeriesId,
  SeriesSummary,
  StoryTime,
} from '@rv/contracts';

import { deriveId } from '../graph/derive-id';

export const SERIES_ID = deriveId<SeriesId>('series', 'rivayat-test-series');

export function entityId(slug: string): EntityId {
  return deriveId<EntityId>('entity', slug);
}
export function relationId(slug: string): RelationId {
  return deriveId<RelationId>('relation', slug);
}
export function factId(slug: string): FactId {
  return deriveId<FactId>('fact', slug);
}
export function sceneId(slug: string): SceneId {
  return deriveId<SceneId>('scene', slug);
}
export function episodeId(slug: string): EpisodeId {
  return deriveId<EpisodeId>('episode', slug);
}
export function seasonId(slug: string): SeasonId {
  return deriveId<SeasonId>('season', slug);
}
export function loopId(slug: string): OpenLoopId {
  return deriveId<OpenLoopId>('openLoop', slug);
}

export function storyTime(ordinal: number, label?: string): StoryTime {
  return label === undefined ? { ordinal } : { ordinal, label };
}

export const AUTHORED = '2026-01-01T00:00:00.000Z';

export function character(
  slug: string,
  overrides: Partial<Omit<CharacterEntity, 'kind' | 'payload'>> & {
    readonly payload?: Partial<CharacterEntity['payload']>;
  } = {},
): CharacterEntity {
  const { payload, ...envelope } = overrides;
  return {
    kind: 'character',
    id: entityId(slug),
    seriesId: SERIES_ID,
    canonicalName: slug,
    aliases: [],
    summary: `${slug} is a person in this story.`,
    firstAppearance: storyTime(0),
    importance: 'supporting',
    assetRefs: [],
    embedding: [],
    ...envelope,
    payload: {
      identity: {
        age: '30',
        gender: 'unstated',
        species: 'human',
        occupation: 'unstated',
        origin: 'the Vale',
      },
      psych: {
        want: 'to be let alone',
        need: 'to be known',
        wound: 'an abandonment',
        lie: 'nobody stays',
        ghost: 'the night of the fire',
        virtues: [],
        flaws: [],
        fears: [],
        values: [],
        temperament: {
          warmth: 0,
          dominance: 0,
          volatility: 0,
          openness: 0,
          conscientiousness: 0,
        },
      },
      voice: {
        register: 'neutral',
        verbosity: 'measured',
        idiolect: [],
        verbalTics: [],
        profanity: 'none',
        sentenceRhythm: 'balanced',
        humourMode: 'none',
        silenceHabits: 'goes quiet when cornered',
      },
      arc: { startState: 'closed', endState: 'open', turningPoints: [] },
      visual: {
        silhouetteNote: 'a long coat and a lopsided stance',
        build: 'lean',
        height: 'average',
        palette: [],
        distinguishingMarks: [],
        wardrobe: [],
        expressionSet: [],
        poseSet: [],
        propAffinities: [],
      },
      motionSignature: {
        gaitStyle: 'stride',
        posture: 'upright',
        gestureFrequency: 0.5,
        energy: 0.5,
        idleBehaviour: 'shifts weight',
        tellOnLying: 'touches the left cuff',
      },
      knowledgeScope: 'limited',
      ...payload,
    },
  };
}

export function location(slug: string, overrides: Partial<LocationEntity> = {}): LocationEntity {
  return {
    kind: 'location',
    id: entityId(slug),
    seriesId: SERIES_ID,
    canonicalName: slug,
    aliases: [],
    summary: `${slug} is a place in this story.`,
    firstAppearance: storyTime(0),
    importance: 'background',
    assetRefs: [],
    embedding: [],
    payload: {
      locationType: 'exterior',
      scale: 'district',
      parentLocation: null,
      establishingNote: `A wide shot of ${slug}.`,
      architecture: 'stone and slate',
      soundscape: [],
      palette: [],
      timeOfDayVariants: [],
      weatherVariants: [],
      moodVariants: [],
      affordances: [],
    },
    ...overrides,
  };
}

export function prop(slug: string, overrides: Partial<PropEntity> = {}): PropEntity {
  return {
    kind: 'prop',
    id: entityId(slug),
    seriesId: SERIES_ID,
    canonicalName: slug,
    aliases: [],
    summary: `${slug} is an object in this story.`,
    firstAppearance: storyTime(0),
    importance: 'background',
    assetRefs: [],
    embedding: [],
    payload: {
      scale: 'handheld',
      materials: ['iron'],
      riggable: false,
      isUnique: true,
      significance: 'it matters later',
      palette: [],
      conditionVariants: [],
    },
    ...overrides,
  };
}

export interface RelationSpec {
  readonly slug: string;
  readonly from: EntityId;
  readonly to: EntityId;
  readonly type: RelationType;
  readonly fact: string;
  readonly validFrom?: StoryTime | null;
  readonly validUntil?: StoryTime | null;
  readonly assertedAt?: string;
  readonly retractedAt?: string | null;
  readonly visibility?: Relation['visibility'];
  readonly strength?: number;
  readonly confidence?: number;
  readonly sourceRef?: RelationSource;
}

export function relation(spec: RelationSpec): Relation {
  return {
    id: relationId(spec.slug),
    seriesId: SERIES_ID,
    from: spec.from,
    to: spec.to,
    type: spec.type,
    fact: spec.fact,
    strength: spec.strength ?? 0,
    validFrom: spec.validFrom ?? null,
    validUntil: spec.validUntil ?? null,
    assertedAt: spec.assertedAt ?? AUTHORED,
    retractedAt: spec.retractedAt ?? null,
    sourceRef: spec.sourceRef ?? { kind: 'author' },
    confidence: spec.confidence ?? 1,
    visibility: spec.visibility ?? 'public',
  };
}

/** A `Fact` whose content is an edge - the ordinary retrievable unit. */
export function relationFact(
  slug: string,
  edge: Relation,
  overrides: Partial<Omit<Fact, 'content'>> = {},
): Fact {
  return {
    id: factId(slug),
    seriesId: SERIES_ID,
    content: { kind: 'relation', relationId: edge.id },
    validFrom: edge.validFrom,
    validUntil: edge.validUntil,
    assertedAt: edge.assertedAt,
    retractedAt: edge.retractedAt,
    sourceRef: edge.sourceRef,
    confidence: edge.confidence,
    visibility: edge.visibility,
    importance: 'supporting',
    ...overrides,
  };
}

export function statementFact(
  slug: string,
  text: string,
  overrides: Partial<Omit<Fact, 'content'>> = {},
): Fact {
  return {
    id: factId(slug),
    seriesId: SERIES_ID,
    content: { kind: 'statement', text },
    validFrom: null,
    validUntil: null,
    assertedAt: AUTHORED,
    retractedAt: null,
    sourceRef: { kind: 'author' },
    confidence: 1,
    visibility: 'public',
    importance: 'background',
    ...overrides,
  };
}

export function openLoop(slug: string, overrides: Partial<OpenLoop> = {}): OpenLoop {
  return {
    id: loopId(slug),
    seriesId: SERIES_ID,
    setup: `${slug} was planted`,
    promise: `the audience expects ${slug} to pay off`,
    plantedAt: storyTime(0),
    plantedIn: { episodeId: episodeId('e01') },
    entities: [],
    relations: [],
    expectedPayoff: { from: storyTime(0), until: null },
    urgency: 0.5,
    status: 'open',
    paidIn: null,
    ...overrides,
  };
}

export function seriesSummary(overrides: Partial<SeriesSummary> = {}): SeriesSummary {
  return {
    seriesId: SERIES_ID,
    premise: 'A boy raised on a lie walks back into the house that told it.',
    synopsis: 'Eight episodes of the Vale coming apart.',
    themes: ['inheritance'],
    toneNote: 'Cold, patient, and never cruel for its own sake.',
    rulesOfTheWorld: ['The dead do not come back.'],
    seasons: [],
    principalCast: [],
    openLoops: [],
    storySpan: { from: storyTime(0), until: null },
    canonThroughEpisode: null,
    ...overrides,
  };
}

export function episodeSummary(
  slug: string,
  overrides: Partial<EpisodeSummary> = {},
): EpisodeSummary {
  return {
    episodeId: episodeId(slug),
    seasonId: seasonId('s01'),
    seriesId: SERIES_ID,
    index: 0,
    title: slug,
    logline: `What ${slug} is about.`,
    synopsis: `What happens in ${slug}.`,
    beats: ['They meet.', 'They part.'],
    storySpan: { from: storyTime(0), until: storyTime(10) },
    entitiesIntroduced: [],
    relationsChanged: [],
    openLoopsPlanted: [],
    openLoopsPaid: [],
    canonFrozen: false,
    ...overrides,
  };
}

export function isEntity(value: Entity | undefined): value is Entity {
  return value !== undefined;
}
