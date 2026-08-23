/**
 * Scene text in, `StateDelta` out.
 *
 * Two stages, and the split is the whole design. The model is asked for observations
 * carrying **names** (`observations.ts`); we resolve those names to ids ourselves
 * (`coreference.ts`). A single-stage prompt that asks for ids gets invented ids, and an
 * edge pointing at a node that does not exist is not detectable until something tries to
 * render it.
 *
 * What comes back is deliberately more than a `StateDelta`. The delta names relations by
 * id, so the relations themselves have to be minted here; the entities the scene
 * introduced cannot be minted here, because an `Entity` needs a full typed payload that
 * a continuity extractor has no business inventing. So the result carries the delta, the
 * minted edges, drafts of the new nodes, the promises planted - and the mentions that
 * resolved to nothing, which is the field a caller must not ignore.
 */

import { type Clock, type Result, err, isErr, ok, toIso, ValidationError } from '@rv/shared-kernel';
import type { StructuredBackend, StructuredTrace } from '@rv/prompt-kit';
import { StructuredCall } from '@rv/prompt-kit';
import type {
  EntityId,
  EntityKind,
  EpisodeId,
  Importance,
  KnowledgeChange,
  KnowledgeChangeKind,
  OpenLoop,
  PositionChange,
  PossessionChange,
  Prose,
  Relation,
  RelationId,
  RelationSource,
  RelationType,
  SceneId,
  StateDelta,
  StoryTime,
  VitalityChange,
} from '@rv/contracts';
import { isEpistemicRelation } from '@rv/contracts';

import { deriveEntityId, deriveOpenLoopId, deriveRelationId, seed } from '../graph/derive-id';
import type { NarrativeGraph } from '../graph/narrative-graph';
import { compareStrings } from '../graph/narrative-graph';
import { MentionResolver, ResolutionLog, type UnresolvedMention } from './coreference';
import {
  SCENE_OBSERVATION_SYSTEM_PROMPT,
  SceneObservations,
  type ObservedRelation,
} from './observations';

/**
 * A node the scene introduced, as much of it as an extractor can honestly know.
 *
 * Not an `Entity`: a `CharacterPayload` needs psychology, voice, arc, visual and motion
 * signature, and a model asked for all of that while extracting continuity produces
 * confident filler. The story engine builds the sheet; this says one exists and what it
 * is called.
 */
export interface IntroducedEntity {
  readonly entityId: EntityId;
  readonly mention: string;
  readonly kind: EntityKind;
  readonly importance: Importance;
  readonly summary: Prose;
  readonly firstAppearance: StoryTime;
}

/** A retraction the scene asserted against an edge the graph does not hold. */
export interface UnmatchedRetraction {
  readonly observation: ObservedRelation;
  readonly subjectId: EntityId;
  readonly objectId: EntityId;
}

export interface ExtractedScene {
  readonly delta: StateDelta;
  /** Edges the scene brought into being, ids already minted and both clocks stamped. */
  readonly relations: readonly Relation[];
  readonly introduced: readonly IntroducedEntity[];
  readonly openLoops: readonly OpenLoop[];
  /**
   * Names that resolved to nothing, or to more than one node.
   *
   * Never empty-by-omission: an observation whose subject could not be resolved is
   * dropped from the delta and recorded here, so "the extractor saw it and we lost it"
   * and "the extractor never saw it" are distinguishable.
   */
  readonly unresolved: readonly UnresolvedMention[];
  readonly unmatchedRetractions: readonly UnmatchedRetraction[];
  readonly trace: StructuredTrace;
}

export interface ExtractSceneDeltaInput {
  readonly graph: NarrativeGraph;
  readonly sceneId: SceneId;
  readonly episodeId: EpisodeId;
  readonly at: StoryTime;
  readonly sceneText: string;
  /** Entities the outline already says are present. Seeds the proximity of the prompt. */
  readonly presentEntityIds?: readonly EntityId[];
}

export interface ExtractSceneDeltaDeps {
  readonly backends: readonly StructuredBackend[];
  readonly clock: Clock;
  readonly structuredCall?: StructuredCall;
  readonly maxRepairs?: number;
}

/** Epistemic edge type → the delta's vocabulary for the same event. */
const CHANGE_FOR_EPISTEMIC: Readonly<Record<string, KnowledgeChangeKind>> = {
  knows: 'learned',
  'believes-falsely': 'learned',
  witnessed: 'learned',
  suspects: 'suspected',
  told: 'told',
};

/** Knowledge change → the edge it opens. `disproved` and `forgot` open none; they close. */
const EDGE_FOR_CHANGE: Readonly<Partial<Record<KnowledgeChangeKind, RelationType>>> = {
  learned: 'knows',
  suspected: 'suspects',
  told: 'told',
};

