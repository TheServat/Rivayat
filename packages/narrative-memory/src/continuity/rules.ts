/**
 * The rule pass: cheap, exact, and first.
 *
 * It runs before the LLM because it is free and because it is *right* - an interval
 * overlap is not an opinion. Everything it decides is removed from what the semantic
 * pass is shown, so the expensive half only ever looks at what judgement is actually
 * required for (docs/02 §4).
 *
 * Nine rules live here. Each one is a sentence a reader would notice:
 *
 * | rule                        | the mistake it catches                                |
 * |-----------------------------|-------------------------------------------------------|
 * | `dead-character-acting`     | someone speaks after they died                        |
 * | `character-in-two-places`   | a character is in two locations at one story moment   |
 * | `object-in-two-places`      | so is a prop                                          |
 * | `timeline-inversion`        | someone acts before they exist, or a scene asserts into its own future |
 * | `knowledge-without-source`  | a character uses a secret nobody told them            |
 * | `wardrobe-mismatch`         | an outfit they do not own, or one from another era     |
 * | `prop-mismatch`             | an object they were not carrying a scene ago           |
 * | `age-arithmetic`            | a stated age the timeline does not support            |
 * | `aired-canon-contradiction` | a new edge that contradicts frozen canon              |
 *
 * The two rules `CONTINUITY_RULES` names and this file does not implement are
 * `world-rule-broken` and the three semantic ones: all four need the series bible read
 * as prose, which is the LLM pass's job, and `unpaid-open-loop` belongs to the open-loop
 * tracker where the promise ledger already lives.
 *
 * **Zero provider calls.** Nothing in this file is async, and nothing takes a backend.
 */

import { toIso, type Instant } from '@rv/shared-kernel';
import { contains } from '@rv/core-domain';
import type {
  ContinuityIssue,
  ContinuityRule,
  ContinuitySeverity,
  EntityId,
  EpisodeId,
  Fact,
  FactId,
  Prose,
  Relation,
  RelationId,
  RelationSource,
  SceneId,
  StoryTime,
} from '@rv/contracts';

import { deriveIssueId, seed } from '../graph/derive-id';
import { compareStrings, type NarrativeGraph } from '../graph/narrative-graph';
import { FactCitations } from './citations';

/** A character acting on a specific fact. The input to the epistemic rule. */
export interface KnowledgeUse {
  readonly knowerId: EntityId;
  /** The edge whose content they used. It has to exist for the rule to say anything. */
  readonly relationId: RelationId;
  readonly note?: Prose;
}

export interface WardrobeUse {
  readonly entityId: EntityId;
  readonly wardrobeSlug: string;
}

export interface PropUse {
  readonly entityId: EntityId;
  readonly propId: EntityId;
}

export interface StatedAge {
  readonly entityId: EntityId;
  readonly years: number;
}

/**
 * One scene, as the rule pass needs to see it.
 *
 * Deliberately not `Scene` from `@rv/contracts`: that is the authoring document, and it
 * carries beats, dialogue and value shifts the rules have no use for, while carrying
 * none of the four things they do need - who *acted*, what knowledge they used, what
 * they wore and what they held. Those are extracted from the script by the same pass
 * that produces the delta.
 */
export interface SceneUnderCheck {
  readonly sceneId: SceneId;
  readonly at: StoryTime;
  readonly locationId: EntityId;
  readonly presentEntityIds?: readonly EntityId[];
  /** Who did or said something. A body in the room is not the same as a body acting. */
  readonly actingEntityIds?: readonly EntityId[];
  readonly usesKnowledge?: readonly KnowledgeUse[];
  readonly wardrobe?: readonly WardrobeUse[];
  readonly props?: readonly PropUse[];
  readonly statedAges?: readonly StatedAge[];
  /** One paragraph, for the semantic pass. Unused by the rules. */
  readonly synopsis?: Prose;
}

