import type {
  Asset,
  AssetDemandPlan,
  AssetId,
  AssetVersionId,
  RegenerateIntent,
} from '@rv/contracts';
import { defineStore } from 'pinia';
import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useStudioApi } from '../../api/client';
import { ApiError, isApiError } from '../../api/errors';
import type {
  AssetLibraryPage,
  AssetProduceReport,
  AssetSearchHit,
  RegenerateOutcome,
} from '../../api/schemas/assets';

/**
 * `unavailable` is not `error`.
 *
 * Three of the routes this screen needs are not implemented in `apps/api` yet, and a
 * red "something went wrong" banner for a backend that was never built teaches the
 * reader to distrust the screen. `unavailable` says *which endpoint is missing and
 * which story adds it*, which is true, actionable, and different from a failure.
 */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';

export type RegenerateStatus = 'idle' | 'confirming' | 'sending' | 'done' | 'error';

/** A 404 from a route that exists means "no such asset"; from one that does not, "not built". */
function missingEndpoint(error: ApiError): boolean {
  return error.failure === 'api' && error.status === 404;
}

function toApiError(caught: unknown, code: string, message: string): ApiError {
  return isApiError(caught)
    ? caught
    : new ApiError({ failure: 'network', code, message, cause: caught });
}

export interface AssetsStore {
  readonly status: Ref<LoadStatus>;
  readonly error: Ref<ApiError | null>;
  readonly page: Ref<AssetLibraryPage | null>;
  readonly query: Ref<string>;

  readonly detailStatus: Ref<LoadStatus>;
  readonly detail: Ref<Asset | null>;
  readonly detailError: Ref<ApiError | null>;
  readonly selectedVersionId: Ref<AssetVersionId | null>;

  readonly report: Ref<AssetProduceReport | null>;

  readonly planStatus: Ref<LoadStatus>;
  readonly plan: Ref<AssetDemandPlan | null>;

  readonly searchStatus: Ref<LoadStatus>;
  readonly searchHits: Ref<readonly AssetSearchHit[]>;
  readonly searchedFor: Ref<string>;

  readonly regenerateStatus: Ref<RegenerateStatus>;
  readonly regenerateError: Ref<ApiError | null>;
  readonly lastRegenerate: Ref<RegenerateOutcome | null>;

  readonly assets: ComputedRef<AssetLibraryPage['assets']>;
  readonly incomplete: ComputedRef<AssetLibraryPage['incomplete']>;
  readonly isEmpty: ComputedRef<boolean>;
  readonly totalSpentNanoUsd: ComputedRef<number>;
  readonly selectedVersion: ComputedRef<Asset['versions'][number] | null>;

  load: (query?: string) => Promise<void>;
  loadPlan: () => Promise<void>;
  search: (query: string) => Promise<void>;
  clearSearch: () => void;
  open: (assetId: AssetId) => Promise<void>;
  close: () => void;
  selectVersion: (versionId: AssetVersionId) => Promise<void>;
  beginRegenerate: () => void;
  cancelRegenerate: () => void;
  regenerate: (intent: RegenerateIntent) => Promise<void>;
}

/**
 * The asset library.
 *
 * The store fetches and holds; it formats nothing. Money and dates depend on the active
 * locale, which is a rendering concern - a store that pre-formatted them would have to
 * be reloaded to switch language.
 *
 * The one behaviour here that is not plumbing is regeneration, and it is deliberately
 * three steps rather than one: `beginRegenerate` opens the dialog and calls nothing,
 * `cancelRegenerate` closes it and calls nothing, and only `regenerate` - which cannot
 * be reached without a `RegenerateIntent` carrying a reason the user chose - issues a
 * request. "Cancelling makes no call" is RV-208's acceptance criterion and it is a
 * property of this shape, not of a component remembering to check a flag.
 */
