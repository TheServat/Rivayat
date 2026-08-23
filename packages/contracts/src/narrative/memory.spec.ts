import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AlwaysIncluded,
  CONTINUITY_RULES,
  ContinuityIssue,
  DEFAULT_ALWAYS_INCLUDED,
  DEFAULT_RETRIEVAL_WEIGHTS,
  EpisodeSummary,
  MemoryFactRef,
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
  OPEN_LOOP_STATUSES,
  OpenLoop,
  RetrievalWeights,
  RetrievedFact,
  SeasonSummary,
  SeriesSummary,
  StateDelta,
  WorldStateSnapshot,
  blocksAiring,
} from './memory';

// ── fixtures ────────────────────────────────────────────────────────────────

const ulid = (tail: string): string => `01J9ZQ3K5M7N9P1R3T5V7X${tail}`;
const entityId = (tail: string): string => `ent_${ulid(tail)}`;
const relationId = (tail: string): string => `rel_${ulid(tail)}`;

const SERIES_ID = `ser_${ulid('0001')}`;
const SEASON_ID = `sea_${ulid('0002')}`;
const EPISODE_ID = `ep_${ulid('0003')}`;
const SCENE_ID = `scn_${ulid('0004')}`;
const LOOP_ID = `lop_${ulid('0005')}`;
const ISSUE_ID = `iss_${ulid('0006')}`;
const FACT_ID = `fct_${ulid('0007')}`;
const ARIA = entityId('0010');
const KAEL = entityId('0011');
const KNIFE = entityId('0012');
const QUAY = entityId('0013');
const STATE_HASH = 'a'.repeat(64);
const NOW = '2026-06-01T00:00:00Z';

function failurePaths<T>(result: z.ZodSafeParseResult<T>): string[] {
  if (result.success) throw new Error('expected the parse to fail, but it succeeded');
  return result.error.issues.map((issue) => issue.path.join('.'));
}

/** Walks into a converted JSON Schema, whose nested nodes are typed `JSONSchema | boolean`. */
function schemaAt(json: unknown, ...path: readonly string[]): Record<string, unknown> {
  let node: unknown = json;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`no JSON Schema node at ${path.join('.')}`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node !== 'object' || node === null) {
    throw new Error(`no JSON Schema node at ${path.join('.')}`);
  }
  return node as Record<string, unknown>;
}

const delta = {
  sceneId: SCENE_ID,
  episodeId: EPISODE_ID,
  seriesId: SERIES_ID,
  at: { ordinal: 500, label: 'E05 s03' },
};

const openLoop = {
  id: LOOP_ID,
  seriesId: SERIES_ID,
  setup: 'The tally-knife is left on the charter desk, in shot, for four seconds.',
  promise: 'Someone will pick that knife up, and it will matter who.',
  plantedAt: { ordinal: 200 },
  plantedIn: { episodeId: EPISODE_ID },
  expectedPayoff: { from: { ordinal: 300 }, until: { ordinal: 800 } },
};

const OTHER_FACT_ID = `fct_${ulid('0008')}`;

const continuityIssue = {
  id: ISSUE_ID,
  seriesId: SERIES_ID,
  episodeId: EPISODE_ID,
  severity: 'error',
  rule: 'dead-character-acting',
  // Two facts, because a contradiction has two sides and the schema now insists on it:
  // SC-9 requires the blocking error to *name* the facts that cannot both be true.
  conflictingFacts: [FACT_ID, OTHER_FACT_ID],
  explanation: 'Aria speaks in scene 4, but her status was set to dead at ordinal 480.',
};

/** An unpaid setup: the one finding that legitimately names fewer than two facts. */
const openLoopIssue = {
  id: ISSUE_ID,
  seriesId: SERIES_ID,
  episodeId: EPISODE_ID,
  severity: 'warning',
  rule: 'unpaid-open-loop',
  explanation: 'The lighthouse keeper’s letter was planted in E01 and never opened.',
};

const retrievalRequest = {
  seriesId: SERIES_ID,
  episodeId: EPISODE_ID,
  sceneId: SCENE_ID,
  at: { ordinal: 500 },
  asOf: NOW,
  sceneGoal: 'Kael must ask the question he has been avoiding, and not get an answer.',
};

