import type {
  AudienceVisibility,
  CharacterEntity,
  Entity,
  EntityId,
  ProjectId,
  Relation,
  RelationGroup,
  RunId,
  SeriesCard,
  StyleBibleId,
  SeriesId,
} from '@rv/contracts';
import { relationGroupOf } from '@rv/contracts';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue';

import { useStudioApi } from '../../api/client';
import { ApiError, isApiError } from '../../api/errors';

import {
  charactersGatewayFor,
  isMissingRoute,
  routeFromMessage,
  type CharactersGateway,
} from './api/characters-gateway';
import {
  type EpistemicStanding,
  type Standpoint,
  isObjectOfSecret,
  relationsAt,
  standingOf,
  viewerKnowledge,
} from './api/epistemic';
import type {
  CharacterStateCell,
  CharacterStates,
  GraphRevision,
  NarrativeSnapshot,
  StoryMark,
} from './api/graph';

export type CharactersStatus = 'idle' | 'loading' | 'ready' | 'error';
export type CharacterTab = 'sheet' | 'states' | 'graph' | 'matrix';

/** One neighbour of the focus entity, with the edge that reaches it. */
export interface GraphNeighbour {
  readonly entity: Entity;
  readonly relation: Relation;
  /** `true` when the focus is the subject of the sentence. */
  readonly outgoing: boolean;
  readonly group: RelationGroup;
  /** `null` for the narrator, who has no blind spots. */
  readonly standing: EpistemicStanding | null;
  /**
   * The viewer is the object of this secret and does not know it - which is precisely
   * who it is kept from.
   *
   * Surfaced because it is the case a reader misreads: the edge touches them, so it
   * looks like something they hold. It goes away the moment they actually hold it.
   */
  readonly objectOfSecret: boolean;
}

export interface MatrixSample {
  readonly ordinal: number;
  readonly strength: number | null;
}

export interface MatrixRow {
  readonly from: Entity;
  readonly to: Entity;
  readonly samples: readonly MatrixSample[];
  /** True when the strength never moves across the whole span. */
  readonly flat: boolean;
}

export interface CharactersStore {
  readonly status: Ref<CharactersStatus>;
  readonly error: Ref<ApiError | null>;
  /** The route the server has no handler for, when that is why this screen is empty. */
  readonly missingRoute: Ref<string | null>;
  readonly seriesList: Ref<readonly SeriesCard[]>;
  readonly seriesId: Ref<SeriesId | null>;
  readonly snapshot: Ref<NarrativeSnapshot | null>;
  readonly cast: ComputedRef<readonly CharacterEntity[]>;
  readonly filteredCast: ComputedRef<readonly CharacterEntity[]>;
  readonly isEmpty: ComputedRef<boolean>;
  query: Ref<string>;
  readonly selectedId: Ref<EntityId | null>;
  readonly selected: ComputedRef<CharacterEntity | null>;
  readonly tab: Ref<CharacterTab>;

  // ── the standpoint: the feature, not a filter ─────────────────────────────
  readonly storyMarks: ComputedRef<readonly StoryMark[]>;
  readonly revisions: ComputedRef<readonly GraphRevision[]>;
  readonly storyOrdinal: Ref<number>;
  readonly asOf: Ref<string | null>;
  readonly viewerId: Ref<EntityId | null>;
  readonly viewer: ComputedRef<CharacterEntity | null>;
  readonly standpoint: ComputedRef<Standpoint>;
  readonly currentMark: ComputedRef<StoryMark | null>;
  readonly isNarrator: ComputedRef<boolean>;

  // ── the graph ─────────────────────────────────────────────────────────────
  readonly focusId: Ref<EntityId | null>;
  readonly focus: ComputedRef<Entity | null>;
  groupFilter: Ref<RelationGroup | null>;
  visibilityFilter: Ref<AudienceVisibility | null>;
  readonly visibleRelations: ComputedRef<readonly Relation[]>;
  readonly neighbours: ComputedRef<readonly GraphNeighbour[]>;
  readonly standingCounts: ComputedRef<Readonly<Record<EpistemicStanding, number>>>;
  readonly matrix: ComputedRef<readonly MatrixRow[]>;