export interface ContinuityRuleOptions {
  /**
   * How many story ordinals make a year.
   *
   * Story ordinals are an arbitrary total order (`StoryTime` is "deliberately not a real
   * date"), so age arithmetic needs the series to say what one tick is worth. Default 1,
   * because a series that never states an age never reaches this rule anyway.
   */
  readonly storyOrdinalsPerYear?: number;
  /** Slack on a stated age, in years. One, because "he's about thirty" is not a bug. */
  readonly ageToleranceYears?: number;
}

export interface ContinuityRuleInput extends ContinuityRuleOptions {
  readonly graph: NarrativeGraph;
  readonly episodeId: EpisodeId;
  readonly scenes: readonly SceneUnderCheck[];
  /** The authoring standpoint. Facts written after it are not yet part of the check. */
  readonly asOf: Instant;
}

export interface ContinuityRuleReport {
  readonly issues: readonly ContinuityIssue[];
  /**
   * The facts the findings cite, materialised.
   *
   * Persist these with the issues or half the citations resolve to nothing.
   */
  readonly citedFacts: readonly Fact[];
}

const INACTIVE = new Set(['dead', 'destroyed', 'unborn']);

export function runContinuityRules(input: ContinuityRuleInput): ContinuityRuleReport {
  const { graph, episodeId, scenes, asOf } = input;
  const cite = new FactCitations(graph.seriesId, toIso(asOf), graph.facts);
  const issues: ContinuityIssue[] = [];

  const emit = (
    rule: ContinuityRule,
    severity: ContinuitySeverity,
    parts: {
      readonly sceneId?: SceneId;
      readonly entities: readonly EntityId[];
      readonly conflictingFacts: readonly FactId[];
      readonly explanation: Prose;
      readonly suggestedFix?: Prose;
    },
  ): void => {
    issues.push({
      id: deriveIssueId(seed(graph.seriesId, episodeId, rule, ...parts.conflictingFacts)),
      seriesId: graph.seriesId,
      episodeId,
      ...(parts.sceneId !== undefined ? { sceneId: parts.sceneId } : {}),
      severity,
      rule,
      detectedBy: 'rule',
      entities: [...parts.entities].sort(compareStrings),
      conflictingFacts: [...parts.conflictingFacts],
      explanation: parts.explanation,
      ...(parts.suggestedFix !== undefined ? { suggestedFix: parts.suggestedFix } : {}),
      confidence: 1,
    });
  };

  const sceneSource = (sceneId: SceneId): RelationSource => ({
    kind: 'episode',
    episodeId,
    sceneId,
  });

  // ── 1. dead characters acting ─────────────────────────────────────────────
  for (const scene of scenes) {
    for (const entityId of sorted(scene.actingEntityIds)) {
      const status = graph.statusAt(entityId, scene.at);
      if (!INACTIVE.has(status)) continue;
      const name = nameOf(graph, entityId);
      emit('dead-character-acting', 'error', {
        sceneId: scene.sceneId,
        entities: [entityId],
        conflictingFacts: [
          cite.statement(
            `${name} acts in scene ${scene.sceneId} at story time ${String(scene.at.ordinal)}.`,
            scene.at,
            sceneSource(scene.sceneId),
          ),
          cite.statement(
            `${name} is ${status} from story time ${String(statusOnsetOrdinal(graph, entityId, scene.at))}.`,
            scene.at,
            { kind: 'inferred', rule: 'vitality ledger' },
          ),
        ],
        explanation: `${name} acts in this scene, but the world state says they are ${status} by story time ${String(scene.at.ordinal)}.`,
        suggestedFix: `Either move the scene before the death, or make this an appearance the fiction accounts for (a vision, a corpse, a body double) and record it as such.`,
      });
    }
  }

  // ── 2 & 3. one body, one place ────────────────────────────────────────────
  for (const contradiction of graph.index.findContradictions()) {
    if (contradiction.kind !== 'conflicting-object') continue;
    if (contradiction.left.type !== 'located-in') continue;
    const subject = contradiction.left.from;
    const rule: ContinuityRule =
      graph.entity(subject)?.kind === 'character'
        ? 'character-in-two-places'
        : 'object-in-two-places';
    emit(rule, 'error', {
      entities: [subject, contradiction.left.to, contradiction.right.to],
      conflictingFacts: [cite.relation(contradiction.left), cite.relation(contradiction.right)],
      explanation: `${nameOf(graph, subject)} is in ${nameOf(graph, contradiction.left.to)} and in ${nameOf(graph, contradiction.right.to)} over an overlapping stretch of story time. ${contradiction.explanation}.`,
      suggestedFix: `Close one of the two "located-in" edges at the moment the move happens instead of leaving both open.`,
    });
  }

  // Same story moment, two scenes, two rooms. The graph cannot see this one: both edges
  // may be perfectly well-formed and the scenes are what disagree.
  for (const [entityId, placements] of placementsByEntity(scenes)) {
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const left = placements[i];
        const right = placements[j];
        if (left === undefined || right === undefined) continue;
        if (left.at.ordinal !== right.at.ordinal) continue;
        if (left.locationId === right.locationId) continue;
        const rule: ContinuityRule =
          graph.entity(entityId)?.kind === 'character'
            ? 'character-in-two-places'
            : 'object-in-two-places';
        emit(rule, 'error', {
          sceneId: left.sceneId,
          entities: [entityId, left.locationId, right.locationId],
          conflictingFacts: [
            cite.statement(
              `${nameOf(graph, entityId)} is present in scene ${left.sceneId}, in ${nameOf(graph, left.locationId)}.`,
              left.at,
              sceneSource(left.sceneId),
            ),
            cite.statement(
              `${nameOf(graph, entityId)} is present in scene ${right.sceneId}, in ${nameOf(graph, right.locationId)}.`,
              right.at,
              sceneSource(right.sceneId),
            ),
          ],
          explanation: `${nameOf(graph, entityId)} is in two scenes that both play at story time ${String(left.at.ordinal)}, in different locations.`,
          suggestedFix: `Separate the two scenes in story time, or cut the entity from one of them.`,
        });
      }
    }
  }

  // ── 4. timeline inversion ─────────────────────────────────────────────────
  for (const scene of scenes) {
    for (const entityId of sorted([
      ...(scene.actingEntityIds ?? []),
      ...(scene.presentEntityIds ?? []),
    ])) {
      const entity = graph.entity(entityId);
      if (entity === undefined) continue;
      if (entity.firstAppearance.ordinal <= scene.at.ordinal) continue;
      emit('timeline-inversion', 'error', {
        sceneId: scene.sceneId,
        entities: [entityId],
        conflictingFacts: [
          cite.statement(
            `${entity.canonicalName} appears in scene ${scene.sceneId} at story time ${String(scene.at.ordinal)}.`,
            scene.at,
            sceneSource(scene.sceneId),
          ),
          cite.statement(
            `${entity.canonicalName} first exists at story time ${String(entity.firstAppearance.ordinal)}.`,
            entity.firstAppearance,
            { kind: 'inferred', rule: 'entity.firstAppearance' },
          ),
        ],
        explanation: `${entity.canonicalName} appears at story time ${String(scene.at.ordinal)}, which is before their first appearance at ${String(entity.firstAppearance.ordinal)}.`,
        suggestedFix: `Move \`firstAppearance\` back to this scene if this is genuinely their earliest appearance; otherwise the scene is out of order.`,
      });
    }

    // A scene that asserts a fact into its own future is the other half of the same
    // mistake: the edge is well-formed, it just cannot have been established here.
    for (const relation of relationsFromScene(graph, scene.sceneId)) {
      if (relation.validFrom === null || relation.validFrom.ordinal <= scene.at.ordinal) continue;
      emit('timeline-inversion', 'error', {
        sceneId: scene.sceneId,
        entities: [relation.from, relation.to],
        conflictingFacts: [
          cite.relation(relation),
          cite.statement(
            `Scene ${scene.sceneId} plays at story time ${String(scene.at.ordinal)}.`,
            scene.at,
            sceneSource(scene.sceneId),
          ),
        ],
        explanation: `Scene ${scene.sceneId} plays at story time ${String(scene.at.ordinal)} but asserts "${relation.fact}" as true from ${String(relation.validFrom.ordinal)}, which is later.`,
        suggestedFix: `Set \`validFrom\` to the scene's own story time, or move the assertion to the scene where it actually happens.`,
      });
    }
  }

  // ── 5. knowledge without a source ─────────────────────────────────────────
  for (const scene of scenes) {
    for (const use of scene.usesKnowledge ?? []) {
      const relation = graph.relation(use.relationId);
      if (relation === undefined) continue;
      // Both clock positions are mandatory here. `couldKnow` with no standpoint
      // consults every epistemic edge the character will *ever* hold, so a scene at
      // episode 5 would be cleared by a reveal that has not happened yet - which is
      // the exact failure this rule exists to catch.
      if (graph.index.couldKnow(use.knowerId, relation, { storyAt: scene.at, authoredAt: asOf })) {
        continue;
      }
      const knower = nameOf(graph, use.knowerId);
      emit('knowledge-without-source', 'error', {
        sceneId: scene.sceneId,
        entities: [use.knowerId, relation.from, relation.to],
        conflictingFacts: [
          cite.relation(relation),
          cite.statement(
            use.note ??
              `${knower} acts on "${relation.fact}" in scene ${scene.sceneId} at story time ${String(scene.at.ordinal)}.`,
            scene.at,
            sceneSource(scene.sceneId),
          ),
        ],
        explanation: `${knower} acts on "${relation.fact}", but at story time ${String(scene.at.ordinal)} they hold no epistemic edge that reaches it and the fact is ${relation.visibility}, not public.`,
        suggestedFix: `Add the scene where they are told, or give them a "suspects" edge earlier and let this scene be the confirmation.`,
      });
    }
  }

  // ── 6. wardrobe ───────────────────────────────────────────────────────────
  const previousOutfit = new Map<EntityId, { slug: string; scene: SceneUnderCheck }>();
  for (const scene of scenes) {
    for (const worn of [...(scene.wardrobe ?? [])].sort((a, b) =>
      compareStrings(a.entityId, b.entityId),
    )) {
      const entity = graph.entity(worn.entityId);
      const outfit =
        entity?.kind === 'character'
          ? entity.payload.visual.wardrobe.find((set) => set.slug === worn.wardrobeSlug)
          : undefined;
      const name = nameOf(graph, worn.entityId);

      if (entity?.kind === 'character' && outfit === undefined) {
        emit('wardrobe-mismatch', 'warning', {
          sceneId: scene.sceneId,
          entities: [worn.entityId],
          conflictingFacts: [
            cite.statement(
              `${name} wears "${worn.wardrobeSlug}" in scene ${scene.sceneId}.`,
              scene.at,
              sceneSource(scene.sceneId),
            ),
            cite.statement(
              `${name}'s wardrobe is: ${entity.payload.visual.wardrobe.map((set) => set.slug).join(', ') || '(none defined)'}.`,
              null,
              { kind: 'inferred', rule: 'character.visual.wardrobe' },
            ),
          ],
          explanation: `${name} is dressed in "${worn.wardrobeSlug}", which is not one of their defined outfits. The asset key for it does not exist, so the shot cannot resolve.`,
          suggestedFix: `Add "${worn.wardrobeSlug}" to their wardrobe with a story-time validity, or use an outfit they own.`,
        });
      } else if (outfit !== undefined && !contains(outfit.validity, scene.at)) {
        emit('wardrobe-mismatch', 'warning', {
          sceneId: scene.sceneId,
          entities: [worn.entityId],
          conflictingFacts: [
            cite.statement(
              `${name} wears "${worn.wardrobeSlug}" at story time ${String(scene.at.ordinal)}.`,
              scene.at,
              sceneSource(scene.sceneId),
            ),
            cite.statement(
              `"${worn.wardrobeSlug}" is worn from ${String(outfit.validity.from?.ordinal ?? 'the beginning')} until ${String(outfit.validity.until?.ordinal ?? 'the end')}.`,
              outfit.validity.from,
              { kind: 'inferred', rule: 'wardrobe.validity' },
            ),
          ],
          explanation: `${name} wears "${worn.wardrobeSlug}" at story time ${String(scene.at.ordinal)}, outside the stretch of story time that outfit belongs to.`,
          suggestedFix: `Widen the outfit's validity, or dress them in the one that covers this moment.`,
        });
      }

      const before = previousOutfit.get(worn.entityId);
      if (
        before !== undefined &&
        before.slug !== worn.wardrobeSlug &&
        before.scene.at.ordinal === scene.at.ordinal
      ) {
        emit('wardrobe-mismatch', 'warning', {
          sceneId: scene.sceneId,
          entities: [worn.entityId],
          conflictingFacts: [
            cite.statement(
              `${name} wears "${before.slug}" in scene ${before.scene.sceneId}.`,
              before.scene.at,
              sceneSource(before.scene.sceneId),
            ),
            cite.statement(
              `${name} wears "${worn.wardrobeSlug}" in scene ${scene.sceneId}.`,
              scene.at,
              sceneSource(scene.sceneId),
            ),
          ],
          explanation: `${name} changes from "${before.slug}" to "${worn.wardrobeSlug}" between two scenes that play at the same story time.`,
          suggestedFix: `Keep one outfit across the moment, or separate the scenes in story time so the change has somewhere to happen.`,
        });
      }
      previousOutfit.set(worn.entityId, { slug: worn.wardrobeSlug, scene });
    }
  }

  // ── 7. props ──────────────────────────────────────────────────────────────
  for (const scene of scenes) {
    for (const use of [...(scene.props ?? [])].sort(
      (a, b) => compareStrings(a.entityId, b.entityId) || compareStrings(a.propId, b.propId),
    )) {
      const held = graph.index.query({
        from: use.entityId,
        to: use.propId,
        types: ['carries', 'owns'],
        storyAt: scene.at,
        authoredAt: asOf,
      });
      if (held.length > 0) continue;
      const holder = nameOf(graph, use.entityId);
      const prop = nameOf(graph, use.propId);
      emit('prop-mismatch', 'warning', {
        sceneId: scene.sceneId,
        entities: [use.entityId, use.propId],
        conflictingFacts: [
          cite.statement(
            `${holder} uses ${prop} in scene ${scene.sceneId}.`,
            scene.at,
            sceneSource(scene.sceneId),
          ),
          cite.statement(
            `${holder} holds no "carries" or "owns" edge to ${prop} at story time ${String(scene.at.ordinal)}.`,
            scene.at,
            { kind: 'inferred', rule: 'possession edges at scene story time' },
          ),
        ],
        explanation: `${holder} uses ${prop}, but nothing in the graph has them holding it at story time ${String(scene.at.ordinal)}.`,
        suggestedFix: `Add the beat where they pick it up, or record a possession change in an earlier scene.`,
      });
    }
  }

  // ── 8. age arithmetic ─────────────────────────────────────────────────────
  const perYear = input.storyOrdinalsPerYear ?? 1;
  const tolerance = input.ageToleranceYears ?? 1;
  for (const scene of scenes) {
    for (const stated of [...(scene.statedAges ?? [])].sort((a, b) =>
      compareStrings(a.entityId, b.entityId),
    )) {
      const entity = graph.entity(stated.entityId);
      if (entity?.kind !== 'character') continue;
      const base = entity.payload.identity.ageYears;
      if (base === undefined) continue; // Ageless is an answer, not a gap.
      const elapsed = Math.floor((scene.at.ordinal - entity.firstAppearance.ordinal) / perYear);
      const expected = base + elapsed;
      if (Math.abs(stated.years - expected) <= tolerance) continue;
      emit('age-arithmetic', 'error', {
        sceneId: scene.sceneId,
        entities: [stated.entityId],
        conflictingFacts: [
          cite.statement(
            `${entity.canonicalName} is stated to be ${String(stated.years)} in scene ${scene.sceneId}.`,
            scene.at,
            sceneSource(scene.sceneId),
          ),
          cite.statement(
            `${entity.canonicalName} is ${String(base)} at story time ${String(entity.firstAppearance.ordinal)}.`,
            entity.firstAppearance,
            { kind: 'inferred', rule: 'character.identity.ageYears' },
          ),
        ],
        explanation: `${entity.canonicalName} is stated to be ${String(stated.years)}, but ${String(elapsed)} year(s) of story time have passed since they were ${String(base)}, which makes them ${String(expected)}.`,
        suggestedFix: `Correct the line, or adjust \`identity.ageYears\` if the sheet is what is wrong.`,
      });
    }
  }

  // ── 9. frozen canon ───────────────────────────────────────────────────────
  for (const contradiction of graph.index.findContradictions()) {
    const leftAired = isAiredCanon(graph, contradiction.left);
    const rightAired = isAiredCanon(graph, contradiction.right);
    if (leftAired === rightAired) continue; // Both frozen, or neither: not this rule.
    const frozen = leftAired ? contradiction.left : contradiction.right;
    const fresh = leftAired ? contradiction.right : contradiction.left;
    emit('aired-canon-contradiction', 'error', {
      entities: [fresh.from, fresh.to],
      conflictingFacts: [cite.relation(frozen), cite.relation(fresh)],
      explanation: `"${fresh.fact}" contradicts "${frozen.fact}", which an aired episode already asserted. Aired canon may be extended or revealed, never contradicted.`,
      suggestedFix: `Bound the aired fact at the moment it stops being true instead of asserting against it, or reveal the new fact as something that was always secretly the case.`,
    });
  }

  return {
    issues: issues.sort((a, b) => compareStrings(a.id, b.id)),
    citedFacts: cite.facts,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sorted(ids: readonly EntityId[] | undefined): readonly EntityId[] {
  return [...new Set(ids ?? [])].sort(compareStrings);
}

function nameOf(graph: NarrativeGraph, entityId: EntityId): string {
  return graph.entity(entityId)?.canonicalName ?? entityId;
}

function statusOnsetOrdinal(graph: NarrativeGraph, entityId: EntityId, at: StoryTime): number {
  let onset = at.ordinal;
  for (const record of graph.vitality) {
    if (record.entityId !== entityId) continue;
    if (record.at.ordinal > at.ordinal) break;
    onset = record.at.ordinal;
  }
  return onset;
}

function relationsFromScene(graph: NarrativeGraph, sceneId: SceneId): readonly Relation[] {
  return graph.relations.filter(
    (relation) => relation.sourceRef.kind === 'episode' && relation.sourceRef.sceneId === sceneId,
  );
}

function isAiredCanon(graph: NarrativeGraph, relation: Relation): boolean {
  return (
    relation.sourceRef.kind === 'episode' && graph.airedEpisodes.has(relation.sourceRef.episodeId)
  );
}

interface Placement {
  readonly sceneId: SceneId;
  readonly at: StoryTime;
  readonly locationId: EntityId;
}

function placementsByEntity(
  scenes: readonly SceneUnderCheck[],
): ReadonlyMap<EntityId, readonly Placement[]> {
  const byEntity = new Map<EntityId, Placement[]>();
  for (const scene of scenes) {
    for (const entityId of sorted([
      ...(scene.presentEntityIds ?? []),
      ...(scene.actingEntityIds ?? []),
    ])) {
      const placement: Placement = {
        sceneId: scene.sceneId,
        at: scene.at,
        locationId: scene.locationId,
      };
      const bucket = byEntity.get(entityId);
      if (bucket === undefined) byEntity.set(entityId, [placement]);
      else bucket.push(placement);
    }
  }
  return new Map([...byEntity.entries()].sort(([left], [right]) => compareStrings(left, right)));
}
