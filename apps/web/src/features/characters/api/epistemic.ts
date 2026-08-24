/**
 * The bi-temporal projection, as this screen has to be able to compute it.
 *
 * Everything here is a pure function of a relation set plus a point on each clock. It
 * is a faithful port of `BiTemporalIndex` in the core domain package — `isValidAt`,
 * `wasKnownAt`, `isCurrent`, `knowledgeOf` and, most importantly, `couldKnow` — and it
 * lives in `apps/web` for one reason: the studio may not import a domain package, and
 * the API has no route that answers the question.
 *
 * **Report — the route this screen is standing in for:**
 * `GET /api/series/:seriesId/entities/:entityId/view?at=<ordinal>&asOf=<instant>`,
 * answering with `EpistemicView`, which `@rv/contracts` already defines. Until it
 * exists, RV-207's acceptance criterion — "the graph matches viewFor(character,
 * storyTime) exactly, asserted against the API response" — cannot be met, because there
 * is no API response to assert against. This module is what the screen draws from in
 * the meantime, and the port is deliberately line-for-line rather than merely
 * equivalent, so that the day the endpoint lands the two answers can be diffed.
 *
 * The one rule worth restating, because a test in the domain once had it backwards:
 * **being the object of a secret is not knowing it.** "Aria is a parent of Kael", kept
 * secret, is precisely the fact kept *from* Kael, and Kael is its object. A projection
 * that treats every participant as a knower answers "yes" for the single fact the whole
 * epistemic layer exists to withhold, and dramatic irony stops being representable.
 * `couldKnow` below narrows that case, and only for secrets — a private marriage is
 * still known to both spouses — and exempts the relation types whose entire meaning is
 * that information reached the object.
 */

import {
  type EntityId,
  type Relation,
  type RelationType,
  type StoryTime,
  isEpistemicRelation,
} from '@rv/contracts';

/** Everything before the story starts, and everything after it ends. */
export const DAWN: StoryTime = Object.freeze({ ordinal: Number.MIN_SAFE_INTEGER });
export const HORIZON: StoryTime = Object.freeze({ ordinal: Number.MAX_SAFE_INTEGER });

/** Relations whose meaning is that information reached the object. */
const INFORMS_THE_OBJECT: ReadonlySet<RelationType> = new Set<RelationType>(['told']);

/**
 * A point on each clock.
 *
 * `asOf: null` means "as we believe it now", which is a different query from any past
 * instant: it keeps only assertions that have never been retracted, rather than
 * assertions that had not yet been retracted at some moment.
 */
export interface Standpoint {
  readonly at: StoryTime;
  readonly asOf: string | null;
}

/** Was this true inside the fiction at `point`? Half-open: a fact ending at 50 is false at 50. */
export function isValidAt(relation: Relation, point: StoryTime): boolean {
  const from = relation.validFrom ?? DAWN;
  const until = relation.validUntil ?? HORIZON;
  return from.ordinal <= point.ordinal && point.ordinal < until.ordinal;
}

/** Had we written this down, and not yet un-said it, at `instant`? */
export function wasKnownAt(relation: Relation, instant: string): boolean {
  const asserted = Date.parse(relation.assertedAt);
  const point = Date.parse(instant);
  if (asserted > point) return false;
  if (relation.retractedAt === null) return true;
  return Date.parse(relation.retractedAt) > point;
}

/** Is this the current, standing version of the fact? */
export function isCurrent(relation: Relation): boolean {
  return relation.retractedAt === null;
}

/** Both clocks, applied. */
export function holdsAt(relation: Relation, standpoint: Standpoint): boolean {
  if (!isValidAt(relation, standpoint.at)) return false;
  return standpoint.asOf === null ? isCurrent(relation) : wasKnownAt(relation, standpoint.asOf);
}

export function relationsAt(
  relations: readonly Relation[],
  standpoint: Standpoint,
): readonly Relation[] {
  return relations.filter((relation) => holdsAt(relation, standpoint));
}

/** The viewer's own epistemic out-edges: what they hold, believe or have witnessed. */
export function knowledgeOf(
  relations: readonly Relation[],
  viewerId: EntityId,
  standpoint: Standpoint,
): readonly Relation[] {
  return relationsAt(relations, standpoint).filter(
    (relation) => relation.from === viewerId && isEpistemicRelation(relation.type),
  );
}

/**
 * Whether `viewerId` could act on `fact` at this standpoint.
 *
 * Deliberately permissive: it exists to catch a character using information they
 * demonstrably do not have, not to model inference. The narrowing in the middle is the
 * whole point — see the file header.
 */