const retrievedFact = {
  factId: FACT_ID,
  ref: { kind: 'relation', relationId: relationId('0020') },
  text: "Aria is Kael's mother.",
  reason: 'scored',
  rank: 3,
  score: 0.72,
  breakdown: {
    graphProximity: 1,
    semanticSimilarity: 0.6,
    storyRecency: 0.2,
    importance: 1,
    isOpenLoop: 0,
  },
  tokens: 9,
};

// ── deltas ──────────────────────────────────────────────────────────────────

describe('StateDelta', () => {
  it('defaults every change list to empty', () => {
    const parsed = StateDelta.parse(delta);
    expect(parsed.entitiesIntroduced).toEqual([]);
    expect(parsed.relationsAsserted).toEqual([]);
    expect(parsed.relationsRetracted).toEqual([]);
    expect(parsed.positionChanges).toEqual([]);
    expect(parsed.possessionChanges).toEqual([]);
    expect(parsed.knowledgeChanges).toEqual([]);
    expect(parsed.vitalityChanges).toEqual([]);
    expect(parsed.openLoopsPlanted).toEqual([]);
    expect(parsed.openLoopsPaid).toEqual([]);
  });

  it('records position, possession, knowledge and vitality changes separately', () => {
    const parsed = StateDelta.parse({
      ...delta,
      entitiesIntroduced: [KNIFE],
      positionChanges: [{ entityId: KAEL, to: QUAY }],
      possessionChanges: [{ itemId: KNIFE, from: ARIA, to: KAEL, mode: 'given' }],
      knowledgeChanges: [
        {
          knowerId: KAEL,
          change: 'learned',
          proposition: 'Aria signed the manifest.',
          aboutRelationId: relationId('0021'),
          learnedFrom: ARIA,
        },
      ],
      vitalityChanges: [{ entityId: ARIA, to: 'dead', note: 'Off screen, between scenes.' }],
    });
    // `from` is only defaulted on a position change: an item with no previous holder
    // must be stated, not assumed.
    expect(parsed.positionChanges.at(0)?.from).toBeNull();
    expect(parsed.possessionChanges.at(0)?.mode).toBe('given');
    expect(parsed.knowledgeChanges.at(0)?.change).toBe('learned');
    expect(parsed.vitalityChanges.at(0)?.to).toBe('dead');
  });

  it('requires a possession change to state where the item came from', () => {
    expect(
      failurePaths(
        StateDelta.safeParse({
          ...delta,
          possessionChanges: [{ itemId: KNIFE, to: KAEL, mode: 'taken' }],
        }),
      ),
    ).toEqual(['possessionChanges.0.from']);
  });

  it('rejects an unknown possession mode', () => {
    expect(
      failurePaths(
        StateDelta.safeParse({
          ...delta,
          possessionChanges: [{ itemId: KNIFE, from: null, to: KAEL, mode: 'inherited' }],
        }),
      ),
    ).toEqual(['possessionChanges.0.mode']);
  });
});

// ── snapshots ───────────────────────────────────────────────────────────────

describe('WorldStateSnapshot', () => {
  const snapshot = { seriesId: SERIES_ID, at: { ordinal: 500 }, asOf: NOW, stateHash: STATE_HASH };

  it('defaults to an empty world and carries both clock positions', () => {
    const parsed = WorldStateSnapshot.parse(snapshot);
    expect(parsed.entities).toEqual([]);
    expect(parsed.positions).toEqual({});
    expect(parsed.possessions).toEqual({});
    expect(parsed.knowledge).toEqual({});
    expect(parsed.at.ordinal).toBe(500);
    expect(parsed.asOf).toBe(NOW);
  });

  it('resolves who is living, where they are, what they hold and what they know', () => {
    const parsed = WorldStateSnapshot.parse({
      ...snapshot,
      entities: [{ entityId: ARIA, status: 'dead', importance: 'lead' }, { entityId: KAEL }],
      positions: { [KAEL]: QUAY },
      possessions: { [KAEL]: [KNIFE] },
      knowledge: {
        [KAEL]: {
          seriesId: SERIES_ID,
          viewerId: KAEL,
          at: { ordinal: 500 },
          asOf: NOW,
          blindSpots: [relationId('0030')],
        },
      },
    });
    expect(parsed.entities.at(1)?.status).toBe('alive');
    expect(parsed.entities.at(1)?.importance).toBe('background');
    expect(parsed.positions[KAEL]).toBe(QUAY);
    expect(parsed.possessions[KAEL]).toEqual([KNIFE]);
    expect(parsed.knowledge[KAEL]?.blindSpots).toHaveLength(1);
  });

  it('validates the keys of the state maps, not just their values', () => {
    expect(
      failurePaths(WorldStateSnapshot.safeParse({ ...snapshot, positions: { kael: QUAY } })),
    ).toEqual(['positions.kael']);
  });

  it('requires the state hash that makes a replay verifiable', () => {
    expect(failurePaths(WorldStateSnapshot.safeParse({ ...snapshot, stateHash: 'abc' }))).toEqual([
      'stateHash',
    ]);
  });
});