  // ── the state grid ────────────────────────────────────────────────────────
  readonly states: Ref<CharacterStates | null>;
  readonly statesStatus: Ref<CharactersStatus>;
  readonly statesError: Ref<ApiError | null>;
  readonly wardrobeSlug: Ref<string | null>;
  readonly openCellKey: Ref<string | null>;
  readonly cellBusy: Ref<string | null>;

  entityById: (id: string) => Entity | null;
  /** Where one fact sits in the current viewer's head. `null` for the narrator. */
  standingFor: (relation: Relation) => EpistemicStanding | null;
  /** True while the viewer is the object of a secret *and* still blind to it. */
  objectOfSecretFor: (relation: Relation) => boolean;
  load: (projectId: ProjectId) => Promise<void>;
  chooseSeries: (seriesId: SeriesId) => Promise<void>;
  select: (entityId: EntityId) => Promise<void>;
  setTab: (tab: CharacterTab) => void;
  setViewer: (viewerId: EntityId | null) => void;
  setStoryOrdinal: (ordinal: number) => void;
  setAsOf: (instant: string | null) => void;
  resetStandpoint: () => void;
  focusOn: (entityId: EntityId) => void;
  chooseWardrobe: (slug: string) => void;
  openCell: (variantKey: string | null) => void;
  /** The run building the cast, while it runs. `null` when nothing is in flight. */
  readonly castRunId: Ref<RunId | null>;
  /** Ask the pipeline to write the cast. The seed is stated so the run can be replayed. */
  buildCast: (seed: number) => Promise<boolean>;
  /** Poll it. `true` once the run has reached a terminal state, whatever that state was. */
  awaitCast: () => Promise<boolean>;
  saveCellPrompt: (variantKey: string, prompt: string) => Promise<boolean>;
  generateCell: (variantKey: string) => Promise<boolean>;
}

function asApiError(caught: unknown, code: string, message: string): ApiError {
  return isApiError(caught)
    ? caught
    : new ApiError({ failure: 'network', code, message, cause: caught });
}

function isCharacter(entity: Entity): entity is CharacterEntity {
  return entity.kind === 'character';
}

/**
 * The Characters screen's state.
 *
 * The one decision that shapes everything else: **the standpoint is state, not a
 * filter.** `storyOrdinal`, `asOf` and `viewerId` sit at the top of this store and every
 * derived value below reads them, so moving the story-time slider does not narrow a
 * list — it re-answers the question "what is true, and who holds it". That is the
 * difference between this screen and a wiki with a date field.
 *
 * The second: **`standingOf` is never collapsed.** `knows`, `believes-falsely`,
 * `suspects`, `witnessed`, `told` and `blind` reach the components as six distinct
 * values, because the model stores truth and belief as separate edges and a store that
 * flattened them to "connected" would throw away the reason it does.
 */
