/**
 * Applying a `StateDelta` to the graph.
 *
 * The rule that shapes this file: **a fact that stops being true is bounded, not
 * deleted.** Deleting the edge that says Kael believes his parents died in the fire
 * destroys the ability to ask what he believed in episode 5, which is the entire reason
 * the store carries a story clock at all. So every ending is `closeAt` -
 * `validUntil` is set, the row survives, and an as-of query at an earlier story time
 * still returns it.
 *
 * `validUntil` and `retractedAt` are not interchangeable and this file only ever writes
 * the first. A scene ending a fact is a story-time event: it *was* true and now is not.
 * Retraction is an authoring-time event - we were wrong to have written it - and no
 * scene can perform one.
 *
 * The fold is deterministic and idempotent. Ids are derived from content
 * (`derive-id.ts`), bounding an already-bounded edge is a no-op, and every emitted array
 * is sorted, so folding the same delta twice produces a byte-identical graph.
 */

import { type Clock, type Result, ok, toIso } from '@rv/shared-kernel';
import { closeAt } from '@rv/core-domain';
import type {
  EntityId,
  KnowledgeChange,
  OpenLoop,
  Relation,
  RelationId,
  RelationSource,
  RelationType,
  StateDelta,
  StoryTime,
} from '@rv/contracts';

import { deriveRelationId, seed } from '../graph/derive-id';
import { compareStrings, type NarrativeGraph, type VitalityRecord } from '../graph/narrative-graph';

/** One edge that stopped being true, with both versions kept for the audit trail. */
export interface BoundedRelation {
  readonly before: Relation;
  readonly after: Relation;
  readonly why: 'scene-retraction' | 'moved' | 'handed-over' | 'disproved' | 'forgotten';
}