export class ExtractSceneDeltaUseCase {
  readonly #call: StructuredCall;
  readonly #backends: readonly StructuredBackend[];
  readonly #clock: Clock;
  readonly #maxRepairs: number | undefined;

  constructor(deps: ExtractSceneDeltaDeps) {
    this.#backends = deps.backends;
    this.#clock = deps.clock;
    this.#call = deps.structuredCall ?? new StructuredCall({ clock: deps.clock });
    this.#maxRepairs = deps.maxRepairs;
  }

  async execute(input: ExtractSceneDeltaInput): Promise<Result<ExtractedScene>> {
    const text = input.sceneText.trim();
    if (text.length === 0) {
      return err(
        new ValidationError({
          message: 'Cannot extract a state delta from empty scene text.',
          context: { sceneId: input.sceneId },
        }),
      );
    }

    const called = await this.#call.run({
      schemaName: 'SceneObservations',
      schema: SceneObservations,
      backends: this.#backends,
      system: SCENE_OBSERVATION_SYSTEM_PROMPT,
      user: this.#buildPrompt(input, text),
      ...(this.#maxRepairs !== undefined ? { maxRepairs: this.#maxRepairs } : {}),
    });
    if (isErr(called)) return err(called.error.error);

    return ok(this.#assemble(input, called.value.value, called.value.trace));
  }

  #buildPrompt(input: ExtractSceneDeltaInput, text: string): string {
    const known = (input.presentEntityIds ?? [])
      .map((id) => input.graph.entity(id))
      .filter((entity) => entity !== undefined)
      .map((entity) => `- ${entity.canonicalName} (${entity.kind})`);

