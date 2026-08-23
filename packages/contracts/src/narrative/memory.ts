/**
 * Narrative memory - deltas, snapshots, open loops, continuity, retrieval, compaction.
 *
 * The graph in `relation.ts` stores what is true. This file stores everything built
 * *on top* of it: what one scene changed, what the world looks like at a moment, what
 * the story has promised and not yet paid, what contradicts what, and - the part that
 * decides whether any of it is usable - which slice of it fits in a prompt.
 *
 * The shape is dictated by two constraints. Context windows are finite, so retrieval
 * is a budgeted selection rather than a dump. And CLAUDE.md §1.1 requires the
 * pipeline to be replayable, so that selection must be a pure function of the graph
 * state: same state, same request, same facts, in the same order.
 */

import { z } from 'zod';

import {
  Confidence,
  IsoInstant,
  Label,
  NonNegativeInt,
  PositiveInt,
  Prose,
  Sha256Hex,
  StoryInterval,
  StoryTime,
  Unit01,
} from '../primitives/common';
import {
  EntityId,
  EpisodeId,
  FactId,
  IssueId,
  OpenLoopId,
  RelationId,
  SceneId,
  SeasonId,
  SeriesId,
} from '../primitives/ids';
import { Importance } from './entity';
import { AudienceVisibility, EpistemicView } from './relation';

// ── what a scene changed ────────────────────────────────────────────────────

export const ENTITY_STATUSES = [
  'alive',
  'dead',
  'missing',
  'destroyed',
  'unborn',
  'transformed',
] as const;

/**
 * The one piece of world state the rule pass cannot infer from edges.
 *
 * "Dead characters acting" is the cheapest and most embarrassing continuity error to
 * catch, and catching it needs a status that is asserted rather than derived - a
 * character with no edges after episode 4 is not thereby dead.
 */
export const EntityStatus = z.enum(ENTITY_STATUSES).describe("An entity's condition in the world.");
export type EntityStatus = z.infer<typeof EntityStatus>;

export const VitalityChange = z.strictObject({
  entityId: EntityId,
  to: EntityStatus,
  note: Prose.optional().describe('How it happened, when that matters later.'),
});
export type VitalityChange = z.infer<typeof VitalityChange>;

export const PositionChange = z.strictObject({
  entityId: EntityId.describe('Who or what moved.'),
  from: EntityId.nullable()
    .default(null)
    .describe('The location entity left. `null` if offscreen.'),
  to: EntityId.nullable().describe('The location entity arrived at. `null` means "left the map".'),
  note: Prose.optional().describe('How they travelled, when the timeline pass needs it.'),
});
export type PositionChange = z.infer<typeof PositionChange>;

export const POSSESSION_MODES = [
  'given',
  'taken',
  'found',
  'lost',
  'destroyed',
  'created',
] as const;
export const PossessionMode = z.enum(POSSESSION_MODES);
export type PossessionMode = z.infer<typeof PossessionMode>;

export const PossessionChange = z.strictObject({
  itemId: EntityId.describe('The prop, vehicle or substance that changed hands.'),
  from: EntityId.nullable().describe('Previous holder. `null` when it had none.'),
  to: EntityId.nullable().describe('New holder. `null` when it was dropped, lost or destroyed.'),
  mode: PossessionMode,
});
export type PossessionChange = z.infer<typeof PossessionChange>;

export const KNOWLEDGE_CHANGE_KINDS = [
  'learned',
  'suspected',
  'disproved',
  'forgot',
  'told',
] as const;
export const KnowledgeChangeKind = z.enum(KNOWLEDGE_CHANGE_KINDS);
export type KnowledgeChangeKind = z.infer<typeof KnowledgeChangeKind>;

/**
 * A change to what someone believes.
 *
 * Recorded separately from the fact itself, because a reveal is not a change to the
 * world - it is a change to exactly one character's model of it, and the whole point
 * of the epistemic layer is that those two things move independently.
 */
