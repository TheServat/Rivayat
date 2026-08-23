/**
 * Relations - the edges of the narrative graph, on two clocks.
 *
 * ## Why two clocks
 *
 * Serialised fiction retro-fits its own past. In episode 7 the writers decide that
 * back in episode 2 the mentor was already lying. That decision is not a correction
 * of episode 2; episode 2 is still exactly the episode that aired. It is a *new*
 * statement, made now, about a fact that was true *then*.
 *
 * A store with one clock cannot hold both halves of that. Keep only story time and
 * the edit is indistinguishable from "the mentor started lying in episode 7" -
 * episode 2 silently changes meaning. Keep only authoring time and you know when the
 * decision was made but not what period of the fiction it covers, so the scene writer
 * for a flashback cannot be told what was true during it. Forbid the edit and you
 * have forbidden the single most common move in serial storytelling.
 *
 * So every edge carries both:
 *
 * | Clock | Fields | Question it answers |
 * |---|---|---|
 * | Story time    | `validFrom` / `validUntil`   | When was this true *inside the fiction*? |
 * | Authoring time| `assertedAt` / `retractedAt` | When did *we* decide it, and does that decision still stand? |
 *
 * The two are independent, and every useful query picks a point on each. "What did
 * the world look like during episode 2, according to what we believe today" is
 * `validFrom <= E02 < validUntil` **and** `assertedAt <= now < retractedAt`. Swap the
 * second point for a past instant and you replay the graph as it stood before the
 * retro-fit, which is what makes an aired episode re-renderable after later episodes
 * have complicated its backstory (CLAUDE.md §1.7: aired canon is immutable).
 *
 * Retraction is authoring-time only, and deliberately: retracting an edge means "we
 * no longer believe we wrote that", while `validUntil` means "it stopped being true
 * in the story". Confusing the two is how a character's death becomes a continuity
 * error instead of a plot point.
 *
 * The epistemic group is what all of this is *for*. Storing what is true and what
 * each character believes as separate edges - both bi-temporal - is what makes
 * dramatic irony mechanical rather than accidental: the scene writer for E05 is
 * handed Kael's view of the world, not the narrator's, so Kael cannot act on
 * information he does not have.
 */

import { z } from 'zod';

import {
  Confidence,
  IsoInstant,
  NonNegativeInt,
  PositiveInt,
  Prose,
  SignedUnit,
  StoryTime,
} from '../primitives/common';
import { EntityId, EpisodeId, RelationId, SceneId, SeriesId } from '../primitives/ids';
import { biTemporalShape, checkBiTemporalOrder } from './bi-temporal';

// ── the taxonomy ────────────────────────────────────────────────────────────

/**
 * The relation vocabulary, grouped.
 *
 * This object is the single source of truth for both the flat enum and the group
 * lookup, so a type can never be in the enum but in no group, or in two groups. The
 * grouping is exported rather than kept private because callers constantly need to
 * ask a *category* question - "is this edge epistemic?", "show me the kinship
 * subgraph" - and every caller that answers it with its own inline string list is a
 * copy that will drift the next time a type is added.
 */
export const RELATION_GROUPS = {
  kinship: ['parent-of', 'sibling-of', 'spouse-of', 'descendant-of'],
  affinity: ['loves', 'trusts', 'resents', 'fears', 'envies', 'owes'],
  social: ['ally-of', 'rival-of', 'enemy-of', 'mentor-of', 'serves', 'commands'],
  spatial: ['located-in', 'travels-to', 'native-to'],
  possession: ['owns', 'carries', 'lost', 'seeks', 'created'],
  epistemic: ['knows', 'believes-falsely', 'suspects', 'witnessed', 'told'],
  narrative: ['foreshadows', 'pays-off', 'parallels', 'symbolises'],
} as const satisfies Record<string, readonly string[]>;

export const RELATION_GROUP_NAMES = [
  'kinship',
  'affinity',
  'social',
  'spatial',
  'possession',
  'epistemic',
  'narrative',
] as const;

export const RelationGroup = z
  .enum(RELATION_GROUP_NAMES)
  .describe('Which family of relation this is.');
export type RelationGroup = z.infer<typeof RelationGroup>;

export const KINSHIP_RELATIONS = RELATION_GROUPS.kinship;
export const AFFINITY_RELATIONS = RELATION_GROUPS.affinity;
export const SOCIAL_RELATIONS = RELATION_GROUPS.social;
export const SPATIAL_RELATIONS = RELATION_GROUPS.spatial;
export const POSSESSION_RELATIONS = RELATION_GROUPS.possession;
/** The group that makes dramatic irony possible. See the file header. */
export const EPISTEMIC_RELATIONS = RELATION_GROUPS.epistemic;
export const NARRATIVE_RELATIONS = RELATION_GROUPS.narrative;