// ── open loops ──────────────────────────────────────────────────────────────

describe('OpenLoop', () => {
  it('starts open, unpaid, and middling in urgency', () => {
    const parsed = OpenLoop.parse(openLoop);
    expect(OPEN_LOOP_STATUSES).toEqual(['open', 'paid', 'abandoned']);
    expect(parsed.status).toBe('open');
    expect(parsed.paidIn).toBeNull();
    expect(parsed.urgency).toBe(0.5);
    expect(parsed.entities).toEqual([]);
    expect(parsed.relations).toEqual([]);
  });

  it('accepts an open-ended payoff window', () => {
    const parsed = OpenLoop.parse({
      ...openLoop,
      expectedPayoff: { from: { ordinal: 300 }, until: null },
    });
    expect(parsed.expectedPayoff.until).toBeNull();
  });

  it('accepts a paid loop that says where it was paid', () => {
    const parsed = OpenLoop.parse({
      ...openLoop,
      status: 'paid',
      paidIn: { episodeId: EPISODE_ID, sceneId: SCENE_ID, at: { ordinal: 760 } },
    });
    expect(parsed.paidIn?.at.ordinal).toBe(760);
  });

  it('rejects a loop marked paid with no payoff recorded', () => {
    expect(failurePaths(OpenLoop.safeParse({ ...openLoop, status: 'paid' }))).toEqual(['paidIn']);
  });

  it('lets an abandoned loop stay unpaid, so long as the choice is recorded', () => {
    const parsed = OpenLoop.parse({
      ...openLoop,
      status: 'abandoned',
      abandonedReason: 'The subplot was cut in the season-2 re-outline.',
    });
    expect(parsed.paidIn).toBeNull();
    expect(parsed.abandonedReason).toContain('re-outline');
  });
});

// ── continuity ──────────────────────────────────────────────────────────────

describe('ContinuityIssue', () => {
  it('defaults to a rule finding we are certain of', () => {
    const parsed = ContinuityIssue.parse(continuityIssue);
    expect(parsed.detectedBy).toBe('rule');
    expect(parsed.confidence).toBe(1);
    expect(parsed.entities).toEqual([]);
    expect(parsed.suggestedFix).toBeUndefined();
  });

  it('leaves the conflicting-fact list empty for the one finding with no other side', () => {
    expect(ContinuityIssue.parse(openLoopIssue).conflictingFacts).toEqual([]);
  });

  it('refuses a contradiction that names fewer than both of its sides', () => {
    for (const conflictingFacts of [[], [FACT_ID]]) {
      expect(
        failurePaths(ContinuityIssue.safeParse({ ...continuityIssue, conflictingFacts })),
      ).toEqual(['conflictingFacts']);
    }
  });

  it('holds every non-open-loop rule to naming both sides', () => {
    for (const rule of CONTINUITY_RULES) {
      const result = ContinuityIssue.safeParse({ ...openLoopIssue, rule });
      expect(result.success, rule).toBe(rule === 'unpaid-open-loop');
    }
  });

  it('names the rule that fired from a closed list', () => {
    expect(CONTINUITY_RULES).toContain('knowledge-without-source');
    expect(failurePaths(ContinuityIssue.safeParse({ ...continuityIssue, rule: 'vibes' }))).toEqual([
      'rule',
    ]);
  });

  it('carries the conflicting facts and a fix the operator can apply', () => {
    const parsed = ContinuityIssue.parse({
      ...continuityIssue,
      severity: 'warning',
      detectedBy: 'llm',
      confidence: 0.4,
      entities: [ARIA, KAEL],
      conflictingFacts: [FACT_ID, OTHER_FACT_ID],
      suggestedFix: "Move Aria's death to ordinal 520, after the scene she speaks in.",
    });
    expect(parsed.conflictingFacts).toHaveLength(2);
    expect(parsed.suggestedFix).toContain('520');
  });

  it('blocks airing on an error and only on an error', () => {
    expect(blocksAiring(ContinuityIssue.parse(continuityIssue))).toBe(true);
    expect(blocksAiring(ContinuityIssue.parse({ ...continuityIssue, severity: 'warning' }))).toBe(
      false,
    );
    expect(blocksAiring(ContinuityIssue.parse({ ...continuityIssue, severity: 'info' }))).toBe(
      false,
    );
  });
});

