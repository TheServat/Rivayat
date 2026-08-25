import type { CastCandidate, ProjectId, SeriesCard, SeriesId } from '@rv/contracts';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue';

import { useStudioApi } from '../../api/client';
import { ApiError, isApiError } from '../../api/errors';

import {
  isMissingRoute,
  routeFromMessage,
  storyGatewayFor,
  type StoryGateway,
} from './api/story-gateway';
import {
  OUTLINE_LEVELS,
  type EditImpact,
  type OutlineLevel,
  type StoryNode,
  type StoryNodeEdit,
  type StoryTree,
  childLevelOf,
  descendantIdsOf,
  editImpactOf,
} from './api/story-tree';

export type StoryStatus = 'idle' | 'loading' | 'ready' | 'error';

const EMPTY_TREE = (seriesId: SeriesId): StoryTree => ({ seriesId, nodes: [] });

/**
 * Everything the Story screen knows.
 *
 * Three decisions in here are the screen, not plumbing.
 *
 * **There is no `regenerateAll`.** The only ways the tree grows are `buildNextLevel`,
 * which descends exactly one level, and `regenerate(nodeId)`, which rebuilds one
 * subtree. A method that rewrote the whole outline would be the "regenerate everything"
 * button with a different name, and the DOC discipline it discards — every child bound
 * to what its parent asked for — is the reason the story holds together at episode
 * seven. `buildRemaining` exists and is a *loop over `buildNextLevel`*: it descends one
 * level at a time, publishes each level as it lands, and stops where it is told.
 *
 * **An edit is a two-step act.** `impactOf` is answered from the tree already on
 * screen, before anything is sent, so the user chooses between keeping the children and
 * rewriting them while looking at how many there are. Keeping them marks them `stale`;
 * nothing is deleted behind the user's back.
 *
 * **Partial is a first-class state.** A build that fails at level five keeps levels one
 * to four. The error names the level that failed and the tree stays readable, because
 * four levels of outline is worth a great deal more than an empty screen with a message
 * on it.
 */
/**
 * What a person types to start a series.
 *
 * Two halves that arrive together but do different jobs. The title and premise create
 * the series; the rest is the S0 brief, which is what produces the cast shortlist every
 * later stage needs. Asking for them in one form is a product decision - they are one
 * decision to the person making it - but they are two calls, and the second can fail
 * without undoing the first.
 */
export interface SeriesDraft {
  readonly title: string;
  readonly premise: string;
  readonly targetAudience: string;
  readonly toneWords: readonly string[];
  readonly episodeMinutes: number;
  readonly seasons: number;
  readonly episodesPerSeason: number;
}

export interface StoryStore {
  readonly status: Ref<StoryStatus>;
  readonly error: Ref<ApiError | null>;
  /** The route the server has no handler for, when that is why this screen is empty. */
  readonly missingRoute: Ref<string | null>;
  readonly seriesList: Ref<readonly SeriesCard[]>;
  readonly seriesId: Ref<SeriesId | null>;
  readonly series: ComputedRef<SeriesCard | null>;
  readonly tree: Ref<StoryTree | null>;
  readonly nodes: ComputedRef<readonly StoryNode[]>;
  readonly roots: ComputedRef<readonly StoryNode[]>;
  readonly isEmpty: ComputedRef<boolean>;
  readonly builtLevels: ComputedRef<readonly OutlineLevel[]>;
  readonly nextLevel: ComputedRef<OutlineLevel | null>;
  readonly totalSpentNanoUsd: ComputedRef<number>;
  readonly generating: Ref<boolean>;
  readonly levelInFlight: Ref<OutlineLevel | null>;
  readonly selectedId: Ref<string | null>;
  readonly selected: ComputedRef<StoryNode | null>;
  readonly saving: Ref<boolean>;
  readonly savedAt: Ref<number>;
  childrenOf: (parentId: string | null) => readonly StoryNode[];
  isOpen: (nodeId: string) => boolean;
  toggle: (nodeId: string) => void;
  select: (nodeId: string | null) => void;
  impactOf: (nodeId: string) => EditImpact;
  load: (projectId: ProjectId) => Promise<void>;
  chooseSeries: (seriesId: SeriesId) => Promise<void>;
  /** Starts the series a project needs before any other screen has anything to show. */
  startSeries: (projectId: ProjectId, draft: SeriesDraft, locale?: 'fa' | 'en') => Promise<boolean>;
  /** Re-runs S0 on the current series, after a failure or an edited premise. */
  runIntake: (draft: SeriesDraft, locale?: 'fa' | 'en') => Promise<boolean>;
  readonly starting: Ref<boolean>;
  readonly castCandidates: Ref<readonly CastCandidate[]>;
  buildNextLevel: () => Promise<void>;
  buildRemaining: () => Promise<void>;
  stopBuilding: () => void;
  saveEdit: (nodeId: string, edit: StoryNodeEdit) => Promise<boolean>;
  regenerate: (nodeId: string) => Promise<boolean>;
}