export const SKIP_REASONS = [
  'relation-not-found',
  'already-ended',
  'starts-at-or-after-boundary',
  'no-target-edge',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * A change the fold declined to apply, and why.
 *
 * Surfaced rather than swallowed for the same reason unresolved mentions are: a delta
 * that half-applied and reported success is a graph that disagrees with the script, and
 * nothing downstream can tell.
 */
export interface SkippedChange {
  readonly reason: SkipReason;
  readonly what: string;
  readonly relationId?: RelationId;
  readonly entityId?: EntityId;
}

export interface FoldResult {
  readonly graph: NarrativeGraph;
  /** Edges created by the fold: the asserted ones plus those derived from the changes. */
  readonly added: readonly Relation[];
  readonly bounded: readonly BoundedRelation[];
  readonly vitality: readonly VitalityRecord[];
  readonly paidLoops: readonly OpenLoop[];
  readonly skipped: readonly SkippedChange[];
}

export interface FoldStateDeltaInput {
  readonly graph: NarrativeGraph;
  readonly delta: StateDelta;
  /**
   * Edges the extractor minted for this delta.
   *
   * Passed alongside rather than looked up, because `StateDelta.relationsAsserted` holds
   * ids and the rows themselves do not exist in the graph yet - the delta is the
   * manifest, these are the goods.
   */
  readonly relations?: readonly Relation[];
  readonly openLoops?: readonly OpenLoop[];
}

export interface FoldStateDeltaDeps {
  readonly clock: Clock;
}

/** Modes that leave the item with nobody holding it. */
const RELEASING_MODES = new Set(['lost', 'destroyed']);

export class FoldStateDeltaUseCase {
  readonly #clock: Clock;

  constructor(deps: FoldStateDeltaDeps) {
    this.#clock = deps.clock;
  }

  execute(input: FoldStateDeltaInput): Result<FoldResult> {
    const { graph, delta } = input;
    const at = delta.at;
    const assertedAt = toIso(this.#clock.now());
    const sourceRef: RelationSource = {
      kind: 'episode',
      episodeId: delta.episodeId,
      sceneId: delta.sceneId,
    };

    // A working map keyed by id: bounding edits a row in place, and the fold must never
    // leave the bounded copy sitting beside its unbounded original.
    const working = new Map<RelationId, Relation>(
      graph.relations.map((relation) => [relation.id, relation]),
    );
    const added: Relation[] = [];
    const bounded: BoundedRelation[] = [];
    const skipped: SkippedChange[] = [];

    const bound = (relation: Relation, why: BoundedRelation['why']): void => {
      if (relation.validUntil !== null) {
        skipped.push({ reason: 'already-ended', what: why, relationId: relation.id });
        return;
      }
      if (relation.validFrom !== null && relation.validFrom.ordinal >= at.ordinal) {
        // Closing at or before the start would produce an empty interval, which
        // `isWellFormed` rejects and which means "this was never true" rather than
        // "this stopped being true".
        skipped.push({
          reason: 'starts-at-or-after-boundary',
          what: why,
          relationId: relation.id,
        });
        return;
      }
      const span = closeAt({ from: relation.validFrom, until: relation.validUntil }, at);
      const after: Relation = { ...relation, validFrom: span.from, validUntil: span.until };
      working.set(after.id, after);
      bounded.push({ before: relation, after, why });
    };

    const add = (
      from: EntityId,
      to: EntityId,
      type: RelationType,
      fact: string,
      visibility: Relation['visibility'] = 'public',
    ): void => {
      const id = deriveRelationId(seed(graph.seriesId, delta.sceneId, from, to, type, fact));
      if (working.has(id)) return; // Idempotent: the same fold twice is the same graph.
      const relation: Relation = {
        id,
        seriesId: graph.seriesId,
        from,
        to,
        type,
        fact,
        strength: 0,
        validFrom: at,
        validUntil: null,
        assertedAt,
        retractedAt: null,
        sourceRef,
        confidence: 1,
        visibility,
      };
      working.set(id, relation);
      added.push(relation);
    };

    // ── 1. the edges the scene asserted ─────────────────────────────────────
    for (const relation of input.relations ?? []) {
      if (working.has(relation.id)) continue;
      working.set(relation.id, relation);
      added.push(relation);
    }

    // ── 2. the edges the scene ended ────────────────────────────────────────
    for (const relationId of delta.relationsRetracted) {
      const relation = working.get(relationId);
      if (relation === undefined) {
        skipped.push({ reason: 'relation-not-found', what: 'scene-retraction', relationId });
        continue;
      }
      bound(relation, 'scene-retraction');
    }

    // ── 3. movement ─────────────────────────────────────────────────────────
    for (const move of delta.positionChanges) {
      const standing = this.#standing(working, move.entityId, ['located-in'], at);
      // A "move" that lands where they already are is a no-op, not a fresh edge beside
      // the identical one already standing. Re-asserting it would leave two placements
      // overlapping, which is precisely what `character-in-two-places` fires on.
      if (move.to !== null && standing.some((relation) => relation.to === move.to)) continue;
      for (const relation of standing) bound(relation, 'moved');
      if (move.to !== null) {
        add(move.entityId, move.to, 'located-in', factForMove(move.entityId, move.to, graph));
      }
    }

    // ── 4. possession ───────────────────────────────────────────────────────
    for (const handover of delta.possessionChanges) {
      const held = this.#held(working, handover.itemId, at);
      if (handover.to !== null && held.some((relation) => relation.from === handover.to)) continue;
      for (const relation of held) bound(relation, 'handed-over');
      if (handover.to !== null && !RELEASING_MODES.has(handover.mode)) {
        add(
          handover.to,
          handover.itemId,
          'carries',
          factForHandover(handover.to, handover.itemId, graph),
        );
      }
    }

    // ── 5. belief endings ───────────────────────────────────────────────────
    for (const change of delta.knowledgeChanges) {
      if (change.change !== 'disproved' && change.change !== 'forgot') continue;
      const targets = this.#beliefsToClose(working, change, at);
      if (targets.length === 0) {
        skipped.push({
          reason: 'no-target-edge',
          what: change.change,
          entityId: change.knowerId,
        });
        continue;
      }
      for (const target of targets)
        bound(target, change.change === 'forgot' ? 'forgotten' : 'disproved');
    }

    // ── 6. status ───────────────────────────────────────────────────────────
    const vitality: VitalityRecord[] = delta.vitalityChanges.map((change) => ({
      entityId: change.entityId,
      status: change.to,
      at,
      sourceRef,
    }));

    // ── 7. promises ─────────────────────────────────────────────────────────
    const loopsById = new Map<string, OpenLoop>(
      [...graph.openLoops, ...(input.openLoops ?? [])].map((loop) => [loop.id, loop]),
    );
    const paidLoops: OpenLoop[] = [];
    for (const loopId of delta.openLoopsPaid) {
      const loop = loopsById.get(loopId);
      if (loop === undefined) continue;
      const paid: OpenLoop = {
        ...loop,
        status: 'paid',
        paidIn: { episodeId: delta.episodeId, sceneId: delta.sceneId, at },
      };
      loopsById.set(loopId, paid);
      paidLoops.push(paid);
    }

    const next = graph.with({
      relations: [...working.values()],
      openLoops: [...loopsById.values()],
      vitality: [...graph.vitality, ...vitality],
    });

    return ok({
      graph: next,
      added: [...added].sort((a, b) => compareStrings(a.id, b.id)),
      bounded: [...bounded].sort((a, b) => compareStrings(a.before.id, b.before.id)),
      vitality,
      paidLoops,
      skipped,
    });
  }

  /** Standing edges of `types` out of `entity`, valid at `at` and not already ended. */
  #standing(
    working: ReadonlyMap<RelationId, Relation>,
    entity: EntityId,
    types: readonly RelationType[],
    at: StoryTime,
  ): readonly Relation[] {
    const found: Relation[] = [];
    for (const relation of working.values()) {
      if (relation.from !== entity) continue;
      if (!types.includes(relation.type)) continue;
      if (relation.validUntil !== null) continue;
      if (relation.retractedAt !== null) continue;
      if (relation.validFrom !== null && relation.validFrom.ordinal > at.ordinal) continue;
      found.push(relation);
    }
    return found.sort((a, b) => compareStrings(a.id, b.id));
  }

  /** Standing possession edges *pointing at* the item, whoever holds it. */
  #held(
    working: ReadonlyMap<RelationId, Relation>,
    itemId: EntityId,
    at: StoryTime,
  ): readonly Relation[] {
    const found: Relation[] = [];
    for (const relation of working.values()) {
      if (relation.to !== itemId) continue;
      if (relation.type !== 'carries' && relation.type !== 'owns') continue;
      if (relation.validUntil !== null) continue;
      if (relation.retractedAt !== null) continue;
      if (relation.validFrom !== null && relation.validFrom.ordinal > at.ordinal) continue;
      found.push(relation);
    }
    return found.sort((a, b) => compareStrings(a.id, b.id));
  }

  /**
   * The belief edges a `disproved` or `forgot` change closes.
   *
   * `aboutRelationId` when the extractor supplied one - it always does for a change it
   * derived from an edge - and otherwise every standing epistemic edge from that knower
   * whose sentence matches the proposition. The text fallback exists because an
   * author-written delta has no relation id to give.
   */
  #beliefsToClose(
    working: ReadonlyMap<RelationId, Relation>,
    change: KnowledgeChange,
    at: StoryTime,
  ): readonly Relation[] {
    if (change.aboutRelationId !== undefined) {
      const direct = working.get(change.aboutRelationId);
      return direct === undefined ? [] : [direct];
    }
    const wanted =
      change.change === 'forgot'
        ? (['knows', 'witnessed', 'told'] as const)
        : (['believes-falsely', 'suspects', 'knows'] as const);
    return this.#standing(working, change.knowerId, wanted, at).filter(
      (relation) => relation.fact === change.proposition,
    );
  }
}

function factForMove(entityId: EntityId, locationId: EntityId, graph: NarrativeGraph): string {
  return `${nameOf(graph, entityId)} is in ${nameOf(graph, locationId)}.`;
}

function factForHandover(holderId: EntityId, itemId: EntityId, graph: NarrativeGraph): string {
  return `${nameOf(graph, holderId)} carries ${nameOf(graph, itemId)}.`;
}

/**
 * The canonical name, or the id.
 *
 * The id is a poor sentence but it is a true one, and a fact string is read by humans
 * and embedded for retrieval - neither of which is served by throwing because a node
 * introduced by this very scene does not have a sheet yet.
 */
function nameOf(graph: NarrativeGraph, entityId: EntityId): string {
  return graph.entity(entityId)?.canonicalName ?? entityId;
}
