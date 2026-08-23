/**
 * The graph state every use-case in this package is a pure function of.
 *
 * `BiTemporalIndex` (`@rv/core-domain`) already answers every question about *edges* on
 * both clocks - as-of queries, `knowledgeOf`, `couldKnow`, `neighbourhood`, structural
 * contradictions. This type does not re-implement any of it. It is the envelope around
 * it: the nodes, the retrievable facts, the promises still owed, the compaction ladder,
 * and the one piece of world state edges cannot express.
 *
 * Two properties are load-bearing.
 *
 * **Canonical order.** Everything is sorted by id on construction. Retrieval is required
 * to be reproducible given the same graph state (docs/02 §4), and "the same graph state"
 * has to mean the same *set*, not the same array - a caller that loaded relations in a
 * different order from SQLite must get the same context back. Sorting once here is what
 * makes that true for `stateHash`, for `neighbourhood`'s collection order, and for every
 * scan downstream.
 *
 * **Immutability.** {@link NarrativeGraph.with} returns a new graph. Folding a delta
 * therefore produces a value that can be compared against its predecessor, which is how
 * "the old fact is still queryable at an earlier story time" is asserted rather than
 * hoped for.
 */

import { contentHash, type Sha256 } from '@rv/shared-kernel';
import { BiTemporalIndex } from '@rv/core-domain';
import type {
  Entity,
  EntityId,
  EntityStatus,
  EpisodeId,
  EpisodeSummary,
  Fact,
  FactId,
  OpenLoop,
  OpenLoopId,
  Relation,
  RelationId,
  RelationSource,
  SeasonSummary,
  SeriesId,
  SeriesSummary,
  StoryTime,
} from '@rv/contracts';

/**
 * A status assertion, on its own ledger rather than as an edge.
 *
 * `EntityStatus` is "the one piece of world state the rule pass cannot infer from
 * edges" (`memory.ts`), and the relation taxonomy has no type that expresses it - there
 * is no `is-dead`. `WorldStateSnapshot` carries statuses but is a *derived* view, folded
 * from deltas rather than stored, so it cannot be the source either. Hence a third
 * store, kept deliberately small: an append-only ledger of "who became what, when".
 *
 * Append-only for the same reason edges are bounded rather than deleted: "was Kael
 * alive in episode 3" must stay answerable after he dies in episode 6.
 */
export interface VitalityRecord {
  readonly entityId: EntityId;
  readonly status: EntityStatus;
  /** When the entity entered this status, in the fiction. */
  readonly at: StoryTime;
  readonly sourceRef: RelationSource;
}

/** Everything a graph is built from. Every collection is optional and defaults to empty. */
export interface NarrativeGraphInput {
  readonly seriesId: SeriesId;
  readonly entities?: readonly Entity[];
  readonly relations?: readonly Relation[];
  readonly facts?: readonly Fact[];
  readonly openLoops?: readonly OpenLoop[];
  readonly vitality?: readonly VitalityRecord[];
  readonly seriesSummary?: SeriesSummary | null;
  readonly episodeSummaries?: readonly EpisodeSummary[];
  readonly seasonSummaries?: readonly SeasonSummary[];
  /**
   * Broadcast order. Retrieval and the open-loop report measure a promise's age in
   * episodes, and story ordinals cannot supply that - a flashback has a small ordinal
   * and a late broadcast slot.
   */
  readonly episodeOrder?: readonly EpisodeId[];
  /**
   * Episodes whose canon is frozen (CLAUDE.md #7).
   *
   * Held as a set rather than read off `EpisodeSummary.canonFrozen` because the guard
   * has to work before an episode has ever been summarised.
   */
  readonly airedEpisodes?: readonly EpisodeId[];
}

/** Statuses that mean the entity can no longer act under its own power. */
const INACTIVE_STATUSES: ReadonlySet<EntityStatus> = new Set<EntityStatus>([
  'dead',
  'destroyed',
  'unborn',
]);

export class NarrativeGraph {
  readonly seriesId: SeriesId;
  readonly index: BiTemporalIndex;
  readonly entities: readonly Entity[];
  readonly relations: readonly Relation[];
  readonly facts: readonly Fact[];
  readonly openLoops: readonly OpenLoop[];
  readonly vitality: readonly VitalityRecord[];
  readonly seriesSummary: SeriesSummary | null;
  readonly episodeSummaries: readonly EpisodeSummary[];
  readonly seasonSummaries: readonly SeasonSummary[];
  readonly episodeOrder: readonly EpisodeId[];
  readonly airedEpisodes: ReadonlySet<EpisodeId>;

  readonly #entityById: ReadonlyMap<EntityId, Entity>;
  readonly #relationById: ReadonlyMap<RelationId, Relation>;
  readonly #factById: ReadonlyMap<FactId, Fact>;
  readonly #loopById: ReadonlyMap<OpenLoopId, OpenLoop>;
  readonly #summaryByEpisode: ReadonlyMap<EpisodeId, EpisodeSummary>;
  readonly #vitalityByEntity: ReadonlyMap<EntityId, readonly VitalityRecord[]>;
  readonly #input: NarrativeGraphInput;
  #hash: Sha256 | undefined;