export const KnowledgeChange = z.strictObject({
  knowerId: EntityId.describe('Whose model of the world changed.'),
  change: KnowledgeChangeKind,
  proposition: Prose.describe('What they now hold, as they would state it.'),
  aboutRelationId: RelationId.optional().describe(
    'The edge this belief concerns, when there is one.',
  ),
  learnedFrom: EntityId.optional().describe(
    'Who conveyed it. Absent for `found out for themselves`.',
  ),
});
export type KnowledgeChange = z.infer<typeof KnowledgeChange>;

/**
 * Everything one scene changed about the world.
 *
 * The unit of folding: a `WorldStateSnapshot` at any story time is the ordered
 * application of every delta up to it, which is why the delta records changes rather
 * than resulting state. It is also the extraction target for a written scene, so the
 * fields are the questions the extractor is asked, in the order it is asked them.
 */
export const StateDelta = z.strictObject({
  sceneId: SceneId,
  episodeId: EpisodeId,
  seriesId: SeriesId,
  at: StoryTime.describe('When this scene sits on the series timeline.'),
  entitiesIntroduced: z
    .array(EntityId)
    .max(64)
    .default([])
    .describe('Entities that exist on screen for the first time here.'),
  relationsAsserted: z
    .array(RelationId)
    .max(256)
    .default([])
    .describe('Edges this scene brought into being.'),
  relationsRetracted: z
    .array(RelationId)
    .max(256)
    .default([])
    .describe(
      'Edges this scene ended. Story-time endings; an authoring-time retraction is not a scene event.',
    ),
  positionChanges: z.array(PositionChange).max(64).default([]),
  possessionChanges: z.array(PossessionChange).max(64).default([]),
  knowledgeChanges: z.array(KnowledgeChange).max(128).default([]),
  vitalityChanges: z.array(VitalityChange).max(64).default([]),
  openLoopsPlanted: z
    .array(OpenLoopId)
    .max(32)
    .default([])
    .describe('Setups this scene planted, so the planner can chase them later.'),
  openLoopsPaid: z.array(OpenLoopId).max(32).default([]),
});
export type StateDelta = z.infer<typeof StateDelta>;

// ── the world at a moment ───────────────────────────────────────────────────

export const EntityStateEntry = z.strictObject({
  entityId: EntityId,
  status: EntityStatus.default('alive'),
  importance: Importance.default('background').describe(
    'Copied from the entity so the snapshot can be ranked without loading the graph.',
  ),
});
export type EntityStateEntry = z.infer<typeof EntityStateEntry>;

/**
 * The world, resolved at one point on each clock.
 *
 * Folded from deltas rather than stored, and cached by `(at, asOf, stateHash)`. It
 * carries both clock positions for the same reason a `Relation` does: a snapshot of
 * episode 2 taken before a retro-fit and one taken after are both correct, and
 * telling them apart is the entire value of the bi-temporal store.
 */
