/**
 * What the model is asked for: observations with **names**, never ids.
 *
 * A model asked to emit `EntityId`s invents them. It has no way not to - the ids are
 * prefixed ULIDs it has never seen, and the schema constrains their shape, not their
 * existence - so it produces `ent_01J...` shaped strings that resolve to nothing, and
 * the failure surfaces three stages later as an edge pointing at a node that does not
 * exist.
 *
 * So the extraction target is deliberately weaker than `StateDelta`: subjects and objects
 * are the names as the scene wrote them, and resolving a name to an id is our job
 * (`coreference.ts`), against the alias lists the graph already holds. A mention that
 * resolves to nothing is a typed result the caller has to look at, not a silently dropped
 * observation.
 *
 * The field order is the order the model is asked the questions in, and it matters: who
 * is here, what is true between them, who moved, what changed hands, and only then what
 * anyone *believes*. Knowledge last because it is the hardest judgement and the model
 * answers it better once it has already committed to the physical facts.
 */

import { z } from 'zod';
import {
  AudienceVisibility,
  Confidence,
  EntityKind,
  EntityStatus,
  Importance,
  KnowledgeChangeKind,
  Label,
  PossessionMode,
  Prose,
  RelationType,
  SignedUnit,
  Unit01,
} from '@rv/contracts';

/** A name as the scene wrote it. Resolved against canonical names and aliases. */
const Mention = Label.describe(
  'The name exactly as the scene text writes it. Do not invent an identifier; do not normalise the spelling.',
);

export const ObservedEntity = z.strictObject({
  mention: Mention,
  kind: EntityKind,
  importance: Importance.default('background'),
  summary: Prose.describe('One sentence introducing it, as the scene presents it.'),
});
export type ObservedEntity = z.infer<typeof ObservedEntity>;

export const OBSERVED_POLARITIES = ['asserted', 'retracted'] as const;

/**
 * Whether the scene made this true or ended it.
 *
 * Separate from the relation type because "Kael no longer serves the Vale" is the same
 * edge as "Kael serves the Vale" with a story-time end, not a different edge - and
 * bounding the original is the only way to keep "who did Kael serve in episode 2"
 * answerable after episode 6.
 */
export const ObservedPolarity = z.enum(OBSERVED_POLARITIES);
export type ObservedPolarity = z.infer<typeof ObservedPolarity>;

export const ObservedRelation = z.strictObject({
  subject: Mention.describe('Who or what the sentence is about.'),
  object: Mention.describe('Who or what it is about them.'),
  type: RelationType,
  fact: Prose.describe(
    'The assertion in one human sentence, e.g. "Aria is Kael\'s mother". It is quoted verbatim in continuity findings, so write it to be read.',
  ),
  strength: SignedUnit.default(0),
  polarity: ObservedPolarity.default('asserted'),
  visibility: AudienceVisibility.default('public'),
  confidence: Confidence.default(0.8),
});
export type ObservedRelation = z.infer<typeof ObservedRelation>;

export const ObservedMovement = z.strictObject({
  subject: Mention.describe('Who or what moved.'),
  from: Mention.nullable().default(null).describe('The place left. Null if they were offscreen.'),
  to: Mention.nullable().describe('The place arrived at. Null means they left the map.'),
  note: Prose.optional().describe('How they travelled, when the timeline needs it.'),
});
export type ObservedMovement = z.infer<typeof ObservedMovement>;

export const ObservedPossession = z.strictObject({
  item: Mention.describe('The object that changed hands.'),
  from: Mention.nullable().default(null).describe('Previous holder. Null when it had none.'),
  to: Mention.nullable().describe('New holder. Null when it was dropped, lost or destroyed.'),
  mode: PossessionMode,
});
export type ObservedPossession = z.infer<typeof ObservedPossession>;

/**
 * A change to what one character believes.
 *
 * `about` is required here even though `KnowledgeChange.aboutRelationId` is optional,
 * because an epistemic *edge* needs somewhere to point: `couldKnow` tests whether the
 * knower has an edge reaching the subject or object of the fact in question, so a belief
 * with no target entity cannot participate in the check at all. Naming the subject of
 * the belief is something the model can reliably do; naming a relation id is not.
 */
export const ObservedKnowledge = z.strictObject({
  knower: Mention.describe('Whose model of the world changed.'),
  change: KnowledgeChangeKind,
  about: Mention.describe(
    'Who or what the belief is about - the subject of the proposition, e.g. "Aria" for "Aria is my mother", or "the fire" for "my parents died in the fire".',
  ),
  proposition: Prose.describe('What they now hold, phrased as they would state it.'),
  learnedFrom: Mention.nullable()
    .default(null)
    .describe('Who conveyed it. Null when they worked it out themselves.'),
});
export type ObservedKnowledge = z.infer<typeof ObservedKnowledge>;

export const ObservedVitality = z.strictObject({
  subject: Mention,
  to: EntityStatus,
  note: Prose.optional().describe('How it happened, when it matters later.'),
});
export type ObservedVitality = z.infer<typeof ObservedVitality>;

/**
 * A promise made to the audience.
 *
 * `setup` is what was shown, `promise` is what the audience now expects - and they are
 * two fields because a model given one produces the plant and never the debt, which is
 * the half the planner actually has to chase.
 */
export const ObservedSetup = z.strictObject({
  setup: Prose.describe('What was planted, as it appeared on screen.'),
  promise: Prose.describe('What the audience now believes they are owed. Phrase it as the debt.'),
  involves: z.array(Mention).max(32).default([]),
  urgency: Unit01.default(0.5).describe('How loudly the audience is waiting.'),
});
export type ObservedSetup = z.infer<typeof ObservedSetup>;

/**
 * The whole extraction target for one scene.
 *
 * One call, not six: the observations constrain each other - a movement names a place
 * that the entity list must also introduce - and six independent calls produce six
 * mutually inconsistent answers at six times the cost.
 */
export const SceneObservations = z.strictObject({
  entities: z.array(ObservedEntity).max(64).default([]),
  relations: z.array(ObservedRelation).max(64).default([]),
  movements: z.array(ObservedMovement).max(32).default([]),
  possessions: z.array(ObservedPossession).max(32).default([]),
  knowledge: z.array(ObservedKnowledge).max(64).default([]),
  vitality: z.array(ObservedVitality).max(32).default([]),
  setups: z.array(ObservedSetup).max(16).default([]),
});
export type SceneObservations = z.infer<typeof SceneObservations>;

export const SCENE_OBSERVATION_SYSTEM_PROMPT = [
  'You are a continuity extractor for an animated series. You read one scene and report',
  'what it changed about the world.',
  '',
  'Rules you must follow:',
  '- Refer to every person, place and object by the name the scene uses. Never invent an',
  '  identifier of any kind.',
  '- Report only what the scene actually establishes. Do not infer backstory, do not',
  '  restate what was already true, and do not add what you expect to happen next.',
  '- Separate what is TRUE from what a character BELIEVES. A character being wrong is the',
  '  point of the knowledge section, not a mistake to correct.',
  '- If a fact stopped being true in this scene, report it with polarity "retracted"',
  '  rather than omitting it.',
].join('\n');
