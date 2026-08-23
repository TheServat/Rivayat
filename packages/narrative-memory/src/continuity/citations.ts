/**
 * Turning "these two things cannot both be true" into two `FactId`s.
 *
 * `ContinuityIssue.conflictingFacts` is `FactId[]` and the schema refuses any finding
 * but `unpaid-open-loop` that names fewer than two - because a contradiction that cannot
 * say what it contradicts leaves the operator to find the other half at 2am.
 *
 * The awkward part is that half of what the rules conflict is not a `Fact` row. An edge
 * is a `Relation`; "Kael speaks in scene 4" is a scene event; "he is stated to be
 * nineteen" is a line of dialogue. None of those has a `FactId`, and inventing one that
 * resolves to nothing would produce findings whose citations 404 in the UI.
 *
 * So the checker **materialises** the facts it cites, which is exactly what
 * `FactContent.statement` is for - "a proposition with no object, held as prose". The
 * ids are derived from content (`derive-id.ts`), so the same contradiction found twice
 * cites the same two ids, and the caller can persist the cited rows alongside the
 * findings and have every citation resolve.
 */

import type {
  Fact,
  FactId,
  Prose,
  Relation,
  RelationSource,
  SeriesId,
  StoryTime,
} from '@rv/contracts';

import { deriveFactId, seed } from '../graph/derive-id';
import { compareStrings } from '../graph/narrative-graph';

export class FactCitations {
  readonly #seriesId: SeriesId;
  readonly #assertedAt: string;
  readonly #byRelation: ReadonlyMap<string, FactId>;
  readonly #materialised = new Map<FactId, Fact>();

  /**
   * @param existing facts the store already holds, so a relation that already has a
   * fact row is cited by *that* id rather than by a second one describing the same edge.
   */
  constructor(seriesId: SeriesId, assertedAt: string, existing: readonly Fact[]) {
    this.#seriesId = seriesId;
    this.#assertedAt = assertedAt;
    const byRelation = new Map<string, FactId>();
    for (const fact of existing) {
      if (fact.content.kind === 'relation') byRelation.set(fact.content.relationId, fact.id);
    }
    this.#byRelation = byRelation;
  }

  /** The fact id for an edge, materialising one if the store has none. */
  relation(relation: Relation): FactId {
    const existing = this.#byRelation.get(relation.id);
    if (existing !== undefined) return existing;

    const id = deriveFactId(seed(this.#seriesId, 'relation-fact', relation.id));
    this.#remember({
      id,
      seriesId: this.#seriesId,
      content: { kind: 'relation', relationId: relation.id },
      validFrom: relation.validFrom,
      validUntil: relation.validUntil,
      assertedAt: relation.assertedAt,
      retractedAt: relation.retractedAt,
      sourceRef: relation.sourceRef,
      confidence: relation.confidence,
      visibility: relation.visibility,
      importance: 'background',
    });
    return id;
  }

  /** A proposition with no object - a scene event, a line of dialogue, a stated age. */
  statement(text: Prose, at: StoryTime | null, sourceRef: RelationSource): FactId {
    const id = deriveFactId(seed(this.#seriesId, 'statement', text));
    if (!this.#materialised.has(id)) {
      this.#remember({
        id,
        seriesId: this.#seriesId,
        content: { kind: 'statement', text },
        validFrom: at,
        validUntil: null,
        assertedAt: this.#assertedAt,
        retractedAt: null,
        sourceRef,
        confidence: 1,
        visibility: 'public',
        importance: 'background',
      });
    }
    return id;
  }

  /** Everything materialised during the pass, for the caller to persist beside the findings. */
  get facts(): readonly Fact[] {
    return [...this.#materialised.values()].sort((a, b) => compareStrings(a.id, b.id));
  }

  #remember(fact: Fact): void {
    this.#materialised.set(fact.id, fact);
  }
}