export const WorldStateSnapshot = z
  .strictObject({
    seriesId: SeriesId,
    at: StoryTime.describe('The story-time point this is a snapshot of.'),
    asOf: IsoInstant.describe('The authoring-time point it was folded at.'),
    stateHash: Sha256Hex.describe(
      'Hash of the graph state this was folded from. Two snapshots with the same hash are byte-identical, which is what makes a replayed run cheap and verifiable.',
    ),
    entities: z
      .array(EntityStateEntry)
      .max(4096)
      .default([])
      .describe('Every known entity with its status here. Filter on `alive` for "who is living".'),
    positions: z
      .record(EntityId, EntityId)
      .default({})
      .describe('Entity id -> the location entity it is in.'),
    possessions: z
      .record(EntityId, z.array(EntityId))
      .default({})
      .describe('Holder entity id -> the item entity ids they hold.'),
    knowledge: z
      .record(EntityId, EpistemicView)
      .default({})
      .describe(
        'Character entity id -> what that character knows here. Keyed for O(1) lookup because the hot path is "hand the scene writer the POV character\'s view".',
      ),
  })
  .superRefine((snapshot, ctx) => {
    // The key and the view's own `viewerId` are two spellings of the same fact, and the
    // map is only usable if they agree. If they do not, the hot path - "hand the scene
    // writer the POV character's view" - hands over somebody else's head, and the
    // failure reads as a character who knows something they were never told, which is
    // the exact bug the epistemic layer exists to prevent. `at` is echoed into every
    // view for the same reason: a snapshot folded at one story time holding a view
    // resolved at another is not a snapshot of anything.
    for (const [entityId, view] of Object.entries(snapshot.knowledge)) {
      if (view.viewerId !== entityId) {
        ctx.addIssue({
          code: 'custom',
          path: ['knowledge', entityId, 'viewerId'],
          message: `knowledge is filed under ${entityId} but the view belongs to ${view.viewerId}`,
        });
      }
      if (view.at.ordinal !== snapshot.at.ordinal) {
        ctx.addIssue({
          code: 'custom',
          path: ['knowledge', entityId, 'at'],
          message: `view resolved at story time ${String(view.at.ordinal)} inside a snapshot of ${String(snapshot.at.ordinal)}`,
        });
      }
    }
  });
export type WorldStateSnapshot = z.infer<typeof WorldStateSnapshot>;

// ── open loops ──────────────────────────────────────────────────────────────

export const OPEN_LOOP_STATUSES = ['open', 'paid', 'abandoned'] as const;
export const OpenLoopStatus = z.enum(OPEN_LOOP_STATUSES);
export type OpenLoopStatus = z.infer<typeof OpenLoopStatus>;

/**
 * A promise made to the audience, and whether it has been kept.
 *
 * Tracked as first-class data because an unpaid setup is invisible to every other
 * check: nothing contradicts it, no rule fires, the episode passes continuity and the
 * audience still feels cheated. It also earns its own weight in the retrieval score -
 * an unpaid setup is the fact most worth spending prompt budget on, because it is the
 * one the planner is most likely to forget.
 */
export const OpenLoop = z
  .strictObject({
    id: OpenLoopId,
    seriesId: SeriesId,
    setup: Prose.describe('What was planted, as it appeared on screen.'),
    promise: Prose.describe(
      'What the audience now believes we owe them. Write it as the expectation, not the plant.',
    ),
    plantedAt: StoryTime,
    plantedIn: z.strictObject({
      episodeId: EpisodeId,
      sceneId: SceneId.optional(),
    }),
    entities: z.array(EntityId).max(32).default([]).describe('Who and what the setup involves.'),
    relations: z
      .array(RelationId)
      .max(32)
      .default([])
      .describe('The `foreshadows` edges that carry it.'),
    expectedPayoff: StoryInterval.describe(
      'The window in story time by which this should land. `until: null` means "before the series ends"; a loop with no `until` and a distant `from` is how a series accumulates debt it cannot pay.',
    ),
    urgency: Unit01.default(0.5).describe(
      'How loudly the audience is waiting. Feeds the retrieval score directly.',
    ),
    status: OpenLoopStatus.default('open'),
    paidIn: z
      .strictObject({
        episodeId: EpisodeId,
        sceneId: SceneId.optional(),
        at: StoryTime,
      })
      .nullable()
      .default(null)
      .describe('Where the payoff landed. Required once `status` is "paid".'),
    abandonedReason: Prose.optional().describe(
      'Why we are choosing not to pay this. Recorded so the decision is deliberate rather than forgotten.',
    ),
  })
  .superRefine((loop, ctx) => {
    if (loop.status === 'paid' && loop.paidIn === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['paidIn'],
        message: 'a paid open loop must record where it was paid',
      });
    }
    // The mirror of the check above, and it was missing. `abandonedReason` exists so
    // the decision not to pay is "deliberate rather than forgotten" - a loop that
    // silently flips to `abandoned` with no reason is precisely the forgotten case.
    if (loop.status === 'abandoned' && loop.abandonedReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['abandonedReason'],
        message: 'an abandoned open loop must say why the promise is not being kept',
      });
    }
  });
