/**
 * The world, resolved at one point on each clock.
 *
 * Derived, never stored. `WorldStateSnapshot` is a projection of the graph, and
 * recomputing it is cheap enough that caching it would only create a second thing that
 * can be stale - which for a continuity checker is worse than slow.
 *
 * Everything is sorted and every map is rebuilt from scratch, so the same graph folded
 * twice is deep-equal. That is asserted rather than assumed: "memory is a state machine,
 * not a transcript" is only true if replaying the machine lands in the same state.
 */

import type { Instant } from '@rv/shared-kernel';
import { toIso } from '@rv/shared-kernel';
import type {
  EntityId,
  EntityStateEntry,
  EpistemicView,
  StoryTime,
  WorldStateSnapshot,
} from '@rv/contracts';

import { buildEpistemicView, isOmniscient } from '../graph/epistemic-view';
import { compareStrings, type NarrativeGraph } from '../graph/narrative-graph';

export interface WorldStateOptions {
  readonly at: StoryTime;
  readonly asOf: Instant;
  /**
   * Whose heads to resolve.
   *
   * Defaults to every character. Narrowing it matters on a large series: an epistemic
   * view is a graph walk per viewer, and a continuity pass over one scene needs four of
   * them, not four hundred.
   */
  readonly viewers?: readonly EntityId[];
}

export function foldWorldState(
  graph: NarrativeGraph,
  options: WorldStateOptions,
): WorldStateSnapshot {
  const { at, asOf } = options;
  const standpoint = { storyAt: at, authoredAt: asOf };

  const entities: EntityStateEntry[] = graph.entities
    .map((entity) => ({
      entityId: entity.id,
      status: graph.statusAt(entity.id, at),
      importance: entity.importance,
    }))
    .sort((a, b) => compareStrings(a.entityId, b.entityId));

  const positions: Record<string, EntityId> = {};
  for (const relation of graph.index.query({ ...standpoint, types: ['located-in'] })) {
    positions[relation.from] = relation.to;
  }

  const possessions: Record<string, EntityId[]> = {};
  for (const relation of graph.index.query({ ...standpoint, types: ['carries', 'owns'] })) {
    const held = possessions[relation.from] ?? [];
    if (!held.includes(relation.to)) held.push(relation.to);
    possessions[relation.from] = held;
  }
  for (const holder of Object.keys(possessions)) {
    possessions[holder] = (possessions[holder] ?? []).sort(compareStrings);
  }

  const viewers =
    options.viewers ??
    graph.entities.filter((entity) => entity.kind === 'character').map((entity) => entity.id);

  const knowledge: Record<string, EpistemicView> = {};
  for (const viewer of [...viewers].sort(compareStrings)) {
    knowledge[viewer] = buildEpistemicView(graph, viewer, {
      at,
      asOf,
      omniscient: isOmniscient(graph, viewer),
    });
  }

  return {
    seriesId: graph.seriesId,
    at,
    asOf: toIso(asOf),
    stateHash: graph.stateHash,
    entities,
    positions: sortKeys(positions),
    possessions: sortKeys(possessions),
    knowledge: sortKeys(knowledge),
  };
}

/**
 * Rebuilds an object with its keys in byte order.
 *
 * Insertion order is observable through `Object.keys`, `JSON.stringify` and therefore
 * `contentHash`. Two snapshots folded from the same graph must hash the same whichever
 * order the edges happened to arrive in.
 */
function sortKeys<T>(source: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(source).sort(compareStrings)) {
    const value = source[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}
