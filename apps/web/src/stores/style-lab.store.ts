import type { ProjectId, Slug, StyleBible } from '@rv/contracts';
import { defineStore } from 'pinia';
import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useStudioApi } from '../api/client';
import { ApiError, isApiError } from '../api/errors';
import {
  PROBE_TILE_COUNT,
  type StylePresetCard,
  type StyleProbeLane,
  type StyleProbeSheet,
} from '../api/schemas/style';

export type StyleLabStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Where one long-running action is up to. Failures live on `actionError`, not here. */
export type ActionStatus = 'idle' | 'busy' | 'done';

/**
 * What one probe will cost, before it runs.
 *
 * Two numbers and a flag rather than a formatted string: the view formats in the active
 * locale, and a store that pre-rendered `$0.00` would have to be reloaded to switch
 * language. `priced: false` is the honest answer for a lane whose model is not in the
 * catalogue - a zero meaning "we do not know" must never render like a zero meaning
 * "free".
 */
export interface ProbeEstimate {
  readonly lane: StyleProbeLane;
  readonly images: number;
  readonly nanoUsd: number;
  readonly priced: boolean;
}

export interface StyleLabStore {
  readonly status: Ref<StyleLabStatus>;
  readonly error: Ref<ApiError | null>;
  readonly presets: Ref<readonly StylePresetCard[]>;
  readonly selectedId: Ref<Slug | null>;
  readonly selected: ComputedRef<StylePresetCard | null>;
  readonly bible: Ref<StyleBible | null>;
  readonly sheet: Ref<StyleProbeSheet | null>;
  readonly lane: Ref<StyleProbeLane>;
  readonly adopting: Ref<ActionStatus>;
  readonly probing: Ref<ActionStatus>;
  readonly locking: Ref<ActionStatus>;
  readonly actionError: Ref<ApiError | null>;
  readonly isEmpty: ComputedRef<boolean>;
  readonly isLocked: ComputedRef<boolean>;
  readonly estimate: ComputedRef<ProbeEstimate>;
  /** Which project this lock will belong to, and `null` when the studio has none. */
  readonly projectId: Ref<ProjectId | null>;
  readonly attaching: Ref<ActionStatus>;
  load: () => Promise<void>;
  useProject: (projectId: ProjectId | null) => Promise<void>;
  select: (id: Slug) => Promise<void>;
  setLane: (lane: StyleProbeLane) => void;
  probe: () => Promise<void>;
  lock: () => Promise<void>;
  attach: () => Promise<void>;
}

/**
 * What a probe costs per image on each lane, in nano-dollars.
 *
 * Both figures come from `KNOWN_MODELS` in `@rv/contracts`, which is the catalogue
 * `@rv/providers`' `pricingFor` defaults to, so the number on screen is the number the
 * server prices with: the free lane is local ComfyUI at `approxPerImageUsd: '0'`, the
 * paid lane is `google/gemini-3.1-flash-lite-image` at `'0.0336'` - the cheapest
 * credible image model in research 2 and the documented default for the paid lane.
 *
 * This is a *projection* and deliberately not the guard. Non-negotiable #3 puts the
 * budget check in front of the provider call on the server, where it can see the run's
 * ledger and the resolved binding. What a screen owes a person is the estimate before
 * they commit, which is this.
 *
 * **Report:** the durable shape is the server answering the estimate with its resolved
 * model binding. The paid lane's model is the `provider.*.imageModel` setting, so a
 * client that assumes the default quotes the wrong price the moment somebody changes it.
 */
export const LANE_PRICE_NANO_USD: Readonly<Record<StyleProbeLane, number>> = {
  free: 0,
  paid: 33_600_000,
};

/**
 * The Style Lab's state: eleven presets, one choice, one bible, one sheet.
 *
 * The store fetches and holds. It formats nothing - money, dates and digits depend on
 * the active locale, which is the view's business - and it computes nothing that belongs
 * to the server. In particular there is no checksum here: a checksum computed in a
 * browser is a *plausible* dedup key that is wrong, and non-negotiable #2 does not
 * survive one of those. `src/shims/node-crypto.ts` makes that a hard error rather than a
 * convention.
 */