export type OpenLoop = z.infer<typeof OpenLoop>;

// ── continuity ──────────────────────────────────────────────────────────────

export const CONTINUITY_SEVERITIES = ['error', 'warning', 'info'] as const;

/**
 * How badly this matters.
 *
 * `error` blocks the transition to `AIRED`; `warning` and `info` do not. That is the
 * whole contract, and it is why severity is an enum on the finding rather than a
 * judgement call at the call site.
 */
export const ContinuitySeverity = z.enum(CONTINUITY_SEVERITIES);
export type ContinuitySeverity = z.infer<typeof ContinuitySeverity>;

export const CONTINUITY_RULES = [
  'dead-character-acting',
  'object-in-two-places',
  'character-in-two-places',
  'timeline-inversion',
  'knowledge-without-source',
  'wardrobe-mismatch',
  'prop-mismatch',
  'age-arithmetic',
  'aired-canon-contradiction',
  'world-rule-broken',
  'unpaid-open-loop',
  'tone-drift',
  'motivation-contradiction',
  'arc-regression',
] as const;

/**
 * The rule that fired, named.
 *
 * A closed list rather than free text: the UI groups by it, the operator suppresses
 * by it, and a finding whose rule cannot be named is a finding nobody can act on. The
 * first eleven are decided by the cheap exact pass; the last three need the LLM.
 */
export const ContinuityRule = z.enum(CONTINUITY_RULES);
export type ContinuityRule = z.infer<typeof ContinuityRule>;

export const CONTINUITY_DETECTORS = ['rule', 'llm'] as const;
export const ContinuityDetector = z.enum(CONTINUITY_DETECTORS);
export type ContinuityDetector = z.infer<typeof ContinuityDetector>;

/**
 * One contradiction, stated so a human can act on it in one read.
 *
 * `explanation` and `suggestedFix` are separate fields on purpose: the first is what
 * went wrong, the second is what to do, and collapsing them produces findings that
 * describe a problem nobody knows how to close.
 */
export const ContinuityIssue = z
  .strictObject({
    id: IssueId,
    seriesId: SeriesId,
    episodeId: EpisodeId.describe(
      'The episode being checked - not necessarily where the fact came from.',
    ),
    sceneId: SceneId.optional().describe('The scene that tripped the rule, when it is one scene.'),
    severity: ContinuitySeverity,
    rule: ContinuityRule,
    detectedBy: ContinuityDetector.default('rule').describe(
      'Which pass found it. The rule pass is exact and free; the LLM pass is neither.',
    ),
    entities: z
      .array(EntityId)
      .max(32)
      .default([])
      .describe('Everyone and everything involved, so the UI can jump straight to them.'),
    conflictingFacts: z
      .array(FactId)
      .max(32)
      .default([])
      .describe(
        'The facts that cannot all be true, by id. At least two, for anything but an open-loop finding. Each resolves to a `Fact` (`narrative/fact.ts`), and `factRelationId` turns the relation-backed ones back into graph edges the UI can highlight - which is what makes a finding actionable rather than a sentence.',
      ),
    explanation: Prose.describe(
      'What is wrong, in one paragraph, naming both sides of the conflict. Written for a human at 2am.',
    ),
    suggestedFix: Prose.optional().describe(
      'The smallest edit that resolves it. Absent when the checker genuinely has no proposal.',
    ),
    confidence: Confidence.default(1).describe('1 for rule findings; lower for the LLM pass.'),
  })
  .superRefine((issue, ctx) => {
    // "At least two, for anything but an open-loop finding" was stated in the field
    // description and enforced nowhere. It matters because SC-9 requires the error to
    // *name the conflicting facts*: a contradiction finding carrying one fact, or none,
    // cannot say what it contradicts, and the operator is left to find the other half.
    // `unpaid-open-loop` is the documented exception - nothing contradicts a promise
    // nobody kept.
    if (issue.rule !== 'unpaid-open-loop' && issue.conflictingFacts.length < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['conflictingFacts'],
        message: `a ${issue.rule} finding must name both sides of the conflict`,
      });
    }
  });