export const RELATION_TYPES = [
  ...KINSHIP_RELATIONS,
  ...AFFINITY_RELATIONS,
  ...SOCIAL_RELATIONS,
  ...SPATIAL_RELATIONS,
  ...POSSESSION_RELATIONS,
  ...EPISTEMIC_RELATIONS,
  ...NARRATIVE_RELATIONS,
] as const;

export const RelationType = z
  .enum(RELATION_TYPES)
  .describe('The kind of edge. Read `from` -> type -> `to`, e.g. "Aria parent-of Kael".');
export type RelationType = z.infer<typeof RelationType>;

/**
 * Reverse index from type to group.
 *
 * The cast is safe by construction: both sides are derived from `RELATION_GROUPS` in
 * the same expression, so the key set of the result is exactly `RelationType`.
 */
const GROUP_BY_TYPE = Object.fromEntries(
  Object.entries(RELATION_GROUPS).flatMap(([group, types]) => types.map((type) => [type, group])),
) as Record<RelationType, RelationGroup>;

/** Which family a relation type belongs to. Total by construction. */
export function relationGroupOf(type: RelationType): RelationGroup {
  return GROUP_BY_TYPE[type];
}

const EPISTEMIC_SET: ReadonlySet<string> = new Set<string>(EPISTEMIC_RELATIONS);

/**
 * True for edges that describe a *belief* rather than a fact about the world.
 *
 * Exported as a predicate because the rule pass asks it on every edge it walks: an
 * epistemic edge is the only licence a character has to act on a fact, and the
 * "character used knowledge they have no `knows` edge for" rule is nothing but this
 * question asked in a loop.
 */
export function isEpistemicRelation(type: RelationType): boolean {
  return EPISTEMIC_SET.has(type);
}

// ── visibility and provenance ───────────────────────────────────────────────

export const AUDIENCE_VISIBILITIES = ['public', 'private', 'secret'] as const;

/**
 * What the *audience* knows, which is a third thing again.
 *
 * `public` the audience and the cast both know; `private` the cast knows and the
 * audience has not been shown; `secret` neither knows yet. The gap between this and
 * the epistemic edges is precisely the suspense budget, so it is stored, not inferred.
 */
export const AudienceVisibility = z
  .enum(AUDIENCE_VISIBILITIES)
  .describe('How exposed this fact is to the audience.');
export type AudienceVisibility = z.infer<typeof AudienceVisibility>;

/**
 * Where an assertion came from.
 *
 * A discriminated union rather than a string-or-object, because the continuity
 * checker treats the three cases very differently: an episode-sourced fact from an
 * aired episode is frozen canon, an author-sourced fact outranks anything inferred,
 * and an inferred fact may be quietly dropped when it conflicts.
 */
export const RelationSource = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('episode'),
    episodeId: EpisodeId,
    sceneId: SceneId.optional().describe('The scene that asserted it, when known.'),
  }),
  z.strictObject({
    kind: z.literal('author'),
    note: Prose.optional().describe('Why the author stated it directly.'),
  }),
  z.strictObject({
    kind: z.literal('inferred'),
    rule: Prose.describe('What inference produced this, so a wrong one can be traced and fixed.'),
  }),
]);
export type RelationSource = z.infer<typeof RelationSource>;

// ── the edge ────────────────────────────────────────────────────────────────

/**
 * One bi-temporal assertion about the world.
 *
 * `validFrom` / `validUntil` are spelled as two flat fields rather than as a
 * `StoryInterval` because both are indexed and queried independently - the hot query
 * is a half-open range test on one of them - and because the JSON Schema an LLM fills
 * reads better flat.
 *
 * The two invariants are enforced with `superRefine` rather than left to the database.
 * They cannot be expressed in JSON Schema, so they are dropped from the schema handed
 * to the model, which means the model *will* occasionally produce an inverted interval
 * and this is the only thing that catches it. Both the fields and the check come from
 * `bi-temporal.ts` and are shared verbatim with {@link Fact}: one clock pair, one
 * guard, one query shape over both.
 */
export const Relation = z
  .strictObject({
    id: RelationId,
    seriesId: SeriesId,
    from: EntityId.describe('The subject of the sentence.'),
    to: EntityId.describe('The object of the sentence.'),
    type: RelationType,
    fact: Prose.describe(
      'The assertion in one human sentence, e.g. "Aria is Kael\'s mother". Embedded for hybrid retrieval, and quoted verbatim in continuity findings, so write it to be read.',
    ),
    strength: SignedUnit.default(0).describe(
      'Signed intensity: -1 hatred, 0 neutral, +1 devotion. For non-affective types it is how strongly the relation holds.',
    ),

    // ── the two clocks, shared verbatim with `Fact` (see `bi-temporal.ts`) ──
    ...biTemporalShape,

    sourceRef: RelationSource,
    confidence: Confidence.default(1).describe(
      'How sure we are. 1 for anything an author stated directly; lower for extraction and inference.',
    ),
    visibility: AudienceVisibility.default('public'),
  })
  .superRefine(checkBiTemporalOrder);
