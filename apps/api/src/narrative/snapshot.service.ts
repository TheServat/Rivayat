/**
 * The graph, and one character's head inside it, answered at a standpoint.
 *
 * `BiTemporalIndex` in `@rv/core-domain` already answers every question about edges on
 * both clocks, and `buildEpistemicView` in `@rv/narrative-memory` already sorts the
 * answer into the four buckets `EpistemicView` publishes. Nothing here re-implements
 * either; this reads the graph, derives the two lists of *standpoints* a UI needs, and
 * calls them.
 *
 * ## The rule this endpoint exists to make true
 *
 * **Being the object of a secret is not knowing it.** `(Aria) -parent-of-> (Kael)`, kept
 * secret, is precisely the fact kept *from* Kael, and Kael is its object. A projection
 * that treats every participant as a knower answers "yes" for the single fact the whole
 * epistemic layer exists to withhold, and dramatic irony stops being representable.
 * `BiTemporalIndex.couldKnow` narrows that case, and only for secrets - a private
 * marriage is still known to both spouses - and exempts `told`, whose entire meaning is
 * that information reached the object.
 *
 * `apps/web/src/features/characters/api/epistemic.ts` is a deliberate line-for-line port
 * of the same predicate, written so the two could be diffed the day this endpoint landed.
 * They agree: `isValidAt`, `wasKnownAt`, `isCurrent`, `knowledgeOf` and `couldKnow` are
 * the same functions, including the `INFORMS_THE_OBJECT` exemption and including the
 * half-open story interval. The one difference is not a disagreement: the port's
 * `Standpoint` requires `at` and `asOf`, while `TemporalStandpoint` makes both optional
 * and treats an absent `asOf` as "current belief" rather than as an instant. This
 * service always supplies both, so the two evaluate identically.
 */

import {
  type EntityId,
  type EpistemicView,
  type Relation,
  type SeriesId,
  type StoryTime,
} from '@rv/contracts';
import {
  DEFAULT_VIEW_CAP,
  buildEpistemicView,
  compareStrings,
  isOmniscient,
  type NarrativeGraph,
} from '@rv/narrative-memory';
import {
  NotFoundError,
  err,
  fromIso,
  isErr,
  ok,
  type AppError,
  type Clock,
  type Result,
} from '@rv/shared-kernel';

import type { EpisodeRepository } from '../application/ports/repository.ports';
import type { NarrativeGraphStore } from './graph.store';
import {
  GraphRevision,
  NarrativeSnapshot,
  StoryMark,
  type EpistemicViewQuery,
} from './snapshot.contracts';

export interface SnapshotServiceDeps {
  readonly graph: NarrativeGraphStore;
  readonly episodes: EpisodeRepository;
  readonly clock: Clock;
}

export class SnapshotService {
  readonly #graph: NarrativeGraphStore;
  readonly #episodes: EpisodeRepository;
  readonly #clock: Clock;

  constructor(deps: SnapshotServiceDeps) {
    this.#graph = deps.graph;
    this.#episodes = deps.episodes;
    this.#clock = deps.clock;
  }

  async snapshot(seriesId: SeriesId): Promise<Result<NarrativeSnapshot, AppError>> {
    const graph = this.#graph.load(seriesId);
    if (isErr(graph)) return graph;

    const episodes = await this.#episodes.listBySeries(seriesId);
    if (isErr(episodes)) return episodes;

    return ok(
      NarrativeSnapshot.parse({
        seriesId,
        entities: graph.value.entities,
        relations: graph.value.relations,
        storyMarks: storyMarksOf(
          graph.value,
          episodes.value.map((episode) => episode.ordinal),
        ),
        revisions: revisionsOf(graph.value.relations),
      }),
    );
  }