export type ContinuityIssue = z.infer<typeof ContinuityIssue>;

/**
 * Whether this finding stops the episode airing.
 *
 * A function rather than a field so the rule lives in one place: an `error` blocks,
 * everything else informs (docs/02 §4).
 */
export function blocksAiring(issue: ContinuityIssue): boolean {
  return issue.severity === 'error';
}

// ── budgeted hybrid retrieval ───────────────────────────────────────────────

/**
 * Where a retrieved fact came from.
 *
 * Discriminated because the assembler renders each source differently - a relation
 * becomes a sentence, an entity becomes a sheet, an episode summary becomes a
 * paragraph - and because a debugger showing "fact #7 scored 0.81" is useless unless
 * it can also link to the thing.
 *
 * The `fact` case is the ordinary one now that `Fact` exists: a candidate the retriever
 * pulled from narrative memory refers to the memory row it came from, and every other
 * case is a fact that was *synthesised* out of something the store holds in another
 * shape - an entity sheet, a scene body, the premise. Every member resolves to a schema
 * in this package; a `MemoryFactRef` that could not be followed back to a document was
 * the defect this case closes.
 */
export const MemoryFactRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fact'), factId: FactId }),
  z.strictObject({ kind: z.literal('relation'), relationId: RelationId }),
  z.strictObject({ kind: z.literal('entity'), entityId: EntityId }),
  z.strictObject({ kind: z.literal('scene'), sceneId: SceneId }),
  z.strictObject({ kind: z.literal('episode-summary'), episodeId: EpisodeId }),
  z.strictObject({ kind: z.literal('open-loop'), openLoopId: OpenLoopId }),
  z.strictObject({ kind: z.literal('premise'), seriesId: SeriesId }),
]);
export type MemoryFactRef = z.infer<typeof MemoryFactRef>;

/**
 * The scoring weights from docs/02 §4.
 *
 * Exported as a plain constant as well as a schema so the schema's per-field defaults
 * and the object-level default cannot drift apart - Zod's `.default()` hands back the
 * value without re-parsing it, so a partial default object would silently produce
 * partial weights.
 */
export const DEFAULT_RETRIEVAL_WEIGHTS = {
  graphProximity: 0.3,
  semanticSimilarity: 0.25,
  storyRecency: 0.15,
  importance: 0.15,
  isOpenLoop: 0.15,
} as const;

export const RetrievalWeights = z.strictObject({
  graphProximity: Unit01.default(DEFAULT_RETRIEVAL_WEIGHTS.graphProximity).describe(
    'Weight on k-hop distance from the entities present in this scene.',
  ),
  semanticSimilarity: Unit01.default(DEFAULT_RETRIEVAL_WEIGHTS.semanticSimilarity).describe(
    'Weight on embedding similarity to the scene goal.',
  ),
  storyRecency: Unit01.default(DEFAULT_RETRIEVAL_WEIGHTS.storyRecency).describe(
    'Weight on how recently, in story time, the fact was established.',
  ),
  importance: Unit01.default(DEFAULT_RETRIEVAL_WEIGHTS.importance).describe(
    'Weight on the importance of the entities the fact touches.',
  ),
  isOpenLoop: Unit01.default(DEFAULT_RETRIEVAL_WEIGHTS.isOpenLoop).describe(
    'Weight on the fact being an unpaid setup. Unpaid setups are what a planner forgets first.',
  ),
});
export type RetrievalWeights = z.infer<typeof RetrievalWeights>;