    const parts = [
      `Story time: ordinal ${String(input.at.ordinal)}${input.at.label === undefined ? '' : ` - ${input.at.label}`}`,
    ];
    if (known.length > 0) {
      parts.push(
        'Entities the outline says are present. Use these names verbatim when you mean them:',
        known.join('\n'),
      );
    }
    parts.push('Scene:', text);
    return parts.join('\n\n');
  }

  #assemble(
    input: ExtractSceneDeltaInput,
    observed: SceneObservations,
    trace: StructuredTrace,
  ): ExtractedScene {
    const { graph, sceneId, episodeId, at } = input;
    const seriesId = graph.seriesId;
    const sourceRef: RelationSource = { kind: 'episode', episodeId, sceneId };
    const assertedAt = toIso(this.#clock.now());

    const resolver = new MentionResolver(graph.entities);
    const log = new ResolutionLog(resolver);

    // Introduced nodes are registered before anything else resolves, so a relation about
    // something this very scene introduced does not report its subject as unknown.
    const introduced: IntroducedEntity[] = [];
    for (const candidate of observed.entities) {
      if (resolver.resolve(candidate.mention).ok) continue;
      const entityId = deriveEntityId(seed(seriesId, candidate.kind, candidate.mention));
      resolver.register(entityId, [candidate.mention]);
      introduced.push({
        entityId,
        mention: candidate.mention,
        kind: candidate.kind,
        importance: candidate.importance,
        summary: candidate.summary,
        firstAppearance: at,
      });
    }

    const relations: Relation[] = [];
    const asserted: RelationId[] = [];
    const retracted: RelationId[] = [];
    const unmatchedRetractions: UnmatchedRetraction[] = [];
    const knowledgeChanges: KnowledgeChange[] = [];

    const mint = (
      from: EntityId,
      to: EntityId,
      type: RelationType,
      fact: Prose,
      extras: Pick<Relation, 'strength' | 'visibility' | 'confidence'>,
    ): Relation => {
      const relation: Relation = {
        id: deriveRelationId(seed(seriesId, sceneId, from, to, type, fact)),
        seriesId,
        from,
        to,
        type,
        fact,
        strength: extras.strength,
        validFrom: at,
        validUntil: null,
        assertedAt,
        retractedAt: null,
        sourceRef,
        confidence: extras.confidence,
        visibility: extras.visibility,
      };
      relations.push(relation);
      asserted.push(relation.id);
      return relation;
    };

    for (const observation of observed.relations) {
      const from = log.resolve(observation.subject, 'relations.subject');
      const to = log.resolve(observation.object, 'relations.object');
      if (from === undefined || to === undefined) continue;

      if (observation.polarity === 'retracted') {
        const existing = this.#findRetractable(graph, from, to, observation.type, at);
        if (existing === undefined) {
          unmatchedRetractions.push({ observation, subjectId: from, objectId: to });
        } else {
          retracted.push(existing.id);
        }
        continue;
      }

      const relation = mint(from, to, observation.type, observation.fact, observation);

      // An epistemic edge is also a change to somebody's model of the world, and the
      // delta is the only place that is recorded. `aboutRelationId` points at the edge
      // itself: for a belief with no true counterpart - "my parents died in the fire" -
      // there is no other edge to name, and the belief edge is the row a later reveal
      // bounds.
      if (isEpistemicRelation(observation.type)) {
        knowledgeChanges.push({
          knowerId: from,
          change: CHANGE_FOR_EPISTEMIC[observation.type] ?? 'learned',
          proposition: observation.fact,
          aboutRelationId: relation.id,
        });
      }
    }

    for (const observation of observed.knowledge) {
      const knowerId = log.resolve(observation.knower, 'knowledge.knower');
      const aboutId = log.resolve(observation.about, 'knowledge.about');
      if (knowerId === undefined || aboutId === undefined) continue;
      const learnedFrom =
        observation.learnedFrom === null
          ? undefined
          : log.resolve(observation.learnedFrom, 'knowledge.learnedFrom');

      const edgeType = EDGE_FOR_CHANGE[observation.change];
      const aboutRelationId =
        edgeType === undefined
          ? undefined
          : mint(knowerId, aboutId, edgeType, observation.proposition, {
              strength: 0,
              visibility: 'private',
              confidence: 0.9,
            }).id;

      knowledgeChanges.push({
        knowerId,
        change: observation.change,
        proposition: observation.proposition,
        ...(aboutRelationId !== undefined ? { aboutRelationId } : {}),
        ...(learnedFrom !== undefined ? { learnedFrom } : {}),
      });
    }

    const positionChanges: PositionChange[] = [];
    for (const movement of observed.movements) {
      const entityId = log.resolve(movement.subject, 'movements.subject');
      const from = log.resolveNullable(movement.from, 'movements.from');
      const to = log.resolveNullable(movement.to, 'movements.to');
      if (entityId === undefined || from === undefined || to === undefined) continue;
      positionChanges.push({
        entityId,
        from,
        to,
        ...(movement.note !== undefined ? { note: movement.note } : {}),
      });
    }

    const possessionChanges: PossessionChange[] = [];
    for (const handover of observed.possessions) {
      const itemId = log.resolve(handover.item, 'possessions.item');
      const from = log.resolveNullable(handover.from, 'possessions.from');
      const to = log.resolveNullable(handover.to, 'possessions.to');
      if (itemId === undefined || from === undefined || to === undefined) continue;
      possessionChanges.push({ itemId, from, to, mode: handover.mode });
    }

    const vitalityChanges: VitalityChange[] = [];
    for (const change of observed.vitality) {
      const entityId = log.resolve(change.subject, 'vitality.subject');
      if (entityId === undefined) continue;
      vitalityChanges.push({
        entityId,
        to: change.to,
        ...(change.note !== undefined ? { note: change.note } : {}),
      });
    }

    const openLoops: OpenLoop[] = observed.setups.map((setup) => ({
      id: deriveOpenLoopId(seed(seriesId, sceneId, setup.promise)),
      seriesId,
      setup: setup.setup,
      promise: setup.promise,
      plantedAt: at,
      plantedIn: { episodeId, sceneId },
      entities: setup.involves
        .map((mention) => log.resolve(mention, 'setups.involves'))
        .filter((id) => id !== undefined)
        .sort(compareStrings),
      relations: [],
      // An unbounded window is the honest default: the extractor saw a plant, not a
      // deadline. `OpenLoop.expectedPayoff` documents that a distant `from` with no
      // `until` is how a series accumulates debt it cannot pay - which is exactly what
      // the overdue report is for.
      expectedPayoff: { from: at, until: null },
      urgency: setup.urgency,
      status: 'open',
      paidIn: null,
    }));

    const delta: StateDelta = {
      sceneId,
      episodeId,
      seriesId,
      at,
      entitiesIntroduced: introduced.map((entity) => entity.entityId).sort(compareStrings),
      relationsAsserted: [...asserted].sort(compareStrings),
      relationsRetracted: [...new Set(retracted)].sort(compareStrings),
      positionChanges,
      possessionChanges,
      knowledgeChanges,
      vitalityChanges,
      openLoopsPlanted: openLoops.map((loop) => loop.id).sort(compareStrings),
      openLoopsPaid: [],
    };

    return {
      delta,
      relations: [...relations].sort((a, b) => compareStrings(a.id, b.id)),
      introduced,
      openLoops,
      unresolved: log.unresolved,
      unmatchedRetractions,
      trace,
    };
  }

  /** The standing edge a "this stopped being true" observation is about, if we hold one. */
  #findRetractable(
    graph: NarrativeGraph,
    from: EntityId,
    to: EntityId,
    type: RelationType,
    at: StoryTime,
  ): Relation | undefined {
    return graph.index
      .query({ from, to, types: [type], storyAt: at })
      .find((relation) => relation.validUntil === null);
  }
}