// ── retrieval ───────────────────────────────────────────────────────────────

describe('retrieval weights and the always-included set', () => {
  it('defaults to the weighting in the domain model, summing to one', () => {
    const parsed = RetrievalWeights.parse({});
    expect(parsed).toEqual(DEFAULT_RETRIEVAL_WEIGHTS);
    const total = Object.values(parsed).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('includes the four unconditional items by default', () => {
    expect(AlwaysIncluded.parse({})).toEqual(DEFAULT_ALWAYS_INCLUDED);
    expect(DEFAULT_ALWAYS_INCLUDED).toEqual({
      seriesPremise: true,
      episodeOutline: true,
      presentCharacterSheets: true,
      povEpistemicView: true,
    });
  });

  it('rejects a weight outside 0..1', () => {
    expect(failurePaths(RetrievalWeights.safeParse({ graphProximity: 2 }))).toEqual([
      'graphProximity',
    ]);
  });
});

describe('MemoryRetrievalRequest', () => {
  it('fills the object-level defaults completely, not partially', () => {
    const parsed = MemoryRetrievalRequest.parse(retrievalRequest);
    // Zod's `.default()` returns the value without re-parsing, so a partial default
    // object would silently produce partial weights. Assert the whole thing.
    expect(parsed.weights).toEqual(DEFAULT_RETRIEVAL_WEIGHTS);
    expect(parsed.alwaysInclude).toEqual(DEFAULT_ALWAYS_INCLUDED);
    expect(parsed.tokenBudget).toBe(8_000);
    expect(parsed.maxHops).toBe(2);
    expect(parsed.sceneEntities).toEqual([]);
    expect(parsed.povEntityId).toBeNull();
    expect(parsed.visibility).toEqual([]);
  });

  it('takes the scene entities the proximity walk starts from and a POV character', () => {
    const parsed = MemoryRetrievalRequest.parse({
      ...retrievalRequest,
      sceneEntities: [ARIA, KAEL],
      povEntityId: KAEL,
      maxHops: 3,
      tokenBudget: 12_000,
      weights: { ...DEFAULT_RETRIEVAL_WEIGHTS, isOpenLoop: 0.4 },
      alwaysInclude: { ...DEFAULT_ALWAYS_INCLUDED, presentCharacterSheets: false },
    });
    expect(parsed.povEntityId).toBe(KAEL);
    expect(parsed.weights.isOpenLoop).toBe(0.4);
    expect(parsed.alwaysInclude.presentCharacterSheets).toBe(false);
  });

  it('caps the proximity walk, because past three hops the graph stops discriminating', () => {
    expect(
      failurePaths(MemoryRetrievalRequest.safeParse({ ...retrievalRequest, maxHops: 9 })),
    ).toEqual(['maxHops']);
  });

  it('rejects a non-positive token budget', () => {
    expect(
      failurePaths(MemoryRetrievalRequest.safeParse({ ...retrievalRequest, tokenBudget: 0 })),
    ).toEqual(['tokenBudget']);
  });
});

describe('MemoryRetrievalResult', () => {
  const result = {
    seriesId: SERIES_ID,
    sceneId: SCENE_ID,
    stateHash: STATE_HASH,
    weights: DEFAULT_RETRIEVAL_WEIGHTS,
    tokenBudget: 8_000,
    tokensUsed: 0,
  };

  it('defaults to an empty, untruncated, POV-less result', () => {
    const parsed = MemoryRetrievalResult.parse(result);
    expect(parsed.facts).toEqual([]);
    expect(parsed.droppedForBudget).toEqual([]);
    expect(parsed.epistemicView).toBeNull();
    expect(parsed.truncated).toBe(false);
  });

  it('records why each fact was included, and what was dropped for budget', () => {
    const parsed = MemoryRetrievalResult.parse({
      ...result,
      tokensUsed: 7_980,
      truncated: true,
      facts: [
        {
          ...retrievedFact,
          reason: 'always',
          rank: 0,
          score: 1,
          ref: { kind: 'premise', seriesId: SERIES_ID },
        },
        retrievedFact,
      ],
      droppedForBudget: [
        { ...retrievedFact, reason: 'dropped-over-budget', rank: 41, score: 0.11 },
      ],
    });
    expect(parsed.facts.at(0)?.reason).toBe('always');
    expect(parsed.facts.at(1)?.breakdown.graphProximity).toBe(1);
    expect(parsed.droppedForBudget.at(0)?.rank).toBe(41);
    expect(parsed.truncated).toBe(true);
  });

  it('discriminates every source a fact can come from', () => {
    const refs = [
      { kind: 'relation', relationId: relationId('0040') },
      { kind: 'entity', entityId: ARIA },
      { kind: 'scene', sceneId: SCENE_ID },
      { kind: 'episode-summary', episodeId: EPISODE_ID },
      { kind: 'open-loop', openLoopId: LOOP_ID },
      { kind: 'premise', seriesId: SERIES_ID },
    ];
    for (const ref of refs) {
      expect(MemoryFactRef.parse(ref).kind).toBe(ref.kind);
    }
    expect(failurePaths(MemoryFactRef.safeParse({ kind: 'rumour' }))).toEqual(['kind']);
    // A ref carrying the wrong id for its kind is caught, not coerced.
    expect(
      failurePaths(MemoryFactRef.safeParse({ kind: 'entity', entityId: relationId('0041') })),
    ).toEqual(['entityId']);
  });

  it('rejects a score breakdown component outside 0..1', () => {
    expect(
      failurePaths(
        RetrievedFact.safeParse({
          ...retrievedFact,
          breakdown: { ...retrievedFact.breakdown, storyRecency: -0.1 },
        }),
      ),
    ).toEqual(['breakdown.storyRecency']);
  });
});

// ── compaction ──────────────────────────────────────────────────────────────

describe('the compaction ladder', () => {
  const episodeSummary = {
    episodeId: EPISODE_ID,
    seasonId: SEASON_ID,
    seriesId: SERIES_ID,
    index: 4,
    title: 'The Winter Charter',
    logline: 'A clerk discovers the debt she is paying was never hers.',
    synopsis: 'Aria works the charter queue while Kael asks the wrong people the right question.',
    storySpan: { from: { ordinal: 400 }, until: { ordinal: 500 } },
  };

  it('summarises an episode and starts unfrozen', () => {
    const parsed = EpisodeSummary.parse(episodeSummary);
    expect(parsed.canonFrozen).toBe(false);
    expect(parsed.beats).toEqual([]);
    expect(parsed.openLoopsPlanted).toEqual([]);
  });

  it('freezes canon once the episode has aired', () => {
    const parsed = EpisodeSummary.parse({
      ...episodeSummary,
      canonFrozen: true,
      beats: ['Aria refuses to sign.', 'Kael finds the old manifest.'],
      openLoopsPlanted: [LOOP_ID],
    });
    expect(parsed.canonFrozen).toBe(true);
    expect(parsed.beats).toHaveLength(2);
  });

  it('summarises a season, including arcs that did not move', () => {
    const parsed = SeasonSummary.parse({
      seasonId: SEASON_ID,
      seriesId: SERIES_ID,
      index: 0,
      title: 'Tallow Reach',
      throughline: 'Who owns the quay, and what owning it costs.',
      synopsis: 'Eight episodes of paperwork and one drowning.',
      storySpan: { from: { ordinal: 0 }, until: { ordinal: 800 } },
      episodes: [EPISODE_ID],
      arcsAdvanced: [
        {
          entityId: KAEL,
          from: 'Asks nobody anything.',
          to: 'Asks nobody anything.',
          moved: false,
        },
        { entityId: ARIA, from: 'Signs everything.', to: 'Signs nothing.' },
      ],
      openLoopsCarried: [LOOP_ID],
    });
    expect(parsed.arcsAdvanced.at(0)?.moved).toBe(false);
    expect(parsed.arcsAdvanced.at(1)?.moved).toBe(true);
  });

  it('summarises the series and tracks how far canon has been frozen', () => {
    const parsed = SeriesSummary.parse({
      seriesId: SERIES_ID,
      premise: 'A harbour clerk inherits a debt that will drown her if she pays it.',
      synopsis: 'One season aired.',
      toneNote: 'Dry, procedural, and quietly furious.',
      storySpan: { from: null, until: null },
      themes: ['inheritance', 'paperwork'],
      rulesOfTheWorld: ['A berth right is held by the name on the winter charter.'],
      seasons: [SEASON_ID],
      principalCast: [ARIA, KAEL],
      openLoops: [LOOP_ID],
      canonThroughEpisode: EPISODE_ID,
    });
    expect(parsed.canonThroughEpisode).toBe(EPISODE_ID);
    expect(
      SeriesSummary.parse({
        seriesId: SERIES_ID,
        premise: 'x',
        synopsis: 'y',
        toneNote: 'z',
        storySpan: { from: null, until: null },
      }).canonThroughEpisode,
    ).toBeNull();
  });
});

// ── structured output ───────────────────────────────────────────────────────

describe('JSON Schema conversion', () => {
  const fillable = {
    StateDelta,
    WorldStateSnapshot,
    OpenLoop,
    ContinuityIssue,
    MemoryRetrievalRequest,
    MemoryRetrievalResult,
    RetrievedFact,
    RetrievalWeights,
    AlwaysIncluded,
    EpisodeSummary,
    SeasonSummary,
    SeriesSummary,
  };

  it.each(Object.entries(fillable))(
    '%s converts to a closed JSON Schema object',
    (_name, schema) => {
      const json = z.toJSONSchema(schema, { io: 'input' });
      expect(json.type).toBe('object');
      expect(json.additionalProperties).toBe(false);
    },
  );

  it('converts the fact-source union to closed branches', () => {
    const json = z.toJSONSchema(MemoryFactRef, { io: 'input' });
    const branches = json.oneOf ?? [];
    // One branch per member of the union. Asserted as a count rather than a shape so
    // that adding a source without closing it fails here.
    expect(branches).toHaveLength(MemoryFactRef.options.length);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it('keeps the retrieval weights documented for the model that tunes them', () => {
    const json = z.toJSONSchema(MemoryRetrievalRequest, { io: 'input' });
    expect(
      schemaAt(json, 'properties', 'weights', 'properties', 'isOpenLoop').description,
    ).toContain('unpaid');
    expect(json.required).toEqual(['seriesId', 'episodeId', 'sceneId', 'at', 'asOf', 'sceneGoal']);
  });
});

// ── the snapshot's own internal references ──────────────────────────────────
//
// The IR and the rig refuse a dangling internal reference; the narrative schemas did
// not. A snapshot is the one place a keyed epistemic view can be checked against the
// key it is filed under, and getting that wrong hands the scene writer the wrong head.

describe('WorldStateSnapshot internal references', () => {
  const snapshot = { seriesId: SERIES_ID, at: { ordinal: 500 }, asOf: NOW, stateHash: STATE_HASH };

  function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      seriesId: SERIES_ID,
      viewerId: KAEL,
      at: { ordinal: 500 },
      asOf: NOW,
      ...overrides,
    };
  }

  it('accepts a view filed under the character whose head it is', () => {
    expect(
      WorldStateSnapshot.safeParse({ ...snapshot, knowledge: { [KAEL]: view() } }).success,
    ).toBe(true);
  });

  it("rejects a view filed under somebody else's id", () => {
    expect(
      failurePaths(WorldStateSnapshot.safeParse({ ...snapshot, knowledge: { [ARIA]: view() } })),
    ).toEqual([`knowledge.${ARIA}.viewerId`]);
  });

  it('rejects a view resolved at a different story time than the snapshot it sits in', () => {
    expect(
      failurePaths(
        WorldStateSnapshot.safeParse({
          ...snapshot,
          knowledge: { [KAEL]: view({ at: { ordinal: 780 } }) },
        }),
      ),
    ).toEqual([`knowledge.${KAEL}.at`]);
  });

  it('reports both mistakes independently when a view is wrong on both counts', () => {
    expect(
      failurePaths(
        WorldStateSnapshot.safeParse({
          ...snapshot,
          knowledge: { [ARIA]: view({ at: { ordinal: 780 } }) },
        }),
      ),
    ).toEqual([`knowledge.${ARIA}.viewerId`, `knowledge.${ARIA}.at`]);
  });
});

describe('an abandoned promise says why', () => {
  it('rejects a loop abandoned without a reason', () => {
    expect(failurePaths(OpenLoop.safeParse({ ...openLoop, status: 'abandoned' }))).toEqual([
      'abandonedReason',
    ]);
  });

  it('leaves an open loop free of the requirement', () => {
    expect(OpenLoop.parse(openLoop).abandonedReason).toBeUndefined();
  });
});

describe('an always-included fact is recognisably unconditional', () => {
  const always = { ...retrievedFact, reason: 'always', rank: 0, score: 1 };

  it('accepts rank 0 and score 1, as the descriptions promise', () => {
    expect(RetrievedFact.parse(always).reason).toBe('always');
  });

  it('rejects an always-included fact that carries a scored rank', () => {
    expect(failurePaths(RetrievedFact.safeParse({ ...always, rank: 3 }))).toEqual(['rank']);
  });

  it('rejects an always-included fact that carries a computed score', () => {
    expect(failurePaths(RetrievedFact.safeParse({ ...always, score: 0.72 }))).toEqual(['score']);
  });

  it('leaves a scored fact free to be ranked and scored anywhere', () => {
    expect(RetrievedFact.safeParse(retrievedFact).success).toBe(true);
    expect(
      RetrievedFact.safeParse({ ...retrievedFact, reason: 'dropped-over-budget' }).success,
    ).toBe(true);
  });
});

// ── the two ids on a retrieved fact cannot disagree ─────────────────────────
//
// `RetrievedFact` carries a `factId` and a discriminated `ref`, and until `Fact`
// existed neither could be resolved to anything, so nothing noticed when they named
// different things. Now that both resolve, a row whose `ref` points at fact A while
// `factId` says B is a specific and nasty bug: the prompt gets A's sentence, the
// retrieval log records B, and a later `ContinuityIssue` quoting B points at a fact
// the writer was never shown.

describe('a retrieved fact agrees with its own reference', () => {
  it('resolves a memory fact by id, which is the ordinary case now that Fact exists', () => {
    const parsed = RetrievedFact.parse({
      ...retrievedFact,
      ref: { kind: 'fact', factId: FACT_ID },
    });
    expect(parsed.ref).toEqual({ kind: 'fact', factId: FACT_ID });
    expect(parsed.factId).toBe(FACT_ID);
  });

  it('rejects a fact reference that names a different fact from factId', () => {
    const result = RetrievedFact.safeParse({
      ...retrievedFact,
      factId: FACT_ID,
      ref: { kind: 'fact', factId: OTHER_FACT_ID },
    });
    expect(failurePaths(result)).toEqual(['ref.factId']);
  });

  it('leaves the synthesised kinds alone, which deliberately name something else', () => {
    // A candidate cut from an entity sheet or the premise has a `factId` of its own and
    // a `ref` that points at neither a `Fact` row nor the same id. Requiring agreement
    // there would forbid the entire always-included set.
    for (const ref of [
      { kind: 'relation', relationId: relationId('0030') },
      { kind: 'entity', entityId: ARIA },
      { kind: 'premise', seriesId: SERIES_ID },
    ]) {
      expect(RetrievedFact.safeParse({ ...retrievedFact, ref }).success, ref.kind).toBe(true);
    }
  });

  it('offers a case for every kind of thing retrieval can hand a writer', () => {
    expect(MemoryFactRef.options.map((option) => option.shape.kind.value)).toEqual([
      'fact',
      'relation',
      'entity',
      'scene',
      'episode-summary',
      'open-loop',
      'premise',
    ]);
  });
});