  /**
   * One viewer's head, at one point on each clock.
   *
   * A viewer the series does not hold is a not-found rather than an empty view: an empty
   * view for a misspelled id looks exactly like a character who knows nothing, and the
   * second is a legitimate dramatic state.
   */
  // Not `async`: nothing here awaits, because the graph is already in memory. The
  // return type stays a Promise so a caller cannot tell which implementations happen
  // to be synchronous today - that is the port's business, not theirs.
  // eslint-disable-next-line @typescript-eslint/require-await
  async view(
    seriesId: SeriesId,
    viewerId: EntityId,
    query: EpistemicViewQuery,
  ): Promise<Result<EpistemicView, AppError>> {
    const graph = this.#graph.load(seriesId);
    if (isErr(graph)) return graph;

    const viewer = graph.value.entity(viewerId);
    if (viewer === undefined) {
      return err(new NotFoundError('entity', viewerId, { context: { seriesId } }));
    }

    const at: StoryTime =
      query.at === undefined ? latestStoryTime(graph.value) : { ordinal: query.at };

    // An absent `asOf` means "as we believe it now", and "now" has to come from the
    // injected clock: this is the one place in the request where the authoring instant
    // is not carried by the caller, and reading `Date.now()` here would make two
    // replays of the same request answer differently (#1).
    const asOf = query.asOf === undefined ? this.#clock.now() : fromIso(query.asOf);

    return ok(
      buildEpistemicView(graph.value, viewerId, {
        at,
        asOf,
        cap: DEFAULT_VIEW_CAP,
        // Read off the sheet rather than guessed. An omniscient viewer has no blind
        // spots *by definition*, and it is the narrator's POV rather than a bug.
        omniscient: isOmniscient(graph.value, viewerId),
      }),
    );
  }
}

/**
 * The latest moment the series uses, for a view with no `at`.
 *
 * The largest `validFrom` rather than `validUntil`: an interval that has not ended has
 * `validUntil: null`, and the largest *ending* would stand at a moment after everything
 * the series has actually asserted.
 */
export function latestStoryTime(graph: NarrativeGraph): StoryTime {
  let ordinal = 0;
  for (const relation of graph.relations) {
    if (relation.validFrom !== null && relation.validFrom.ordinal > ordinal) {
      ordinal = relation.validFrom.ordinal;
    }
  }
  for (const entity of graph.entities) {
    if (entity.firstAppearance.ordinal > ordinal) ordinal = entity.firstAppearance.ordinal;
  }
  return { ordinal };
}

/**
 * The stops on the story-time slider.
 *
 * Every ordinal the series actually uses: where an entity first appears, and where a
 * fact starts or ends. Unioned with the episode ordinals when there are episodes, so a
 * series that has been through S2 gets its episode boundaries even for episodes no fact
 * has landed in yet.
 *
 * Labels are carried through from the author's own `validFrom.label` and never composed.
 * See `StoryMark` for why.
 */
export function storyMarksOf(
  graph: NarrativeGraph,
  episodeOrdinals: readonly number[],
): readonly StoryMark[] {
  const labels = new Map<number, string>();
  const ordinals = new Set<number>(episodeOrdinals);

  const note = (point: StoryTime | null): void => {
    if (point === null) return;
    ordinals.add(point.ordinal);
    if (point.label !== undefined && !labels.has(point.ordinal)) {
      labels.set(point.ordinal, point.label);
    }
  };

  for (const entity of graph.entities) note(entity.firstAppearance);
  for (const relation of graph.relations) {
    note(relation.validFrom);
    note(relation.validUntil);
  }

  return [...ordinals]
    .sort((left, right) => left - right)
    .slice(0, 512)
    .map((ordinal) => {
      const label = labels.get(ordinal);
      return StoryMark.parse({ at: { ordinal }, ...(label === undefined ? {} : { label }) });
    });
}

/**
 * The stops on the authoring-time slider.
 *
 * Every instant at which something was asserted or retracted. Retractions are included
 * and are the interesting half: an instant *just before* one is where "the graph as it
 * stood before the retro-fit" actually lives, and a list built only from assertions
 * would not contain it.
 */
export function revisionsOf(relations: readonly Relation[]): readonly GraphRevision[] {
  const sources = new Map<string, Set<string>>();

  const note = (instant: string | null, kind: string): void => {
    if (instant === null) return;
    const bucket = sources.get(instant);
    if (bucket === undefined) sources.set(instant, new Set([kind]));
    else bucket.add(kind);
  };

  for (const relation of relations) {
    note(relation.assertedAt, relation.sourceRef.kind);
    note(relation.retractedAt, 'retraction');
  }

  return [...sources.entries()]
    .sort(([left], [right]) => compareInstants(left, right))
    .slice(0, 256)
    .map(([at, kinds]) =>
      GraphRevision.parse({ at, label: [...kinds].sort(compareStrings).join(', ') }),
    );
}

/**
 * ISO-8601 with an offset does not sort as a string.
 *
 * `2026-08-22T16:30:00+03:30` is earlier than `2026-08-22T14:00:00Z` and sorts after it
 * lexically, so the authoring slider would present its stops out of order for any series
 * authored outside UTC - which is every series this product is for.
 */
function compareInstants(left: string, right: string): number {
  const a = fromIso(left);
  const b = fromIso(right);
  return a === b ? compareStrings(left, right) : a - b;
}
