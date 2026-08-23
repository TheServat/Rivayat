/**
 * The bi-temporal narrative index.
 *
 * Every fact in the world model carries two independent clocks:
 *
 *   - **story time** (`validFrom` / `validUntil`) - when it was true *in the fiction*
 *   - **authoring time** (`assertedAt` / `retractedAt`) - when *we* decided it, and
 *     whether that decision still stands
 *
 * One clock cannot express serialised fiction. In episode 7 we decide that back in
 * episode 2 the mentor was already lying: the fact's story time starts at episode 2,
 * its authoring time starts today. A single-clock store must either corrupt episode 2
 * or forbid the edit. See ADR-0004.
 *
 * Everything here is a pure function of the relation set it was constructed with - no
 * IO, no clock reads, no ordering dependence. That is what makes the retrieval that
 * feeds scene generation reproducible, and therefore testable.
 */

import { at, type Instant, fromIso } from '@rv/shared-kernel';
import {
  isEpistemicRelation,
  type EntityId,
  type Relation,
  type RelationType,
  type StoryTime,
} from '@rv/contracts';

import { HORIZON, DAWN } from './story-time';

/**
 * Where to stand when asking the question.
 *
 * Both default to "now": the latest story moment and everything we currently believe.
 */
export interface TemporalStandpoint {
  /** Only facts true at this point in the fiction. */
  readonly storyAt?: StoryTime;
  /** Only facts we had already written down at this real instant. */
  readonly authoredAt?: Instant;
}

export interface RelationFilter extends TemporalStandpoint {
  readonly from?: EntityId;
  readonly to?: EntityId;
  readonly types?: readonly RelationType[];
  /** Restrict to what the audience is allowed to have seen. */
  readonly visibility?: readonly ('public' | 'private' | 'secret')[];
  /** Drop low-confidence inferences. */
  readonly minConfidence?: number;
}

export interface Neighbourhood {
  readonly entities: ReadonlySet<EntityId>;
  readonly relations: readonly Relation[];
  /** Hop count at which each entity was first reached. Seeds are 0. */
  readonly distance: ReadonlyMap<EntityId, number>;
}

/**
 * Two facts that cannot both be true.
 *
 * Detected structurally - same subject, same relation type, overlapping story time,
 * incompatible objects or opposite signs - so the cheap rule pass catches it before
 * any model is asked an opinion.
 */
export interface Contradiction {
  readonly kind: 'conflicting-object' | 'opposite-strength' | 'retroactive-overlap';
  readonly left: Relation;
  readonly right: Relation;
  readonly explanation: string;
}

/** Relation types where the subject may hold at most one object at a time. */
const FUNCTIONAL_RELATIONS: ReadonlySet<string> = new Set(['located-in', 'spouse-of', 'native-to']);

export class BiTemporalIndex {
  readonly #relations: readonly Relation[];
  readonly #byFrom: ReadonlyMap<EntityId, readonly Relation[]>;
  readonly #byTo: ReadonlyMap<EntityId, readonly Relation[]>;

  constructor(relations: readonly Relation[]) {
    // Copied and frozen: an index that reflects later mutation of its input is not a
    // pure function of anything.
    this.#relations = Object.freeze([...relations]);
    this.#byFrom = groupBy(this.#relations, (relation) => relation.from);
    this.#byTo = groupBy(this.#relations, (relation) => relation.to);
  }

  get size(): number {
    return this.#relations.length;
  }

  /** Every relation, unfiltered. Mostly for tests and for full-graph exports. */
  all(): readonly Relation[] {
    return this.#relations;
  }

  // ── the two clocks ────────────────────────────────────────────────────────

  /** Was this fact true in the fiction at `point`? */
  static isValidAt(relation: Relation, point: StoryTime): boolean {
    const from = relation.validFrom ?? DAWN;
    const until = relation.validUntil ?? HORIZON;
    // Half-open: a fact that ends at 50 is not true at 50.
    return from.ordinal <= point.ordinal && point.ordinal < until.ordinal;
  }

  /** Had we written this fact down, and not yet retracted it, at `instant`? */
  static wasKnownAt(relation: Relation, instant: Instant): boolean {
    const asserted = fromIso(relation.assertedAt);
    if (asserted > instant) return false;
    if (relation.retractedAt === null) return true;
    return fromIso(relation.retractedAt) > instant;
  }

  /** Is this the current, standing version of the fact? */
  static isCurrent(relation: Relation): boolean {
    return relation.retractedAt === null;
  }

  // ── querying ──────────────────────────────────────────────────────────────

  query(filter: RelationFilter = {}): readonly Relation[] {
    const candidates = this.#candidates(filter);
    return candidates.filter((relation) => this.#matches(relation, filter));
  }

  /** Narrow by index before scanning, so a large graph stays cheap. */
  #candidates(filter: RelationFilter): readonly Relation[] {
    if (filter.from !== undefined) return this.#byFrom.get(filter.from) ?? [];
    if (filter.to !== undefined) return this.#byTo.get(filter.to) ?? [];
    return this.#relations;
  }

