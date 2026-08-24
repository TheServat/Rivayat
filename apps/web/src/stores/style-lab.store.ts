import type { Slug, StyleBible } from '@rv/contracts';
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
  load: () => Promise<void>;
  select: (id: Slug) => Promise<void>;
  setLane: (lane: StyleProbeLane) => void;
  probe: () => Promise<void>;
  lock: () => Promise<void>;
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
  const actionError = ref<ApiError | null>(null);

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
    load,
    select,
    setLane,
    probe,
    lock,
  };
});