export function couldKnow(
  relations: readonly Relation[],
  viewerId: EntityId,
  fact: Relation,
  standpoint: Standpoint,
): boolean {
  if (fact.visibility === 'public') return true;

  // The subject of a fact knows their own fact.
  if (fact.from === viewerId) return true;

  if (fact.to === viewerId) {
    // Being the *object* is not the same as knowing, and the narrowing applies only to
    // a secret: a private marriage is still known to both spouses.
    if (fact.visibility !== 'secret') return true;
    if (INFORMS_THE_OBJECT.has(fact.type)) return true;
  }

  return knowledgeOf(relations, viewerId, standpoint).some(
    (known) => known.to === fact.from || known.to === fact.to,
  );
}

// ── the standing of one fact, for one viewer ────────────────────────────────

/**
 * Where a fact sits in a viewer's head.
 *
 * Six values and not two, because collapsing them is exactly the failure this screen
 * exists to avoid: `knows` and `believes-falsely` are stored as *separate edges* in the
 * model, and a UI that renders both as "connected" has thrown away the reason the model
 * is shaped that way. `blind` is the sixth and the most useful — a true fact the viewer
 * does not hold is the dramatic irony currently available to the scene.
 */
export const EPISTEMIC_STANDINGS = [
  'knows',
  'believes-falsely',
  'suspects',
  'witnessed',
  'told',
  'blind',
] as const;
export type EpistemicStanding = (typeof EPISTEMIC_STANDINGS)[number];

function isStanding(value: string): value is EpistemicStanding {
  return (EPISTEMIC_STANDINGS as readonly string[]).includes(value);
}

/**
 * `null` for the narrator, who has no blind spots by definition.
 *
 * An omniscient viewer's view is the whole graph, so overlaying a standing on every
 * edge would be six ways of saying yes. The interface says it once, in the standpoint
 * summary, and leaves the edges plain.
 */
export function standingOf(
  relations: readonly Relation[],
  viewerId: EntityId | null,
  fact: Relation,
  standpoint: Standpoint,
): EpistemicStanding | null {
  if (viewerId === null) return null;

  // An epistemic edge the viewer holds *is* its own standing: this is the belief
  // itself, not a fact the belief is about.
  if (fact.from === viewerId && isEpistemicRelation(fact.type) && isStanding(fact.type)) {
    return fact.type;
  }

  return couldKnow(relations, viewerId, fact, standpoint) ? 'knows' : 'blind';
}

/**
 * Whether this fact is one the viewer is the *object* of, kept secret from them.
 *
 * Surfaced separately from the standing because it is the case a reader will otherwise
 * misread: the edge touches the viewer, so an eye skimming the diagram expects it to be
 * something they know. Saying "object of the secret, not a knower" beside it is the
 * difference between a UI that encodes the model and one that merely displays it.
 */
export function isObjectOfSecret(fact: Relation, viewerId: EntityId | null): boolean {
  if (viewerId === null) return false;
  if (fact.visibility !== 'secret') return false;
  if (fact.to !== viewerId || fact.from === viewerId) return false;
  return !INFORMS_THE_OBJECT.has(fact.type);
}

// ── the four buckets, as `EpistemicView` sorts them ─────────────────────────

export interface ViewerKnowledge {
  /** Held and true. */
  readonly knows: readonly Relation[];
  /** Held and false: the engine of every misunderstanding. */
  readonly believesFalsely: readonly Relation[];
  /** Entertained but not acted on. */
  readonly suspects: readonly Relation[];
  /** True edges the viewer does not hold. Never rendered as fact. */
  readonly blindSpots: readonly Relation[];
}

export function viewerKnowledge(
  relations: readonly Relation[],
  viewerId: EntityId,
  standpoint: Standpoint,
): ViewerKnowledge {
  const held = knowledgeOf(relations, viewerId, standpoint);
  const knows = held.filter(
    (relation) => relation.type !== 'believes-falsely' && relation.type !== 'suspects',
  );
  const believesFalsely = held.filter((relation) => relation.type === 'believes-falsely');
  const suspects = held.filter((relation) => relation.type === 'suspects');

  const blindSpots = relationsAt(relations, standpoint).filter(
    (relation) =>
      relation.visibility !== 'public' && !couldKnow(relations, viewerId, relation, standpoint),
  );

  return { knows, believesFalsely, suspects, blindSpots };
}
