/**
 * Name → `EntityId`, done by us rather than by the model.
 *
 * This is the step that makes name-based extraction safe. The model produced "the boy",
 * "Kael" and "Kael Ardent" for the same character across three scenes; the graph holds
 * one node with a canonical name and an alias list. Matching them is a lookup, not a
 * judgement, so it belongs here where it is exact, free and testable - and where a
 * mention that matches *nothing*, or matches two nodes, becomes a typed result the
 * caller has to deal with instead of an edge quietly pointing at the wrong character.
 *
 * The ladder is deliberately short and ordered by how much it assumes:
 *
 * 1. exact canonical name (case-folded)
 * 2. exact alias (case-folded)
 * 3. normalised form - articles, possessives and punctuation stripped
 * 4. unique surname/given-name token, e.g. "Ardent" for "Kael Ardent"
 *
 * There is no fuzzy step. An edit-distance match that gets "Kaela" and "Kael" wrong once
 * corrupts the graph permanently, and the cost of the miss is one typed
 * {@link UnresolvedMention} that a human resolves in a second.
 */

import type { Entity, EntityId } from '@rv/contracts';

import { compareStrings } from '../graph/narrative-graph';

export const UNRESOLVED_REASONS = ['unknown', 'ambiguous'] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

/**
 * A mention the resolver refused to guess at.
 *
 * `where` names the observation field it came from, because "the extractor produced a
 * name nobody recognises" is only actionable if you can see which sentence produced it.
 */
export interface UnresolvedMention {
  readonly mention: string;
  readonly reason: UnresolvedReason;
  /** The nodes that tied, for `ambiguous`. Empty for `unknown`. */
  readonly candidates: readonly EntityId[];
  readonly where: string;
}

export type MentionResolution =
  | { readonly ok: true; readonly entityId: EntityId }
  | {
      readonly ok: false;
      readonly reason: UnresolvedReason;
      readonly candidates: readonly EntityId[];
    };

/** Lowercase, unaccented, punctuation-free, article-free. */
function normalise(value: string): string {
  return (
    value
      .normalize('NFKD')
      // Every combining mark, not a Latin-only range: Persian is the default UI locale
      // and its harakat have to fold away for a name to match its unvocalised spelling.
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\b(the|a|an)\b/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

function tokens(value: string): readonly string[] {
  return normalise(value)
    .split(' ')
    .filter((token) => token.length > 1);
}

/**
 * A name index over the graph's entities, plus anything the current extraction just
 * introduced.
 *
 * Built once per extraction rather than per mention: a scene with forty observations
 * against a series with two thousand entities is eighty thousand string comparisons
 * otherwise, and the answer is identical.
 */
export class MentionResolver {
  readonly #byExact = new Map<string, EntityId[]>();
  readonly #byToken = new Map<string, EntityId[]>();

  constructor(entities: readonly Entity[] = []) {
    for (const entity of entities)
      this.register(entity.id, [entity.canonicalName, ...entity.aliases]);
  }

  /**
   * Adds a node to the index.
   *
   * Public because an entity introduced by *this* scene must be resolvable by the
   * relations in the same scene - the extractor introduces "the fire" and then asserts
   * something about it two fields later, and an index built only from the stored graph
   * would report both as unknown.
   */
  register(entityId: EntityId, names: readonly string[]): void {
    for (const name of names) {
      push(this.#byExact, normalise(name), entityId);
      for (const token of tokens(name)) push(this.#byToken, token, entityId);
    }
  }

  resolve(mention: string): MentionResolution {
    const key = normalise(mention);
    if (key.length === 0) return { ok: false, reason: 'unknown', candidates: [] };

    const exact = this.#byExact.get(key);
    if (exact !== undefined) return decide(exact);

    // A single distinctive token - "Ardent" for "Kael Ardent" - only counts when every
    // token of the mention agrees on the same node. "Kael Ardent" matching both a Kael
    // and an Ardent is precisely the ambiguity this must refuse.
    const parts = tokens(mention);
    if (parts.length === 0) return { ok: false, reason: 'unknown', candidates: [] };

    let intersection: EntityId[] | undefined;
    for (const part of parts) {
      const hits = this.#byToken.get(part) ?? [];
      intersection =
        intersection === undefined ? [...hits] : intersection.filter((id) => hits.includes(id));
      if (intersection.length === 0) break;
    }

    if (intersection === undefined || intersection.length === 0) {
      return { ok: false, reason: 'unknown', candidates: [] };
    }
    return decide(intersection);
  }
}

function decide(candidates: readonly EntityId[]): MentionResolution {
  const unique = [...new Set(candidates)].sort(compareStrings);
  const only = unique[0];
  if (unique.length === 1 && only !== undefined) return { ok: true, entityId: only };
  return { ok: false, reason: 'ambiguous', candidates: unique };
}

function push(map: Map<string, EntityId[]>, key: string, value: EntityId): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else if (!bucket.includes(value)) bucket.push(value);
}

/**
 * Accumulates resolutions and the mentions that failed.
 *
 * A small collector rather than a `map` over each field, because every call site needs
 * the same two things - the id when it worked, a recorded failure when it did not - and
 * the version written inline forgets the second one.
 */
export class ResolutionLog {
  readonly #unresolved: UnresolvedMention[] = [];
  readonly #resolver: MentionResolver;

  constructor(resolver: MentionResolver) {
    this.#resolver = resolver;
  }

  /** `undefined` when the mention could not be resolved; the failure is recorded. */
  resolve(mention: string, where: string): EntityId | undefined {
    const outcome = this.#resolver.resolve(mention);
    if (outcome.ok) return outcome.entityId;
    this.#unresolved.push({
      mention,
      reason: outcome.reason,
      candidates: outcome.candidates,
      where,
    });
    return undefined;
  }

  /** Resolves an optional mention. `null` in means `null` out, with nothing recorded. */
  resolveNullable(mention: string | null, where: string): EntityId | null | undefined {
    if (mention === null) return null;
    return this.resolve(mention, where);
  }

  get unresolved(): readonly UnresolvedMention[] {
    return [...this.#unresolved].sort(
      (a, b) => compareStrings(a.where, b.where) || compareStrings(a.mention, b.mention),
    );
  }
}