/**
 * The unconditional floor of the context.
 *
 * These four go in before scoring begins and are never traded against the budget: a
 * scene written without the premise, the outline, the sheets of the characters in it,
 * or the POV character's view of the world is not a scene that can be fixed by having
 * more facts. Switchable only so that a diagnostic can prove what each one is worth.
 */
export const DEFAULT_ALWAYS_INCLUDED = {
  seriesPremise: true,
  episodeOutline: true,
  presentCharacterSheets: true,
  povEpistemicView: true,
} as const;

export const AlwaysIncluded = z.strictObject({
  seriesPremise: z.boolean().default(DEFAULT_ALWAYS_INCLUDED.seriesPremise),
  episodeOutline: z.boolean().default(DEFAULT_ALWAYS_INCLUDED.episodeOutline),
  presentCharacterSheets: z.boolean().default(DEFAULT_ALWAYS_INCLUDED.presentCharacterSheets),
  povEpistemicView: z.boolean().default(DEFAULT_ALWAYS_INCLUDED.povEpistemicView),
});
export type AlwaysIncluded = z.infer<typeof AlwaysIncluded>;

/**
 * "Assemble the context for writing this scene."
 *
 * Every input to the selection is named here, and nothing else may influence it -
 * that is what makes the result reproducible, and therefore testable, and therefore
 * safe to cache. Note that `povEntityId` is not a nicety: it selects whose epistemic
 * view is loaded, and getting it wrong is how a character learns something offscreen.
 */
export const MemoryRetrievalRequest = z.strictObject({
  seriesId: SeriesId,
  episodeId: EpisodeId,
  sceneId: SceneId,
  at: StoryTime.describe('The story-time point the scene plays at.'),
  asOf: IsoInstant.describe('The authoring-time point to resolve the graph against.'),
  sceneGoal: Prose.describe(
    'What this scene has to accomplish. Embedded and compared against every candidate fact, so state the dramatic objective, not the blocking.',
  ),
  sceneEntities: z
    .array(EntityId)
    .max(64)
    .default([])
    .describe('Who and what is present. The graph-proximity walk starts from these.'),
  povEntityId: EntityId.nullable()
    .default(null)
    .describe('Whose epistemic view to load. `null` only for a scene with no character in it.'),
  maxHops: NonNegativeInt.max(4)
    .default(2)
    .describe('How far the proximity walk goes. Above 3 the graph stops discriminating.'),
  weights: RetrievalWeights.default(DEFAULT_RETRIEVAL_WEIGHTS),
  tokenBudget: PositiveInt.max(1_000_000)
    .default(8_000)
    .describe(
      'Tokens the scored facts may occupy. The always-included set is charged against it first.',
    ),
  alwaysInclude: AlwaysIncluded.default(DEFAULT_ALWAYS_INCLUDED),
  visibility: z
    .array(AudienceVisibility)
    .max(3)
    .default([])
    .describe('Restrict candidate facts to these visibilities. Empty means every visibility.'),
});
export type MemoryRetrievalRequest = z.infer<typeof MemoryRetrievalRequest>;

/** The five component scores, before weighting. Kept so a total can be re-derived. */
export const RetrievalScoreBreakdown = z.strictObject({
  graphProximity: Unit01,
  semanticSimilarity: Unit01,
  storyRecency: Unit01,
  importance: Unit01,
  isOpenLoop: Unit01,
});
export type RetrievalScoreBreakdown = z.infer<typeof RetrievalScoreBreakdown>;

export const INCLUSION_REASONS = ['always', 'scored', 'dropped-over-budget'] as const;
export const InclusionReason = z.enum(INCLUSION_REASONS);
export type InclusionReason = z.infer<typeof InclusionReason>;