export const useCharactersStore = defineStore('characters', (): CharactersStore => {
  const status = ref<CharactersStatus>('idle');
  const error = shallowRef<ApiError | null>(null);
  const missingRoute = ref<string | null>(null);
  const seriesList = shallowRef<readonly SeriesCard[]>([]);
  const seriesId = ref<SeriesId | null>(null);
  const projectId = ref<ProjectId | null>(null);
  const styleBibleId = ref<StyleBibleId | null>(null);
  /** The run building the cast, while it runs. `null` when nothing is in flight. */
  const castRunId = ref<RunId | null>(null);
  const snapshot = shallowRef<NarrativeSnapshot | null>(null);
  const query = ref('');
  const selectedId = ref<EntityId | null>(null);
  const tab = ref<CharacterTab>('sheet');

  const storyOrdinal = ref(1);
  const asOf = ref<string | null>(null);
  const viewerId = ref<EntityId | null>(null);

  const focusId = ref<EntityId | null>(null);
  const groupFilter = ref<RelationGroup | null>(null);
  const visibilityFilter = ref<AudienceVisibility | null>(null);

  const states = shallowRef<CharacterStates | null>(null);
  const statesStatus = ref<CharactersStatus>('idle');
  const statesError = shallowRef<ApiError | null>(null);
  const wardrobeSlug = ref<string | null>(null);
  const openCellKey = ref<string | null>(null);
  const cellBusy = ref<string | null>(null);

  function gateway(): CharactersGateway {
    return charactersGatewayFor(useStudioApi().transport);
  }

  const entities = computed<readonly Entity[]>(() => snapshot.value?.entities ?? []);
  const relations = computed<readonly Relation[]>(() => snapshot.value?.relations ?? []);
  const storyMarks = computed<readonly StoryMark[]>(() => snapshot.value?.storyMarks ?? []);
  const revisions = computed<readonly GraphRevision[]>(() => snapshot.value?.revisions ?? []);

  const cast = computed(() => entities.value.filter(isCharacter));
  const isEmpty = computed(() => status.value === 'ready' && cast.value.length === 0);

  const filteredCast = computed(() => {
    const needle = query.value.trim().toLowerCase();
    if (needle.length === 0) return cast.value;
    return cast.value.filter((entity) =>
      [entity.canonicalName, ...entity.aliases, entity.payload.identity.occupation, entity.summary]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  });

  const selected = computed(
    () => cast.value.find((entity) => entity.id === selectedId.value) ?? null,
  );
  const viewer = computed(() => cast.value.find((entity) => entity.id === viewerId.value) ?? null);
  const isNarrator = computed(() => viewerId.value === null);

  const standpoint = computed<Standpoint>(() => ({
    at: { ordinal: storyOrdinal.value },
    asOf: asOf.value,
  }));

  const currentMark = computed(
    () => storyMarks.value.find((mark) => mark.at.ordinal === storyOrdinal.value) ?? null,
  );

  const focus = computed(
    () => entities.value.find((entity) => entity.id === focusId.value) ?? null,
  );

  function entityById(id: string): Entity | null {
    return entities.value.find((entity) => entity.id === id) ?? null;
  }

  function standingFor(relation: Relation): EpistemicStanding | null {
    return standingOf(relations.value, viewerId.value, relation, standpoint.value);
  }

  /**
   * Only while the viewer is still blind to it.
   *
   * The note exists to explain why an edge that *touches* the viewer is not one they
   * hold. After the reveal they do hold it, and repeating "object of the secret, not a
   * knower" beside a `knows` badge would contradict the badge - the graph would be
   * saying two opposite things about the same edge in the same frame.
   */
  function objectOfSecretFor(relation: Relation): boolean {
    return isObjectOfSecret(relation, viewerId.value) && standingFor(relation) === 'blind';
  }

  /**
   * The relations that hold at this standpoint, then the two optional narrowings.
   *
   * The standpoint is applied first and unconditionally: a relation that is not true at
   * this moment on both clocks is not a relation that can be filtered *back in*.
   */
  const visibleRelations = computed(() => {
    const held = relationsAt(relations.value, standpoint.value);
    return held.filter((relation) => {
      if (groupFilter.value !== null && relationGroupOf(relation.type) !== groupFilter.value) {
        return false;
      }
      if (visibilityFilter.value !== null && relation.visibility !== visibilityFilter.value) {
        return false;
      }
      return true;
    });
  });

  /**
   * The focus entity's own neighbourhood, one hop, ordered deterministically.
   *
   * One hop and not two: the whole-series graph is a hairball, and the relations that
   * matter to a reader are the ones attached to the person they are looking at. Sorted
   * by relation family and then by name so the ring does not reshuffle when the
   * standpoint moves — a node that jumps to the other side of the diagram because an
   * unrelated edge appeared is a node nobody can follow.
   */
  const neighbours = computed<readonly GraphNeighbour[]>(() => {
    const centre = focusId.value;
    if (centre === null) return [];

    const found: GraphNeighbour[] = [];
    for (const relation of visibleRelations.value) {
      const outgoing = relation.from === centre;
      if (!outgoing && relation.to !== centre) continue;
      const other = entityById(outgoing ? relation.to : relation.from);
      if (other === null) continue;
      const standing = standingOf(relations.value, viewerId.value, relation, standpoint.value);
      found.push({
        entity: other,
        relation,
        outgoing,
        group: relationGroupOf(relation.type),
        standing,
        objectOfSecret: isObjectOfSecret(relation, viewerId.value) && standing === 'blind',
      });
    }

    return found.toSorted((left, right) => {
      const byGroup = left.group.localeCompare(right.group);
      if (byGroup !== 0) return byGroup;
      const byName = left.entity.canonicalName.localeCompare(right.entity.canonicalName);
      return byName === 0 ? left.relation.id.localeCompare(right.relation.id) : byName;
    });
  });

  /** How much of each standing is on screen. Announced when the standpoint moves. */
  const standingCounts = computed<Readonly<Record<EpistemicStanding, number>>>(() => {
    const counts: Record<EpistemicStanding, number> = {
      knows: 0,
      'believes-falsely': 0,
      suspects: 0,
      witnessed: 0,
      told: 0,
      blind: 0,
    };
    if (viewerId.value === null) return counts;
    const knowledge = viewerKnowledge(relations.value, viewerId.value, standpoint.value);
    counts.knows = knowledge.knows.filter((relation) => relation.type === 'knows').length;
    counts.witnessed = knowledge.knows.filter((relation) => relation.type === 'witnessed').length;
    counts.told = knowledge.knows.filter((relation) => relation.type === 'told').length;
    counts['believes-falsely'] = knowledge.believesFalsely.length;
    counts.suspects = knowledge.suspects.length;
    counts.blind = knowledge.blindSpots.length;
    return counts;
  });

  /**
   * Signed strength between the leads, sampled at every story mark.
   *
   * The authoring standpoint applies; the story standpoint deliberately does not — the
   * point of the matrix is to look *across* story time, so pinning it to one ordinal
   * would reduce every row to a single value.
   */
  const matrix = computed<readonly MatrixRow[]>(() => {
    const leads = cast.value.filter((entity) => entity.importance === 'lead');
    if (leads.length < 2) return [];

    const rows: MatrixRow[] = [];
    for (const from of leads) {
      for (const to of leads) {
        if (from.id === to.id) continue;
        const between = relations.value.filter(
          (relation) =>
            relation.from === from.id &&
            relation.to === to.id &&
            relationGroupOf(relation.type) !== 'epistemic',
        );
        if (between.length === 0) continue;

        const samples = storyMarks.value.map((mark) => {
          const held = between.filter(
            (relation) => relationsAt([relation], { at: mark.at, asOf: asOf.value }).length > 0,
          );
          const strongest = held.toSorted(
            (left, right) => Math.abs(right.strength) - Math.abs(left.strength),
          )[0];
          return { ordinal: mark.at.ordinal, strength: strongest?.strength ?? null };
        });

        const values = samples
          .map((sample) => sample.strength)
          .filter((value): value is number => value !== null);
        rows.push({
          from,
          to,
          samples,
          flat: values.length > 1 && values.every((value) => value === values[0]),
        });
      }
    }
    return rows;
  });

  // ── loading ───────────────────────────────────────────────────────────────

  async function load(project: ProjectId): Promise<void> {
    projectId.value = project;
    status.value = 'loading';
    error.value = null;
    try {
      const [list, projects] = await Promise.all([
        gateway().listSeries(project),
        // The bible id travels on the project summary the picker already fetches, so
        // this is the same round trip the shell makes rather than a new endpoint.
        useStudioApi().listProjects(),
      ]);
      styleBibleId.value = projects.projects.find((p) => p.id === project)?.styleBibleId ?? null;
      seriesList.value = list;
      const first = list.at(0);
      if (first === undefined) {
        snapshot.value = null;
        status.value = 'ready';
        return;
      }
      await chooseSeries(first.id);
    } catch (caught) {
      status.value = 'error';
      error.value = asApiError(caught, 'cast-series-failed', 'the series list could not be loaded');
    }
  }

  async function chooseSeries(next: SeriesId): Promise<void> {
    seriesId.value = next;
    status.value = 'loading';
    error.value = null;
    missingRoute.value = null;
    try {
      const loaded = await gateway().loadGraph(next);
      snapshot.value = loaded;
      const firstMark = loaded.storyMarks.at(0);
      storyOrdinal.value = firstMark?.at.ordinal ?? 1;
      asOf.value = null;
      viewerId.value = null;
      status.value = 'ready';

      const lead = loaded.entities.find(isCharacter);
      if (lead !== undefined) await select(lead.id);
    } catch (caught) {
      const failure = asApiError(caught, 'graph-load-failed', 'the narrative graph could not load');
      snapshot.value = null;
      // Same distinction as the Story screen: a series with no cast is empty, a route
      // the API has never had is a missing feature and has to name itself.
      if (isMissingRoute(failure)) missingRoute.value = routeFromMessage(failure);
      status.value = 'error';
      error.value = failure;
    }
  }

  async function select(entityId: EntityId): Promise<void> {
    selectedId.value = entityId;
    focusId.value = entityId;
    openCellKey.value = null;
    // The viewer follows the selection until the user pins one. Asking "what does this
    // character know" about the character you just opened is the common case, and
    // making it a second, separate action is how the feature stays unused.
    if (viewerId.value !== null) viewerId.value = entityId;
    await loadStates(entityId);
  }

  async function loadStates(entityId: EntityId): Promise<void> {
    const series = seriesId.value;
    if (series === null) return;
    statesStatus.value = 'loading';
    statesError.value = null;
    try {
      const loaded = await gateway().loadStates(series, entityId);
      states.value = loaded;
      wardrobeSlug.value = loaded.cells.at(0)?.wardrobeSlug ?? null;
      statesStatus.value = 'ready';
    } catch (caught) {
      states.value = null;
      statesStatus.value = 'error';
      statesError.value = asApiError(caught, 'states-load-failed', 'the state grid could not load');
    }
  }

  // ── the standpoint ────────────────────────────────────────────────────────

  function setTab(next: CharacterTab): void {
    tab.value = next;
  }

  function setViewer(next: EntityId | null): void {
    viewerId.value = next;
  }

  function setStoryOrdinal(ordinal: number): void {
    storyOrdinal.value = ordinal;
  }

  function setAsOf(instant: string | null): void {
    asOf.value = instant;
  }

  function resetStandpoint(): void {
    asOf.value = null;
    viewerId.value = null;
    const last = storyMarks.value.at(-1);
    storyOrdinal.value = last?.at.ordinal ?? 1;
  }

  function focusOn(entityId: EntityId): void {
    focusId.value = entityId;
  }

  // ── the state grid ────────────────────────────────────────────────────────

  function chooseWardrobe(slug: string): void {
    wardrobeSlug.value = slug;
    // The open prompt belongs to a cell in the outfit being left behind.
    openCellKey.value = null;
  }

  function openCell(variantKey: string | null): void {
    openCellKey.value = openCellKey.value === variantKey ? null : variantKey;
  }

  function replaceCell(next: CharacterStateCell): void {
    const current = states.value;
    if (current === null) return;
    states.value = {
      ...current,
      cells: current.cells.map((cell) => (cell.variantKey === next.variantKey ? next : cell)),
    };
  }

  /**
   * Ask the pipeline to write the cast.
   *
   * The studio could read what the `cast` stage produced and had no way to ask for it, so
   * a character with no state grid was a dead end - the screen said "no states defined"
   * and nothing in the interface could define any.
   *
   * The seed is stated rather than defaulted. A run that cannot name its seed cannot be
   * replayed, and this one calls a model per character, so "the same cast again" has to
   * mean something.
   */
  async function buildCast(seed: number): Promise<boolean> {
    const series = seriesId.value;
    const project = projectId.value;
    if (series === null || project === null) return false;
    statesError.value = null;
    try {
      const run = await useStudioApi().startRun({
        projectId: project,
        seriesId: series,
        // Just the stage the button names. S3 used to refuse without a bible in the run
        // payload, so this asked for `['style', 'cast']` to put one there - re-running an
        // already-approved style purely to hand its output forward. S3 now resolves the
        // bible by id, the way it always resolved the outline, so the detour is gone.
        stages: ['cast'],
        seed,
        budgetNanoUsd: null,
        payload: {
          // Named rather than inherited from the project. Both work, but a run that
          // records which style it used can be read a year later without also having to
          // know what the project pointed at that day.
          cast: { styleBibleId: styleBibleId.value },
        },
      });
      castRunId.value = run.id;
      return true;
    } catch (caught) {
      statesError.value = asApiError(caught, 'cast-start-failed', 'the cast run could not start');
      // The panel renders `statesError` only when the status says error. Setting one
      // without the other writes a message nobody ever sees - which is how a run that
      // failed in three milliseconds left a button reading "building…" for eight minutes.
      statesStatus.value = 'error';
      return false;
    }
  }

  /**
   * Poll the cast run and reload once it finishes.
   *
   * Polling rather than the event stream because this is a single stage with one question
   * - is it done - and a stream would mean holding a socket open across a screen the user
   * is free to leave. The run survives them leaving; the socket would not.
   */
  async function awaitCast(): Promise<boolean> {
    const runId = castRunId.value;
    const series = seriesId.value;
    if (runId === null || series === null) return false;
    try {
      const run = await useStudioApi().getRun(runId);
      if (run.status === 'running' || run.status === 'queued') return false;
      castRunId.value = null;
      if (run.status !== 'succeeded') {
        statesError.value = asApiError(
          new Error(run.errorCode ?? 'the cast run did not succeed'),
          'cast-failed',
          run.errorCode ?? 'the cast run did not succeed',
        );
        statesStatus.value = 'error';
        return true;
      }
      const project = projectId.value;
      if (project !== null) await load(project);
      return true;
    } catch (caught) {
      castRunId.value = null;
      statesError.value = asApiError(caught, 'cast-poll-failed', 'the cast run could not be read');
      statesStatus.value = 'error';
      return true;
    }
  }

  async function saveCellPrompt(variantKey: string, prompt: string): Promise<boolean> {
    const series = seriesId.value;
    const entity = selectedId.value;
    if (series === null || entity === null) return false;
    cellBusy.value = variantKey;
    statesError.value = null;
    try {
      replaceCell(await gateway().editStatePrompt(series, entity, variantKey, { prompt }));
      return true;
    } catch (caught) {
      statesError.value = asApiError(caught, 'state-save-failed', 'the prompt could not be saved');
      return false;
    } finally {
      cellBusy.value = null;
    }
  }

  async function generateCell(variantKey: string): Promise<boolean> {
    const series = seriesId.value;
    const entity = selectedId.value;
    if (series === null || entity === null) return false;
    cellBusy.value = variantKey;
    statesError.value = null;
    try {
      replaceCell(await gateway().generateState(series, entity, variantKey));
      return true;
    } catch (caught) {
      statesError.value = asApiError(caught, 'state-generate-failed', 'generation failed');
      return false;
    } finally {
      cellBusy.value = null;
    }
  }

  return {
    status,
    error,
    missingRoute,
    seriesList,
    seriesId,
    snapshot,
    cast,
    filteredCast,
    isEmpty,
    query,
    selectedId,
    selected,
    tab,
    storyMarks,
    revisions,
    storyOrdinal,
    asOf,
    viewerId,
    viewer,
    standpoint,
    currentMark,
    isNarrator,
    focusId,
    focus,
    groupFilter,
    visibilityFilter,
    visibleRelations,
    neighbours,
    standingCounts,
    matrix,
    states,
    statesStatus,
    statesError,
    wardrobeSlug,
    openCellKey,
    cellBusy,
    entityById,
    standingFor,
    objectOfSecretFor,
    load,
    chooseSeries,
    select,
    setTab,
    setViewer,
    setStoryOrdinal,
    setAsOf,
    resetStandpoint,
    focusOn,
    chooseWardrobe,
    openCell,
    castRunId,
    buildCast,
    awaitCast,
    saveCellPrompt,
    generateCell,
  };
});