export const useAssetsStore = defineStore('assets', (): AssetsStore => {
  const status = ref<LoadStatus>('idle');
  const error = ref<ApiError | null>(null);
  const page = ref<AssetLibraryPage | null>(null);
  const query = ref('');

  const detailStatus = ref<LoadStatus>('idle');
  const detail = ref<Asset | null>(null);
  const detailError = ref<ApiError | null>(null);
  const selectedVersionId = ref<AssetVersionId | null>(null);
  const report = ref<AssetProduceReport | null>(null);

  const planStatus = ref<LoadStatus>('idle');
  const plan = ref<AssetDemandPlan | null>(null);

  const searchStatus = ref<LoadStatus>('idle');
  const searchHits = ref<readonly AssetSearchHit[]>([]);
  const searchedFor = ref('');

  const regenerateStatus = ref<RegenerateStatus>('idle');
  const regenerateError = ref<ApiError | null>(null);
  const lastRegenerate = ref<RegenerateOutcome | null>(null);

  const assets = computed(() => page.value?.assets ?? []);
  const incomplete = computed(() => page.value?.incomplete ?? []);
  const isEmpty = computed(
    () => status.value === 'ready' && assets.value.length === 0 && incomplete.value.length === 0,
  );
  const totalSpentNanoUsd = computed(() =>
    assets.value.reduce((total, entry) => total + entry.spentNanoUsd, 0),
  );
  const selectedVersion = computed(() => {
    const asset = detail.value;
    if (asset === null) return null;
    const wanted = selectedVersionId.value ?? asset.currentVersionId;
    return asset.versions.find((version) => version.id === wanted) ?? null;
  });

  async function load(next?: string): Promise<void> {
    if (next !== undefined) query.value = next;
    status.value = 'loading';
    error.value = null;
    try {
      page.value = await useStudioApi().listAssets(query.value);
      status.value = 'ready';
    } catch (caught) {
      const failure = toApiError(
        caught,
        'assets-load-failed',
        'the asset library could not be loaded',
      );
      error.value = failure;
      status.value = missingEndpoint(failure) ? 'unavailable' : 'error';
    }
  }

  /**
   * The estimate, before anything is spent.
   *
   * Read-only and safe to call repeatedly while somebody decides - that is a property
   * `@rv/asset-registry` asserts about the resolver directly, and it is the reason this
   * panel can open by default rather than behind a button.
   */
  async function loadPlan(): Promise<void> {
    planStatus.value = 'loading';
    try {
      plan.value = await useStudioApi().planAssets();
      planStatus.value = 'ready';
    } catch (caught) {
      const failure = toApiError(
        caught,
        'assets-plan-failed',
        'the demand plan could not be resolved',
      );
      planStatus.value = missingEndpoint(failure) ? 'unavailable' : 'error';
    }
  }

  /**
   * Reuse before regrowth.
   *
   * Submit-driven, never keystroke-driven: the live endpoint embeds the query, which is
   * a provider call, and a search-as-you-type box would bill for every character.
   */
  async function search(text: string): Promise<void> {
    const trimmed = text.trim();
    searchedFor.value = trimmed;
    if (trimmed === '') {
      searchHits.value = [];
      searchStatus.value = 'idle';
      return;
    }
    searchStatus.value = 'loading';
    try {
      searchHits.value = await useStudioApi().searchAssets(trimmed);
      searchStatus.value = 'ready';
    } catch (caught) {
      const failure = toApiError(caught, 'assets-search-failed', 'the search could not be run');
      searchStatus.value = missingEndpoint(failure) ? 'unavailable' : 'error';
      searchHits.value = [];
    }
  }

  function clearSearch(): void {
    searchedFor.value = '';
    searchHits.value = [];
    searchStatus.value = 'idle';
  }

  async function open(assetId: AssetId): Promise<void> {
    detailStatus.value = 'loading';
    detailError.value = null;
    detail.value = null;
    report.value = null;
    regenerateStatus.value = 'idle';
    lastRegenerate.value = null;
    try {
      const asset = await useStudioApi().getAsset(assetId);
      detail.value = asset;
      selectedVersionId.value = asset.currentVersionId;
      detailStatus.value = 'ready';
      await loadReport(asset.id, asset.currentVersionId);
    } catch (caught) {
      detailError.value = toApiError(caught, 'asset-open-failed', 'the asset could not be opened');
      detailStatus.value = 'error';
    }
  }

  function close(): void {
    detail.value = null;
    detailStatus.value = 'idle';
    detailError.value = null;
    selectedVersionId.value = null;
    report.value = null;
    regenerateStatus.value = 'idle';
  }

  async function selectVersion(versionId: AssetVersionId): Promise<void> {
    selectedVersionId.value = versionId;
    const asset = detail.value;
    if (asset !== null) await loadReport(asset.id, versionId);
  }

  /**
   * Where this take stopped, and why.
   *
   * A missing report is not a failure of the screen: not every version has one, and the
   * step trail simply does not render. Folding it into `detailStatus` would make an
   * asset unopenable because its produce history was pruned.
   */
  async function loadReport(assetId: AssetId, versionId: AssetVersionId): Promise<void> {
    try {
      report.value = await useStudioApi().getProduceReport(assetId, versionId);
    } catch {
      report.value = null;
    }
  }

  function beginRegenerate(): void {
    regenerateStatus.value = 'confirming';
    regenerateError.value = null;
  }

  /** Closes the dialog. Calls nothing - that is the point of it being its own action. */
  function cancelRegenerate(): void {
    regenerateStatus.value = 'idle';
    regenerateError.value = null;
  }

  async function regenerate(intent: RegenerateIntent): Promise<void> {
    const asset = detail.value;
    if (asset === null) return;
    regenerateStatus.value = 'sending';
    regenerateError.value = null;
    try {
      const outcome = await useStudioApi().regenerateAsset(asset.id, intent);
      lastRegenerate.value = outcome;
      regenerateStatus.value = 'done';
      // Re-read rather than patch: the evidence that matters is the server's own answer
      // to "what versions does this asset have now", and a locally appended row would
      // show the append whether or not it happened.
      const refreshed = await useStudioApi().getAsset(asset.id);
      detail.value = refreshed;
      selectedVersionId.value = outcome.newVersionId;
      await loadReport(refreshed.id, outcome.newVersionId);
      await load();
    } catch (caught) {
      regenerateError.value = toApiError(
        caught,
        'asset-regenerate-failed',
        'the regeneration was refused',
      );
      regenerateStatus.value = 'error';
    }
  }

  return {
    status,
    error,
    page,
    query,
    detailStatus,
    detail,
    detailError,
    selectedVersionId,
    report,
    planStatus,
    plan,
    searchStatus,
    searchHits,
    searchedFor,
    regenerateStatus,
    regenerateError,
    lastRegenerate,
    assets,
    incomplete,
    isEmpty,
    totalSpentNanoUsd,
    selectedVersion,
    load,
    loadPlan,
    search,
    clearSearch,
    open,
    close,
    selectVersion,
    beginRegenerate,
    cancelRegenerate,
    regenerate,
  };
});