export type Relation = z.infer<typeof Relation>;

// ── querying two clocks ─────────────────────────────────────────────────────

export const RELATION_DIRECTIONS = ['out', 'in', 'either'] as const;
export const RelationDirection = z.enum(RELATION_DIRECTIONS);
export type RelationDirection = z.infer<typeof RelationDirection>;

/**
 * A filter over the graph, with a point chosen on each clock.
 *
 * `at` and `asOf` are the reason this schema exists rather than a bag of parameters:
 * leaving either one implicit is how a caller accidentally reads the retro-fitted
 * present into a flashback. Both are optional, but omitting `asOf` means "as we
 * believe it now" and omitting `at` means "at any point in the story" - and those are
 * different enough that the caller should have to say so.
 */
export const RelationQuery = z.strictObject({
  seriesId: SeriesId,
  entityId: EntityId.optional().describe('Restrict to edges touching this entity.'),
  direction: RelationDirection.default('either').describe(
    'Which end `entityId` must sit on. Ignored when `entityId` is absent.',
  ),
  types: z
    .array(RelationType)
    .max(64)
    .default([])
    .describe('Restrict to these types. Empty means every type.'),
  groups: z
    .array(RelationGroup)
    .max(7)
    .default([])
    .describe('Restrict to these families. Empty means every family. Unioned with `types`.'),
  at: StoryTime.optional().describe(
    'Story-time point. Keeps edges whose validity interval contains it. Omit for "at any point in the story".',
  ),
  asOf: IsoInstant.optional().describe(
    'Authoring-time point. Keeps edges asserted by then and not yet retracted. Omit for "as we believe it now"; set it to replay the graph as it stood before a retro-fit.',
  ),
  visibility: z
    .array(AudienceVisibility)
    .max(3)
    .default([])
    .describe('Restrict to these audience visibilities. Empty means every visibility.'),
  minConfidence: Confidence.default(0).describe('Drop edges we are less sure of than this.'),
  limit: PositiveInt.max(10_000).default(500).describe('Hard cap on returned edges.'),
});
export type RelationQuery = z.infer<typeof RelationQuery>;

// ── the epistemic view ──────────────────────────────────────────────────────

/**
 * One thing in one character's head.
 *
 * `via` records which epistemic edge put it there, because "she witnessed it" and
 * "someone told her" are not the same standing: the second can be a lie, and the
 * scene writer needs to know which kind of certainty it is handing the character.
 */
export const KnownFact = z.strictObject({
  relationId: RelationId.describe('The edge this belief is about.'),
  fact: Prose.describe(
    'The proposition as this character would state it - not as the narrator would.',
  ),
  via: z.enum(EPISTEMIC_RELATIONS).describe('The epistemic edge that put this in their head.'),
  learnedAt: StoryTime.nullable()
    .default(null)
    .describe('When they came to hold it. `null` means "always knew".'),
  learnedFrom: EntityId.optional().describe('Who told them, for `told` and `believes-falsely`.'),
  confidence: Confidence.default(1).describe('How sure *they* are - not how sure we are.'),
});
export type KnownFact = z.infer<typeof KnownFact>;

/**
 * What one character knows at one story time, resolved against one authoring revision.
 *
 * This is the object handed to the scene writer instead of the world state, and it is
 * the single mechanism that removes the most common failure of LLM-written serials:
 * a character acting on information only the narrator has. It is self-describing -
 * `viewerId`, `at` and `asOf` are carried inside it - because it travels alone, into
 * a prompt, far from the snapshot it was cut from.
 *
 * `blindSpots` is the inverse and is just as useful: the true edges the viewer does
 * *not* hold are the dramatic irony currently available to the scene.
 */
export const EpistemicView = z.strictObject({
  seriesId: SeriesId,
  viewerId: EntityId.describe('Whose head this is.'),
  at: StoryTime.describe('The story-time point this view was resolved at.'),
  asOf: IsoInstant.describe(
    'The authoring-time point it was resolved against. Two views of the same moment differ if a retro-fit landed between them.',
  ),
  knows: z.array(KnownFact).max(512).default([]).describe('Held as true, and true.'),
  believesFalsely: z
    .array(KnownFact)
    .max(512)
    .default([])
    .describe('Held as true, and false. The engine of every misunderstanding.'),
  suspects: z
    .array(KnownFact)
    .max(512)
    .default([])
    .describe('Entertained but not acted on. Where a reveal can land without whiplash.'),
  blindSpots: z
    .array(RelationId)
    .max(512)
    .default([])
    .describe(
      'True edges the viewer does not hold. The dramatic irony available to this scene; never put these in the prompt as facts.',
    ),
  truncated: z
    .boolean()
    .default(false)
    .describe('True when the view hit a cap and is incomplete. Never silently.'),
  factCount: NonNegativeInt.default(0).describe('Total facts before any cap was applied.'),
});
export type EpistemicView = z.infer<typeof EpistemicView>;