function asApiError(caught: unknown, code: string, message: string): ApiError {
  return isApiError(caught)
    ? caught
    : new ApiError({ failure: 'network', code, message, cause: caught });
}

export const useStoryStore = defineStore('story', (): StoryStore => {
  const status = ref<StoryStatus>('idle');
  const error = shallowRef<ApiError | null>(null);
  const missingRoute = ref<string | null>(null);
  const seriesList = shallowRef<readonly SeriesCard[]>([]);
  const seriesId = ref<SeriesId | null>(null);
  const tree = shallowRef<StoryTree | null>(null);
  const generating = ref(false);
  const levelInFlight = ref<OutlineLevel | null>(null);
  const selectedId = ref<string | null>(null);
  const saving = ref(false);
  const starting = ref(false);
  /**
   * The shortlist S0 produced, which S3 writes sheets for.
   *
   * Held here so the Story screen can say whether intake produced anything. An outline
   * with thirty-four nodes and an empty shortlist is a series the Characters screen can
   * do nothing with, and until this was on screen there was no way to tell the two apart.
   */
  const castCandidates = shallowRef<readonly CastCandidate[]>([]);
  const savedAt = ref(0);
  // Which branches are open. The default is the top three levels: an outline that
  // arrives fully expanded is 64 rows and 64 tab stops, and nobody reads it.
  const open = ref<ReadonlySet<string>>(new Set());

  /**
   * Which build is current, as a token rather than a boolean.
   *
   * A `stop` flag has a bug a token does not: stopping one build and starting another
   * leaves the flag needing a reset, and the window between the two is a build that
   * cancels itself. A generation is claimed when a build starts and invalidated when
   * one is stopped, so a stop can only ever cancel the build it was asked about.
   */
  let buildGeneration = 0;

  function gateway(): StoryGateway {
    return storyGatewayFor(useStudioApi().transport);
  }

  const nodes = computed<readonly StoryNode[]>(() => tree.value?.nodes ?? []);

  const byParent = computed(() => {
    const map = new Map<string, StoryNode[]>();
    for (const node of nodes.value) {
      const key = node.parentId ?? '';
      const bucket = map.get(key);
      if (bucket === undefined) map.set(key, [node]);
      else bucket.push(node);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.ordinal - b.ordinal);
    return map;
  });

  const roots = computed(() => byParent.value.get('') ?? []);
  const isEmpty = computed(() => status.value === 'ready' && nodes.value.length === 0);

  const builtLevels = computed(() =>
    OUTLINE_LEVELS.filter((level) => nodes.value.some((node) => node.level === level)),
  );

  /**
   * The one level that may be built next.
   *
   * Never a choice of levels, because there is only ever one legal answer: the child of
   * the deepest level that exists. Offering a menu here is offering the skip.
   */
  const nextLevel = computed<OutlineLevel | null>(() => {
    const deepest = builtLevels.value.at(-1);
    if (deepest === undefined) return 'series';
    return childLevelOf(deepest) ?? null;
  });

  const totalSpentNanoUsd = computed(() =>
    nodes.value.reduce((sum, node) => sum + node.spentNanoUsd, 0),
  );

  const series = computed(
    () => seriesList.value.find((entry) => entry.id === seriesId.value) ?? null,
  );

  const selected = computed(() => nodes.value.find((node) => node.id === selectedId.value) ?? null);

  function childrenOf(parentId: string | null): readonly StoryNode[] {
    return byParent.value.get(parentId ?? '') ?? [];
  }

  function isOpen(nodeId: string): boolean {
    return open.value.has(nodeId);
  }

  function toggle(nodeId: string): void {
    const next = new Set(open.value);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    open.value = next;
  }

  function select(nodeId: string | null): void {
    selectedId.value = nodeId;
  }

  function impactOf(nodeId: string): EditImpact {
    const current = tree.value;
    if (current === null) return { childCount: 0, levels: [], staleStages: [] };
    return editImpactOf(current, nodeId);
  }

  /** Opens every ancestor path down to `depth`, so a fresh tree is readable at a glance. */
  function openTopLevels(depth: number): void {
    const next = new Set(open.value);
    for (const node of nodes.value) {
      if (OUTLINE_LEVELS.indexOf(node.level) < depth) next.add(node.id);
    }
    open.value = next;
  }

  /**
   * Creates the series and opens it, in one action.
   *
   * Opening it is the point rather than a courtesy: a person who just described a series
   * wants to write it, and leaving them on a screen that now says "one series exists"
   * with a picker to use would be an extra step to undo a state they never wanted.
   *
   * Returns whether it worked, so the caller can keep the form's contents on a failure.
   * Clearing a premise someone spent a minute writing because the server was briefly
   * unreachable is the kind of small cruelty that makes a tool feel hostile.
   */
  async function startSeries(
    projectId: ProjectId,
    draft: SeriesDraft,
    locale: 'fa' | 'en' = 'en',
  ): Promise<boolean> {
    starting.value = true;
    error.value = null;
    try {
      const created = await gateway().createSeries(projectId, {
        title: draft.title,
        premise: draft.premise,
      });
      seriesList.value = [...seriesList.value, created];
      seriesId.value = created.id;

      // S0, immediately. The series exists either way, so a failure here leaves a real
      // series with no shortlist rather than a half-created one - which is a state the
      // screen can show and offer to fix, and is why `intakeDone` is separate from
      // whether a series exists at all.
      const report = await gateway().runIntake(created.id, {
        kind: 'idea',
        idea: draft.premise,
        workingTitle: draft.title,
        language: locale,
        targetAudience: draft.targetAudience,
        toneWords: [...draft.toneWords],
        targetEpisodeDurationMs: Math.round(draft.episodeMinutes * 60_000),
        episodes: {
          seasons: draft.seasons,
          episodesPerSeason: draft.episodesPerSeason,
          // Stated rather than defaulted: an open-ended series must not resolve its
          // central question, and that is not a choice to make on someone's behalf.
          openEnded: false,
        },
        constraints: { mustNotAppear: [], ratingCeiling: 'teen' },
        references: [],
      });
      castCandidates.value = report.castCandidates;

      tree.value = await gateway().loadTree(created.id);
      status.value = 'ready';
      return true;
    } catch (caught) {
      error.value = asApiError(caught, 'series-create-failed', 'the series could not be started');
      // A series that was created before intake failed is still the current series: the
      // screen should open on it, so the person can retry the half that failed rather
      // than start a second series beside the first.
      if (seriesId.value !== null) status.value = 'ready';
      return false;
    } finally {
      starting.value = false;
    }
  }

  /**
   * Runs S0 on the current series, on its own.
   *
   * The retry for the half of `startSeries` that can fail by itself, and the way to
   * re-run intake after correcting a premise - which is the whole reason intake is not
   * folded into planting the root.
   */
  async function runIntake(draft: SeriesDraft, locale: 'fa' | 'en' = 'en'): Promise<boolean> {
    const current = seriesId.value;
    if (current === null) return false;
    starting.value = true;
    error.value = null;
    try {
      const report = await gateway().runIntake(current, {
        kind: 'idea',
        idea: draft.premise,
        workingTitle: draft.title,
        language: locale,
        targetAudience: draft.targetAudience,
        toneWords: [...draft.toneWords],
        targetEpisodeDurationMs: Math.round(draft.episodeMinutes * 60_000),
        episodes: {
          seasons: draft.seasons,
          episodesPerSeason: draft.episodesPerSeason,
          // Stated rather than defaulted: an open-ended series must not resolve its
          // central question, and that is not a choice to make on someone's behalf.
          openEnded: false,
        },
        constraints: { mustNotAppear: [], ratingCeiling: 'teen' },
        references: [],
      });
      castCandidates.value = report.castCandidates;
      return true;
    } catch (caught) {
      error.value = asApiError(caught, 'intake-failed', 'S0 intake could not be run');
      return false;
    } finally {
      starting.value = false;
    }
  }

  async function load(projectId: ProjectId): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const list = await gateway().listSeries(projectId);
      seriesList.value = list;
      const first = list.at(0);
      if (first === undefined) {
        tree.value = null;
        status.value = 'ready';
        return;
      }
      await chooseSeries(first.id);
    } catch (caught) {
      status.value = 'error';
      error.value = asApiError(
        caught,
        'story-series-failed',
        'the series list could not be loaded',
      );
    }
  }

  async function chooseSeries(next: SeriesId): Promise<void> {
    seriesId.value = next;
    selectedId.value = null;
    status.value = 'loading';
    error.value = null;
    missingRoute.value = null;
    try {
      tree.value = await gateway().loadTree(next);
      openTopLevels(3);
      status.value = 'ready';
    } catch (caught) {
      const failure = asApiError(caught, 'story-tree-failed', 'the story tree could not load');
      // A 404 for the *route* and a 404 for the *resource* look identical in the status
      // line and mean opposite things. A series with no outline yet is an empty screen
      // and an invitation; a route the API has never had is a missing feature, and a
      // screen that reported it as "no story yet" would be lying about whose turn it is.
      if (isMissingRoute(failure)) {
        tree.value = null;
        missingRoute.value = routeFromMessage(failure);
        status.value = 'error';
        error.value = failure;
        return;
      }
      if (failure.kind === 'not-found') {
        tree.value = EMPTY_TREE(next);
        status.value = 'ready';
        return;
      }
      tree.value = null;
      status.value = 'error';
      error.value = failure;
    }
  }

  async function buildNextLevel(): Promise<void> {
    const level = nextLevel.value;
    const target = seriesId.value;
    if (level === null || target === null || generating.value) return;

    generating.value = true;
    buildGeneration += 1;
    try {
      await expandOne(target, level);
    } finally {
      generating.value = false;
      levelInFlight.value = null;
    }
  }

  /**
   * Descends the remaining levels, publishing each as it lands.
   *
   * Not one request for the whole outline: seven, in order, each bound to the level
   * above it. The tree is written back after every one, so the screen is readable and
   * navigable while the rest is still being written — which is the difference between
   * forty seconds of progress and forty seconds of spinner.
   */
  async function buildRemaining(): Promise<void> {
    const target = seriesId.value;
    if (target === null || generating.value) return;

    generating.value = true;
    const generation = (buildGeneration += 1);
    try {
      let level = nextLevel.value;
      while (level !== null && generation === buildGeneration) {
        const ok = await expandOne(target, level);
        if (!ok) break;
        level = nextLevel.value;
      }
    } finally {
      generating.value = false;
      levelInFlight.value = null;
    }
  }

  async function expandOne(target: SeriesId, level: OutlineLevel): Promise<boolean> {
    levelInFlight.value = level;
    error.value = null;
    try {
      const expansion = await gateway().expandLevel(target, level);
      const current = tree.value ?? EMPTY_TREE(target);
      tree.value = { ...current, nodes: [...current.nodes, ...expansion.nodes] };
      if (OUTLINE_LEVELS.indexOf(level) < 3) openTopLevels(3);
      return true;
    } catch (caught) {
      // The levels that already landed stay. A failure at level five is four levels of
      // outline plus a message, not an empty screen.
      error.value = asApiError(caught, 'story-expand-failed', `expanding "${level}" failed`);
      return false;
    } finally {
      levelInFlight.value = null;
    }
  }

  function stopBuilding(): void {
    buildGeneration += 1;
  }

  async function saveEdit(nodeId: string, edit: StoryNodeEdit): Promise<boolean> {
    const current = tree.value;
    if (current === null) return false;

    saving.value = true;
    error.value = null;
    try {
      const updated = await gateway().editNode(nodeId, edit);
      const dropped =
        edit.children === 're-expand'
          ? new Set(descendantIdsOf(current, nodeId))
          : new Set<string>();
      const kept =
        edit.children === 'keep' ? new Set(descendantIdsOf(current, nodeId)) : new Set<string>();

      tree.value = {
        ...current,
        nodes: current.nodes
          .filter((node) => !dropped.has(node.id))
          .map((node) => {
            if (node.id === nodeId) return updated;
            return kept.has(node.id) ? { ...node, status: 'stale' as const } : node;
          }),
      };
      savedAt.value += 1;
      return true;
    } catch (caught) {
      error.value = asApiError(caught, 'story-edit-failed', 'the edit could not be saved');
      return false;
    } finally {
      saving.value = false;
    }
  }

  async function regenerate(nodeId: string): Promise<boolean> {
    const current = tree.value;
    if (current === null) return false;

    saving.value = true;
    error.value = null;
    try {
      const expansion = await gateway().regenerateNode(nodeId);
      const dropped = new Set(descendantIdsOf(current, nodeId));
      tree.value = {
        ...current,
        nodes: [...current.nodes.filter((node) => !dropped.has(node.id)), ...expansion.nodes],
      };
      savedAt.value += 1;
      return true;
    } catch (caught) {
      error.value = asApiError(caught, 'story-regenerate-failed', 'the node could not be rebuilt');
      return false;
    } finally {
      saving.value = false;
    }
  }

  return {
    status,
    error,
    missingRoute,
    seriesList,
    seriesId,
    series,
    tree,
    nodes,
    roots,
    isEmpty,
    builtLevels,
    nextLevel,
    totalSpentNanoUsd,
    generating,
    levelInFlight,
    selectedId,
    selected,
    saving,
    savedAt,
    childrenOf,
    isOpen,
    toggle,
    select,
    impactOf,
    load,
    chooseSeries,
    startSeries,
    runIntake,
    starting,
    castCandidates,
    buildNextLevel,
    buildRemaining,
    stopBuilding,
    saveEdit,
    regenerate,
  };
});