  constructor(input: NarrativeGraphInput) {
    this.#input = input;
    this.seriesId = input.seriesId;
    this.entities = sortById(input.entities ?? []);
    this.relations = sortById(input.relations ?? []);
    this.facts = sortById(input.facts ?? []);
    this.openLoops = sortById(input.openLoops ?? []);
    this.vitality = sortVitality(input.vitality ?? []);
    this.seriesSummary = input.seriesSummary ?? null;
    this.episodeSummaries = [...(input.episodeSummaries ?? [])].sort((a, b) =>
      compareStrings(a.episodeId, b.episodeId),
    );
    this.seasonSummaries = [...(input.seasonSummaries ?? [])].sort((a, b) =>
      compareStrings(a.seasonId, b.seasonId),
    );
    this.episodeOrder = [...(input.episodeOrder ?? [])];
    this.airedEpisodes = new Set(input.airedEpisodes ?? []);

    this.index = new BiTemporalIndex(this.relations);
    this.#entityById = new Map(this.entities.map((entity) => [entity.id, entity]));
    this.#relationById = new Map(this.relations.map((relation) => [relation.id, relation]));
    this.#factById = new Map(this.facts.map((fact) => [fact.id, fact]));
    this.#loopById = new Map(this.openLoops.map((loop) => [loop.id, loop]));
    this.#summaryByEpisode = new Map(
      this.episodeSummaries.map((summary) => [summary.episodeId, summary]),
    );
    this.#vitalityByEntity = groupVitality(this.vitality);
  }

  entity(id: EntityId): Entity | undefined {
    return this.#entityById.get(id);
  }

  relation(id: RelationId): Relation | undefined {
    return this.#relationById.get(id);
  }

  fact(id: FactId): Fact | undefined {
    return this.#factById.get(id);
  }

  openLoop(id: OpenLoopId): OpenLoop | undefined {
    return this.#loopById.get(id);
  }

  episodeSummary(id: EpisodeId): EpisodeSummary | undefined {
    return this.#summaryByEpisode.get(id);
  }

  /**
   * Where this episode sits in broadcast order, or `-1` when it is not scheduled.
   *
   * Used to age an open loop. Separate from story time on purpose: a promise planted in
   * a flashback is owed from the episode that showed it, not from the year it depicts.
   */
  episodeIndex(id: EpisodeId): number {
    return this.episodeOrder.indexOf(id);
  }

  /**
   * The entity's condition at a story moment.
   *
   * Defaults to `alive` rather than to "unknown": absence of a death is the overwhelming
   * majority case, and a rule that only fires on an *asserted* death is a rule that
   * cannot produce a false positive from missing data.
   */
  statusAt(entityId: EntityId, at: StoryTime): EntityStatus {
    const records = this.#vitalityByEntity.get(entityId) ?? [];
    let status: EntityStatus = 'alive';
    for (const record of records) {
      if (record.at.ordinal > at.ordinal) break;
      status = record.status;
    }
    return status;
  }

  /** Whether the entity can plausibly act at that moment. */
  canAct(entityId: EntityId, at: StoryTime): boolean {
    return !INACTIVE_STATUSES.has(this.statusAt(entityId, at));
  }

  /**
   * The fingerprint retrieval echoes back with its result.
   *
   * Over the *content* of the graph, not its arrays, so two loads of the same rows in
   * different orders hash the same. A result found in a log a week later carrying this
   * hash and a different fact list is a bug in the retriever, not a change to the story
   * (`MemoryRetrievalResult.stateHash`).
   */
  get stateHash(): Sha256 {
    this.#hash ??= contentHash({
      seriesId: this.seriesId,
      entities: this.entities.map((entity) => entity.id),
      relations: this.relations,
      facts: this.facts,
      openLoops: this.openLoops,
      vitality: this.vitality,
      aired: [...this.airedEpisodes].sort(compareStrings),
    });
    return this.#hash;
  }

  /**
   * A new graph with some collections replaced.
   *
   * Replacement rather than merge: the fold rewrites the whole relation array because a
   * bounded relation is an edited row, not an appended one, and a merge helper would
   * make it far too easy to append the bounded copy and leave the unbounded original
   * standing beside it.
   */
  with(changes: Partial<Omit<NarrativeGraphInput, 'seriesId'>>): NarrativeGraph {
    return new NarrativeGraph({ ...this.#input, ...changes, seriesId: this.seriesId });
  }
}

function sortById<T extends { readonly id: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort((a, b) => compareStrings(a.id, b.id));
}

/** Chronological, then by entity, so a replayed fold produces an identical ledger. */
function sortVitality(records: readonly VitalityRecord[]): readonly VitalityRecord[] {
  return [...records].sort(
    (a, b) => a.at.ordinal - b.at.ordinal || compareStrings(a.entityId, b.entityId),
  );
}

function groupVitality(
  records: readonly VitalityRecord[],
): ReadonlyMap<EntityId, readonly VitalityRecord[]> {
  const grouped = new Map<EntityId, VitalityRecord[]>();
  for (const record of records) {
    const bucket = grouped.get(record.entityId);
    if (bucket === undefined) grouped.set(record.entityId, [record]);
    else bucket.push(record);
  }
  return grouped;
}

/**
 * Byte order, not locale order.
 *
 * `localeCompare` depends on the ICU data the runtime happens to ship, so a sort that
 * uses it is only deterministic on one machine - which is exactly the guarantee this
 * package is required to make.
 */
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