/**
 * One fact, with the arithmetic that put it in or left it out.
 *
 * The breakdown is the point. "Why did the writer not know about the knife?" has to
 * be answerable without re-running anything, and it only is if each candidate carries
 * its component scores, its rank and its token cost.
 *
 * `factId` and `ref` are both here and are not redundant. `factId` is what the
 * retrieval log, the cache key and any later `ContinuityIssue` cite; `ref` is what the
 * assembler renders and what the debugger links to, and for a synthesised candidate -
 * an entity sheet, the premise - it points at something that is not a `Fact` row at
 * all. They may differ in *kind*; what they may not do is contradict each other, which
 * is what the refinement below is for.
 */
export const RetrievedFact = z
  .strictObject({
    factId: FactId.describe(
      'Identity of this candidate in the memory store, and the id a continuity finding will quote. When `ref.kind` is "fact" it must be that same id.',
    ),
    ref: MemoryFactRef.describe('What to render, and what the debugger links to.'),
    text: Prose.describe('The fact as it will appear in the prompt.'),
    reason: InclusionReason,
    rank: NonNegativeInt.describe('Position in the scored order. 0 for always-included facts.'),
    score: Unit01.describe('The weighted total. 1 for always-included facts.'),
    breakdown: RetrievalScoreBreakdown,
    tokens: NonNegativeInt.describe('What including it costs.'),
  })
  .superRefine((fact, ctx) => {
    // Two ids for one candidate, and nothing was keeping them in step. A row whose
    // `ref` names fact A while `factId` says B is worse than either alone: the prompt
    // gets A's sentence, the log records B, and the continuity finding that later
    // quotes B points at a fact the writer was never shown. Only the `fact` case can be
    // checked here - for every other kind the two deliberately name different things -
    // and that is exactly the case where they can silently disagree.
    if (fact.ref.kind === 'fact' && fact.ref.factId !== fact.factId) {
      ctx.addIssue({
        code: 'custom',
        path: ['ref', 'factId'],
        message: `ref names fact ${fact.ref.factId} but factId is ${fact.factId}`,
      });
    }

    // `rank` and `score` both say "for always-included facts" in their descriptions and
    // neither was checked. The debugger sorts on both, so an always-included fact
    // carrying a scored rank sorts into the middle of the scored list and stops being
    // recognisable as unconditional - which is the one thing its reader needs to know.
    if (fact.reason !== 'always') return;
    if (fact.rank !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rank'],
        message: 'an always-included fact is not ranked; its rank is 0',
      });
    }
    if (fact.score !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['score'],
        message: 'an always-included fact is not scored; its score is 1',
      });
    }
  });
export type RetrievedFact = z.infer<typeof RetrievedFact>;

/**
 * The assembled context, and its own audit trail.
 *
 * `weights` and `stateHash` are echoed back rather than left in the request, so a
 * result found in a log a week later explains itself completely: same `stateHash` and
 * same request means the same facts, and a different set of facts with the same hash
 * is a bug in the retriever rather than a change in the story.
 */
export const MemoryRetrievalResult = z.strictObject({
  seriesId: SeriesId,
  sceneId: SceneId,
  stateHash: Sha256Hex.describe(
    'Hash of the graph state this was resolved against. With the request, it fully determines the output.',
  ),
  facts: z.array(RetrievedFact).max(2048).default([]).describe('Included, in prompt order.'),
  droppedForBudget: z
    .array(RetrievedFact)
    .max(2048)
    .default([])
    .describe(
      'Scored high enough to matter but did not fit. Surfaced in the debugger; raising the budget admits these first.',
    ),
  weights: RetrievalWeights,
  tokenBudget: PositiveInt,
  tokensUsed: NonNegativeInt,
  epistemicView: EpistemicView.nullable()
    .default(null)
    .describe("The POV character's view, loaded unconditionally when there is a POV character."),
  truncated: z
    .boolean()
    .default(false)
    .describe('True when the budget bound the result. Never let this be silent.'),
});
export type MemoryRetrievalResult = z.infer<typeof MemoryRetrievalResult>;

// ── hierarchical compaction ─────────────────────────────────────────────────