export const useStyleLabStore = defineStore('style-lab', (): StyleLabStore => {
  const status = ref<StyleLabStatus>('idle');
  const error = ref<ApiError | null>(null);
  const presets = ref<readonly StylePresetCard[]>([]);
  const selectedId = ref<Slug | null>(null);
  const bible = ref<StyleBible | null>(null);
  const sheet = ref<StyleProbeSheet | null>(null);
  const lane = ref<StyleProbeLane>('free');
  const adopting = ref<ActionStatus>('idle');
  const probing = ref<ActionStatus>('idle');
  const locking = ref<ActionStatus>('idle');
  const attaching = ref<ActionStatus>('idle');
  const actionError = ref<ApiError | null>(null);
  /**
   * Which project a lock belongs to.
   *
   * `null` is a real state and not a missing value: the shelf is worth browsing before
   * a project exists, and a screen opened without one should say what it cannot do
   * rather than refuse to render.
   */
  const projectId = ref<ProjectId | null>(null);

  const selected = computed(
    () => presets.value.find((preset) => preset.id === selectedId.value) ?? null,
  );
  const isEmpty = computed(() => status.value === 'ready' && presets.value.length === 0);
  const isLocked = computed(() => bible.value !== null && bible.value.lockedAt !== null);

  const estimate = computed<ProbeEstimate>(() => ({
    lane: lane.value,
    images: PROBE_TILE_COUNT,
    nanoUsd: LANE_PRICE_NANO_USD[lane.value] * PROBE_TILE_COUNT,
    priced: true,
  }));

  function asApiError(caught: unknown, code: string, message: string): ApiError {
    if (isApiError(caught)) return caught;
    return new ApiError({ failure: 'network', code, message, cause: caught });
  }

  /**
   * The shelf, and the project's own style if it already has one.
   *
   * The second half is the part that was missing. This screen used to know only about
   * presets, so a project that had locked a style last week opened on an empty gallery
   * saying "no style chosen yet" - and locking again minted a second bible that also
   * attached to nothing.
   *
   * A style that fails to load is not an error for the screen: the shelf is still usable
   * and choosing from it is still the right next action. It surfaces on `actionError`,
   * where a failed action belongs, rather than replacing eleven working cards with a
   * retry button.
   */
  async function load(): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const list = await useStudioApi().listStylePresets();
      presets.value = list.presets;
      status.value = 'ready';
    } catch (caught) {
      status.value = 'error';
      error.value = asApiError(
        caught,
        'style-presets-load-failed',
        'the preset shelf could not be loaded',
      );
    }
  }

  /**
   * Adopts a project, and shows the style it has already locked.
   *
   * Separate from `load` and never awaited by it, because the shelf does not depend on a
   * project: eleven cards are worth rendering the moment they arrive, and making them
   * wait on an unrelated request delays the whole screen for a lookup that may return
   * nothing.
   *
   * A style that fails to load is not an error for the screen. The shelf is still usable
   * and choosing from it is still the right next action, so this surfaces on
   * `actionError` rather than replacing eleven working cards with a retry button.
   */
  async function useProject(project: ProjectId | null): Promise<void> {
    projectId.value = project;
    attaching.value = 'idle';
    if (project === null) return;
    try {
      const found = (await useStudioApi().listProjects()).projects.find((p) => p.id === project);
      if (found?.styleBibleId == null) return;
      bible.value = await useStudioApi().getStyleBible(found.styleBibleId);
      // The bible came from the project, not from a card, so no card is selected. Leaving
      // a stale selection standing would put the highlight on a style the project is not
      // using.
      selectedId.value = null;
      attaching.value = 'done';
    } catch (caught) {
      actionError.value = asApiError(
        caught,
        'project-style-load-failed',
        "this project's style could not be loaded",
      );
    }
  }

  /**
   * Choosing a preset is two things, and only the first is instant.
   *
   * The selection is local and free, so the gallery answers inside a frame. The
   * `POST /style/from-preset` behind it mints the bible the probe and the lock both need
   * an id for. A failure there leaves the selection standing: the person chose
   * correctly and the server could not answer, and clearing the choice would punish them
   * for the server's fault.
   */
  async function select(id: Slug): Promise<void> {
    if (selectedId.value === id && bible.value !== null) return;
    selectedId.value = id;
    // A different style invalidates the sheet. Four tiles of the *previous* style sitting
    // under a new name is the worst available lie on a screen whose whole job is showing
    // what a style looks like.
    sheet.value = null;
    bible.value = null;
    actionError.value = null;
    adopting.value = 'busy';
    try {
      bible.value = await useStudioApi().styleFromPreset(id);
      adopting.value = 'done';
    } catch (caught) {
      adopting.value = 'idle';
      actionError.value = asApiError(
        caught,
        'style-from-preset-failed',
        'the style could not be created from that preset',
      );
    }
  }

  function setLane(next: StyleProbeLane): void {
    lane.value = next;
    // The old sheet ran on the old lane and its per-tile cost says so. Leaving it up
    // under a new lane label would misreport what was spent.
    sheet.value = null;
  }

  async function probe(): Promise<void> {
    const current = bible.value;
    if (current === null) return;
    actionError.value = null;
    probing.value = 'busy';
    try {
      sheet.value = await useStudioApi().probeStyle(current.id, lane.value);
      probing.value = 'done';
    } catch (caught) {
      probing.value = 'idle';
      actionError.value = asApiError(
        caught,
        'style-probe-failed',
        'the probe sheet could not be generated',
      );
    }
  }

  /**
   * Locks the bible, then attaches it to the project.
   *
   * Two steps, and the order matters: a project pointing at an unlocked bible is a
   * project every downstream stage refuses, since `assertUsableForGeneration` guards
   * every generation. Locking first means the attachment, if it happens, is always to
   * something usable.
   *
   * They are also reported separately. A lock that succeeded and an attach that failed
   * is a real state - the bible is frozen, the project just does not know about it yet -
   * and collapsing the two would either claim a success that did not happen or hide one
   * that did. The retry is the same button, and re-attaching a locked bible is
   * idempotent, so pressing it again finishes the job rather than starting a new one.
   */
  async function lock(): Promise<void> {
    const current = bible.value;
    if (current === null) return;
    actionError.value = null;
    locking.value = 'busy';
    try {
      bible.value = await useStudioApi().lockStyle(current.id);
      locking.value = 'done';
    } catch (caught) {
      locking.value = 'idle';
      actionError.value = asApiError(caught, 'style-lock-failed', 'the style could not be locked');
      return;
    }
    await attach();
  }

  /**
   * Points the project at the locked bible.
   *
   * Separate from `lock` so the screen can offer it on its own after a partial failure,
   * and so a project that adopts an already-locked style does not have to re-lock it.
   */
  async function attach(): Promise<void> {
    const project = projectId.value;
    const current = bible.value;
    if (project === null || current === null || current.lockedAt === null) return;
    attaching.value = 'busy';
    try {
      await useStudioApi().updateProject(project, { styleBibleId: current.id });
      attaching.value = 'done';
    } catch (caught) {
      attaching.value = 'idle';
      actionError.value = asApiError(
        caught,
        'style-attach-failed',
        'the style was locked, but the project could not be pointed at it',
      );
    }
  }

  return {
    status,
    error,
    presets,
    selectedId,
    selected,
    bible,
    sheet,
    lane,
    adopting,
    probing,
    locking,
    actionError,
    isEmpty,
    isLocked,
    estimate,
    projectId,
    attaching,
    load,
    useProject,
    select,
    attach,
    setLane,
    probe,
    lock,
  };
});