  #matches(relation: Relation, filter: RelationFilter): boolean {
    // `from` is not re-checked: `#candidates` already narrowed by it when it was set,
    // and by `to` otherwise. `to` *is* re-checked, because a filter naming both is
    // narrowed by `from` alone.
    if (filter.to !== undefined && relation.to !== filter.to) return false;
    if (filter.types !== undefined && !filter.types.includes(relation.type)) return false;
    if (filter.visibility !== undefined && !filter.visibility.includes(relation.visibility)) {
      return false;
    }
    if (filter.minConfidence !== undefined && relation.confidence < filter.minConfidence) {
      return false;
    }
    if (filter.storyAt !== undefined && !BiTemporalIndex.isValidAt(relation, filter.storyAt)) {
      return false;
    }
    if (filter.authoredAt !== undefined) {
      if (!BiTemporalIndex.wasKnownAt(relation, filter.authoredAt)) return false;
    } else if (!BiTemporalIndex.isCurrent(relation)) {
      // With no authoring standpoint, "now" means current belief - a retracted fact is
      // not part of it.
      return false;
    }
    return true;
  }

  // ── the epistemic layer ───────────────────────────────────────────────────

  /**
   * What one character knows, believes or has witnessed at a given moment.
   *
   * This is the mechanism that makes dramatic irony work. The scene writer for
   * episode 5 is handed *Kael's* view, not the narrator's, so Kael cannot act on a
   * secret he has not been told - the single most common failure of LLM-written
   * serials.
   */
  knowledgeOf(entity: EntityId, standpoint: TemporalStandpoint = {}): readonly Relation[] {
    return this.query({ ...standpoint, from: entity }).filter((relation) =>
      isEpistemicRelation(relation.type),
    );
  }

  /**
   * Whether `entity` could plausibly act on `fact` at that moment.
   *
   * True when the entity has an epistemic edge pointing at the fact's subject or
   * object, or when the fact is public. Deliberately permissive: it exists to catch
   * a character using information they demonstrably do not have, not to model
   * inference.
   */
  couldKnow(entity: EntityId, fact: Relation, standpoint: TemporalStandpoint = {}): boolean {
    if (fact.visibility === 'public') return true;
    if (fact.from === entity || fact.to === entity) return true;
    return this.knowledgeOf(entity, standpoint).some(
      (known) => known.to === fact.from || known.to === fact.to,
    );
  }

  // ── graph traversal ───────────────────────────────────────────────────────

  /**
   * Everything within `hops` of the seeds, at a given standpoint.
   *
   * The graph half of hybrid retrieval: the entities in a scene seed it, and the
   * neighbourhood is what the scene writer is allowed to reference. Bounded by hops
   * rather than by score, so it is cheap and its cost is predictable.
   */
  neighbourhood(
    seeds: readonly EntityId[],
    hops: number,
    standpoint: TemporalStandpoint = {},
  ): Neighbourhood {
    const distance = new Map<EntityId, number>();
    const collected: Relation[] = [];
    const seen = new Set<string>();

    let frontier: EntityId[] = [];
    for (const seed of seeds) {
      if (!distance.has(seed)) {
        distance.set(seed, 0);
        frontier.push(seed);
      }
    }

    for (let hop = 0; hop < hops && frontier.length > 0; hop += 1) {
      const next: EntityId[] = [];
      for (const entity of frontier) {
        // Undirected traversal: "who is Kael's mother" and "whose son is Kael" are the
        // same question to a reader, so they must be the same question to retrieval.
        const touching = [
          ...this.query({ ...standpoint, from: entity }),
          ...this.query({ ...standpoint, to: entity }),
        ];
        for (const relation of touching) {
          if (!seen.has(relation.id)) {
            seen.add(relation.id);
            collected.push(relation);
          }
          const other = relation.from === entity ? relation.to : relation.from;
          if (!distance.has(other)) {
            distance.set(other, hop + 1);
            next.push(other);
          }
        }
      }
      frontier = next;
    }

    return { entities: new Set(distance.keys()), relations: collected, distance };
  }

  // ── continuity ────────────────────────────────────────────────────────────

  /**
   * Structural contradictions, found without asking a model.
   *
   * Only the cheap, exact cases live here. Tone drift and motivation reversals need
   * judgement and belong to the LLM pass, which runs second and only sees what these
   * rules could not decide.
   */
  findContradictions(): readonly Contradiction[] {
    const found: Contradiction[] = [];
    const current = this.#relations.filter((relation) => BiTemporalIndex.isCurrent(relation));

    for (let i = 0; i < current.length; i += 1) {
      const left = at(current, i);
      for (let j = i + 1; j < current.length; j += 1) {
        const right = at(current, j);
        if (left.from !== right.from || left.type !== right.type) continue;
        if (!storyOverlap(left, right)) continue;

        if (FUNCTIONAL_RELATIONS.has(left.type) && left.to !== right.to) {
          found.push({
            kind: 'conflicting-object',
            left,
            right,
            explanation: `"${left.type}" holds at most one object at a time, but the same subject has two overlapping in story time`,
          });
          continue;
        }

        if (left.to === right.to && Math.sign(left.strength) * Math.sign(right.strength) < 0) {
          found.push({
            kind: 'opposite-strength',
            left,
            right,
            explanation: `the same "${left.type}" relation is asserted with opposite valence over an overlapping span`,
          });
        }
      }
    }

    return found;
  }
}

function storyOverlap(a: Relation, b: Relation): boolean {
  const aFrom = (a.validFrom ?? DAWN).ordinal;
  const aUntil = (a.validUntil ?? HORIZON).ordinal;
  const bFrom = (b.validFrom ?? DAWN).ordinal;
  const bUntil = (b.validUntil ?? HORIZON).ordinal;
  return aFrom < bUntil && bFrom < aUntil;
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): ReadonlyMap<K, readonly T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const bucket = map.get(key(item));
    if (bucket === undefined) map.set(key(item), [item]);
    else bucket.push(item);
  }
  return map;
}