/**
 * A finished episode in a page.
 *
 * The bottom rung of the compaction ladder (scene -> episode -> season -> series).
 * Long-range planning reads summaries, never raw scenes: a twelve-episode season is
 * two hundred scenes, and no budget survives loading them.
 */
export const EpisodeSummary = z.strictObject({
  episodeId: EpisodeId,
  seasonId: SeasonId,
  seriesId: SeriesId,
  index: NonNegativeInt.describe('Position within the season, zero-based.'),
  title: Label,
  logline: Prose.describe('One sentence. What the episode is about, not what happens in it.'),
  synopsis: Prose.describe('One paragraph. What happens in it.'),
  beats: z
    .array(Prose)
    .max(64)
    .default([])
    .describe('The beats in story order, one line each. This is what the planner actually reads.'),
  storySpan: StoryInterval.describe('The stretch of story time the episode covers.'),
  entitiesIntroduced: z.array(EntityId).max(64).default([]),
  relationsChanged: z.array(RelationId).max(256).default([]),
  openLoopsPlanted: z.array(OpenLoopId).max(32).default([]),
  openLoopsPaid: z.array(OpenLoopId).max(32).default([]),
  canonFrozen: z
    .boolean()
    .default(false)
    .describe(
      'True once the episode has aired. Facts under a frozen summary may be extended or revealed, never contradicted.',
    ),
});
export type EpisodeSummary = z.infer<typeof EpisodeSummary>;

export const ArcMovement = z.strictObject({
  entityId: EntityId,
  from: Prose.describe('Where the character stood at the start of the span.'),
  to: Prose.describe('Where they stand at the end of it.'),
  moved: z
    .boolean()
    .default(true)
    .describe(
      'False when the arc did not actually move. Recorded rather than omitted, because a lead who stood still for a season is exactly what the planner needs told.',
    ),
});
export type ArcMovement = z.infer<typeof ArcMovement>;

export const SeasonSummary = z.strictObject({
  seasonId: SeasonId,
  seriesId: SeriesId,
  index: NonNegativeInt,
  title: Label,
  throughline: Prose.describe('The one question the season asks and answers.'),
  synopsis: Prose,
  episodes: z.array(EpisodeId).max(128).default([]).describe('In broadcast order.'),
  storySpan: StoryInterval,
  arcsAdvanced: z.array(ArcMovement).max(64).default([]),
  openLoopsCarried: z
    .array(OpenLoopId)
    .max(64)
    .default([])
    .describe('Still unpaid at the end of the season. The debt carried into the next one.'),
});
export type SeasonSummary = z.infer<typeof SeasonSummary>;

/**
 * The whole work in the space a prompt can afford.
 *
 * The top rung, and the one that ships in every single generation call - `premise`
 * and `rulesOfTheWorld` are part of the unconditional always-included set, so this
 * schema's job is to stay small enough that it can be.
 */
export const SeriesSummary = z.strictObject({
  seriesId: SeriesId,
  premise: Prose.describe('The series in one paragraph. Included in every generation call.'),
  synopsis: Prose.describe('Everything that has happened so far, compacted.'),
  themes: z.array(Label).max(12).default([]),
  toneNote: Prose.describe(
    'How it should feel. Read by the LLM continuity pass as the drift baseline.',
  ),
  rulesOfTheWorld: z
    .array(Prose)
    .max(32)
    .default([])
    .describe('Hard constraints on what can happen. Always included, never negotiable.'),
  seasons: z.array(SeasonId).max(64).default([]),
  principalCast: z.array(EntityId).max(64).default([]),
  openLoops: z
    .array(OpenLoopId)
    .max(128)
    .default([])
    .describe('Everything still owed the audience.'),
  storySpan: StoryInterval,
  canonThroughEpisode: EpisodeId.nullable()
    .default(null)
    .describe(
      'The last aired episode. Everything up to it is frozen; everything after is mutable.',
    ),
});
export type SeriesSummary = z.infer<typeof SeriesSummary>;
