<script setup lang="ts">
import { AssetId, type RegenerateIntent } from '@rv/contracts';
import { PhMagnifyingGlass, PhSealCheck, PhX } from '@phosphor-icons/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';

import AppBadge from '../../components/AppBadge.vue';
import AppButton from '../../components/AppButton.vue';
import AppSkeleton from '../../components/AppSkeleton.vue';
import EmptyState from '../../components/EmptyState.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import AssetsMotif from '../../components/motifs/AssetsMotif.vue';
import { formatInstant, formatNanoUsd, formatNumber, formatPercent } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';

import { REPRESENTATION_KEYS, representationFromCounts } from './representation';
import AssetDetailPanel from './AssetDetailPanel.vue';
import PlanPanel from './PlanPanel.vue';
import ProduceTrail from './ProduceTrail.vue';
import RegenerateDialog from './RegenerateDialog.vue';
import { useAssetsStore } from './assets.store';

/**
 * The asset library — what exists, what it cost, and how to change one thing.
 *
 * Three of this screen's routes are not implemented in `apps/api` yet, so `unavailable`
 * is a first-class state alongside the other four: it names the endpoint and the story
 * that adds it rather than showing a red banner about a server that is working fine.
 * See the endpoint table in `api/schemas/assets.ts`.
 *
 * The open asset lives in the URL (`?asset=…`) rather than in component state. Anything
 * worth looking at for a minute is worth being able to send to somebody, and a detail
 * panel that vanishes on reload is a panel people screenshot instead of linking.
 */
const { t } = useI18n();
const assets = useAssetsStore();
const localeStore = useLocaleStore();
const route = useRoute();
const router = useRouter();

const searchInput = ref('');

/** Column proportions, shared by the skeleton and the real table so the layout cannot jump. */
const COLUMNS = ['30%', '12%', '10%', '10%', '10%', '14%', '14%'] as const;
const SKELETON_ROWS = [0, 1, 2, 3] as const;

const STATUS_KEYS = {
  generating: 'assets.status.generating',
  matting: 'assets.status.matting',
  rigging: 'assets.status.rigging',
  ready: 'assets.status.ready',
  rejected: 'assets.status.rejected',
  failed: 'assets.status.failed',
} as const;

const STATUS_TONES = {
  generating: 'info',
  matting: 'info',
  rigging: 'info',
  ready: 'success',
  rejected: 'warning',
  failed: 'danger',
} as const;

/** What a fresh take is estimated at, from the plan the server resolved. */
const regenerateEstimate = computed(() => {
  const miss = assets.plan?.resolutions.find((resolution) => resolution.outcome === 'miss');
  return miss?.estimatedCostNanoUsd ?? 0;
});

/**
 * The open asset, parsed out of the URL rather than trusted from it.
 *
 * A query string is user input: `?asset=nonsense` would otherwise become a doomed fetch
 * and a red banner. `AssetId` is the same branded schema the API validates the path
 * parameter with, so an unparseable id is simply "nothing open".
 */
const openId = computed<AssetId | null>(() => {
  const value = route.query.asset;
  if (typeof value !== 'string') return null;
  const parsed = AssetId.safeParse(value);
  return parsed.success ? parsed.data : null;
});

function openAsset(assetId: AssetId): void {
  void router.replace({ query: { ...route.query, asset: assetId } });
}

function closeAsset(): void {
  const { asset: _closed, ...query } = route.query;
  void router.replace({ query });
}

function submitSearch(): void {
  void assets.search(searchInput.value);
}

function clearSearch(): void {
  searchInput.value = '';
  assets.clearSearch();
}

function confirmRegenerate(intent: RegenerateIntent): void {
  void assets.regenerate(intent);
}

onMounted(() => {
  void assets.load();
  void assets.loadPlan();
});

// The URL is the source of truth for which asset is open, so the fetch follows it
// rather than the click - which is what makes a pasted link land on the same panel.
watch(
  openId,
  (id) => {
    if (id === null) {
      assets.close();
      return;
    }
    if (assets.detail?.id !== id) void assets.open(id);
  },
  { immediate: true },
);
</script>

<template>
  <div class="rv-assets">
    <header class="rv-assets__header">
      <h1 class="rv-assets__title">{{ t('assets.title') }}</h1>
      <p class="rv-assets__subtitle">{{ t('assets.subtitle') }}</p>
    </header>

    <!-- ── search ─────────────────────────────────────────────────────────── -->
    <form class="rv-assets__search rv-sheet" role="search" @submit.prevent="submitSearch">
      <label class="rv-assets__field">
        <span class="rv-assets__label">{{ t('assets.search.label') }}</span>
        <input
          v-model="searchInput"
          type="search"
          class="rv-assets__input"
          :placeholder="t('assets.search.placeholder')"
        />
        <span class="rv-assets__hint">{{ t('assets.search.hint') }}</span>
      </label>
      <div class="rv-assets__search-actions">
        <AppButton type="submit" variant="secondary" size="sm">
          <PhMagnifyingGlass :size="14" aria-hidden="true" />
          {{ t('assets.search.submit') }}
        </AppButton>
        <AppButton v-if="assets.searchedFor !== ''" variant="ghost" size="sm" @click="clearSearch">
          <PhX :size="14" aria-hidden="true" />
          {{ t('assets.search.clear') }}
        </AppButton>
      </div>
      <p class="rv-assets__hint rv-assets__cost-note">{{ t('assets.search.costNote') }}</p>

      <div v-if="assets.searchedFor !== ''" class="rv-assets__results" role="status">
        <p v-if="assets.searchStatus === 'loading'">{{ t('assets.search.running') }}</p>
        <template v-else-if="assets.searchHits.length > 0">
          <p class="rv-assets__hint">
            {{
              t(
                'assets.search.results',
                { count: formatNumber(assets.searchHits.length, localeStore.locale) },
                assets.searchHits.length,
              )
            }}
          </p>
          <ul class="rv-assets__hits">
            <li v-for="hit in assets.searchHits" :key="hit.assetId">
              <button type="button" class="rv-assets__hit" @click="openAsset(hit.assetId)">
                <span>{{ hit.label }}</span>
                <span class="rv-mono rv-assets__hit-key" dir="ltr">{{ hit.semanticKey }}</span>
                <AppBadge tone="accent">
                  {{
                    t('assets.search.similarity', {
                      value: formatPercent(hit.similarity, localeStore.locale),
                    })
                  }}
                </AppBadge>
              </button>
            </li>
          </ul>
        </template>
        <p v-else class="rv-assets__hint">{{ t('assets.search.none') }}</p>
      </div>
    </form>

    <!-- ── plan before produce ────────────────────────────────────────────── -->
    <PlanPanel :status="assets.planStatus" :plan="assets.plan" @reload="assets.loadPlan()" />

    <!-- ── the library ────────────────────────────────────────────────────── -->
    <template v-if="assets.status === 'loading'">
      <p class="rv-visually-hidden" role="status">{{ t('assets.loading') }}</p>
      <div class="rv-assets__sheet rv-sheet" aria-hidden="true">
        <div class="rv-assets__skeleton-row rv-assets__skeleton-row--head">
          <AppSkeleton
            v-for="(width, index) in COLUMNS"
            :key="index"
            :inline-size="`calc(${width} - 2rem)`"
            block-size="0.75rem"
          />
        </div>
        <div v-for="row in SKELETON_ROWS" :key="row" class="rv-assets__skeleton-row">
          <AppSkeleton
            v-for="(width, index) in COLUMNS"
            :key="index"
            :inline-size="`calc(${width} - 2rem)`"
            :block-size="index === 0 ? '2.25rem' : '1rem'"
          />
        </div>
      </div>
    </template>

    <section
      v-else-if="assets.status === 'unavailable'"
      class="rv-assets__unavailable rv-sheet"
      role="status"
    >
      <h2 class="rv-assets__unavailable-title">{{ t('assets.unavailable.heading') }}</h2>
      <p class="rv-assets__subtitle">{{ t('assets.unavailable.body') }}</p>
      <p class="rv-mono rv-assets__hint" dir="ltr">
        {{ t('assets.unavailable.endpoint', { method: 'GET', path: '/api/assets' }) }}
      </p>
      <p class="rv-assets__hint">{{ t('assets.unavailable.story', { story: 'RV-208' }) }}</p>
    </section>

    <ErrorNotice
      v-else-if="assets.status === 'error' && assets.error"
      :error="assets.error"
      @retry="assets.load()"
    />

    <EmptyState v-else-if="assets.isEmpty">
      <template #art>
        <AssetsMotif />
      </template>
      <p class="rv-assets__lead">{{ t('assets.empty.heading') }}</p>
      <p class="rv-assets__subtitle">{{ t('assets.empty.body') }}</p>
    </EmptyState>

    <div v-else class="rv-assets__layout">
      <div class="rv-assets__main">
        <p class="rv-assets__summary rv-tabular">
          {{
            t(
              'assets.summary.count',
              { count: formatNumber(assets.assets.length, localeStore.locale) },
              assets.assets.length,
            )
          }}
          &middot;
          {{
            t('assets.summary.spend', {
              amount: formatNanoUsd(assets.totalSpentNanoUsd, localeStore.locale),
            })
          }}
        </p>

        <div class="rv-assets__sheet rv-sheet">
          <table class="rv-assets__table">
            <caption class="rv-visually-hidden">
              {{
                t('assets.title')
              }}
            </caption>
            <colgroup>
              <col v-for="(width, index) in COLUMNS" :key="index" :style="{ inlineSize: width }" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{{ t('assets.columns.asset') }}</th>
                <th scope="col">{{ t('assets.columns.status') }}</th>
                <th scope="col">{{ t('assets.columns.versions') }}</th>
                <th scope="col">{{ t('assets.columns.variants') }}</th>
                <th scope="col">{{ t('assets.columns.clips') }}</th>
                <th scope="col">{{ t('assets.columns.spend') }}</th>
                <th scope="col">{{ t('assets.columns.updated') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(entry, index) in assets.assets"
                :key="entry.id"
                class="rv-enter-item"
                :style="{ '--rv-i': index }"
                :data-open="entry.id === openId"
              >
                <th scope="row" class="rv-assets__name">
                  <button type="button" class="rv-assets__open" @click="openAsset(entry.id)">
                    <span class="rv-assets__label-text">{{ entry.label }}</span>
                    <span class="rv-mono rv-assets__semantic" dir="ltr">{{
                      entry.semanticKey
                    }}</span>
                  </button>
                  <!--
                    How the asset is built, not how it looks. Everything is a cutout
                    today; saying so explicitly is what stops the screen implying that a
                    flat image, a cutout rig and a 2.5D stack are the same shape.
                  -->
                  <AppBadge tone="neutral">
                    {{ t(REPRESENTATION_KEYS[representationFromCounts(entry.partCount).kind]) }}
                  </AppBadge>
                </th>
                <td>
                  <AppBadge :tone="STATUS_TONES[entry.currentStatus]">
                    {{ t(STATUS_KEYS[entry.currentStatus]) }}
                  </AppBadge>
                </td>
                <td class="rv-tabular">
                  {{ formatNumber(entry.versionCount, localeStore.locale) }}
                </td>
                <td class="rv-tabular">
                  {{ formatNumber(entry.variantCount, localeStore.locale) }}
                </td>
                <td class="rv-tabular">{{ formatNumber(entry.clipCount, localeStore.locale) }}</td>
                <td class="rv-tabular rv-assets__spend" :data-zero="entry.spentNanoUsd === 0">
                  {{ formatNanoUsd(entry.spentNanoUsd, localeStore.locale) }}
                </td>
                <td class="rv-tabular rv-assets__when">
                  {{ formatInstant(entry.updatedAt, localeStore.locale) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- ── takes that never registered ────────────────────────────────── -->
        <section
          v-if="assets.incomplete.length > 0"
          class="rv-assets__incomplete rv-sheet"
          aria-labelledby="rv-assets-incomplete"
        >
          <h2 id="rv-assets-incomplete" class="rv-assets__section-title">
            {{ t('assets.incomplete.heading') }}
          </h2>
          <p class="rv-assets__hint">{{ t('assets.incomplete.hint') }}</p>
          <article v-for="take in assets.incomplete" :key="take.key" class="rv-assets__take">
            <header class="rv-assets__take-head">
              <span class="rv-assets__label-text">{{ take.label }}</span>
              <span class="rv-mono rv-assets__semantic" dir="ltr">{{ take.semanticKey }}</span>
            </header>
            <ProduceTrail :report="take" />
          </article>
        </section>
      </div>

      <!--
        ── the open asset ───────────────────────────────────────────────────
        Rendered from the store, opened from the URL. Those are two different jobs: the
        query parameter is how a panel is *addressed* so it can be linked to and
        survives a reload, and the store is what the panel is *drawn from*. Gating the
        markup on the URL as well would give one panel two sources of truth, and they
        disagree the moment anything but a click opens an asset.
      -->
      <div
        v-if="assets.detailStatus !== 'idle'"
        class="rv-assets__aside"
        data-testid="asset-detail"
      >
        <div v-if="assets.detailStatus === 'loading'" class="rv-sheet rv-assets__aside-skeleton">
          <AppSkeleton inline-size="60%" block-size="1.5rem" shape="block" />
          <AppSkeleton inline-size="40%" block-size="0.875rem" />
          <AppSkeleton inline-size="100%" block-size="6rem" shape="block" />
          <AppSkeleton inline-size="100%" block-size="4rem" shape="block" />
        </div>

        <ErrorNotice
          v-else-if="assets.detailStatus === 'error' && assets.detailError"
          :error="assets.detailError"
          @retry="openId && assets.open(openId)"
        />

        <template v-else-if="assets.detail">
          <!--
            The evidence, after the fact. Two ids, both live: the one that was current
            before and the one that is current now. A sentence saying "the previous
            version is kept" is a claim; two addressable ids are a demonstration.
          -->
          <div
            v-if="assets.regenerateStatus === 'done' && assets.lastRegenerate"
            class="rv-assets__appended"
            role="status"
          >
            <p class="rv-assets__appended-title">
              <PhSealCheck :size="16" weight="fill" aria-hidden="true" />
              {{
                t('assets.regenerate.appended', {
                  ordinal: formatNumber(assets.lastRegenerate.ordinal, localeStore.locale),
                })
              }}
            </p>
            <p class="rv-assets__hint">{{ t('assets.regenerate.appendedBody') }}</p>
            <p class="rv-mono rv-assets__hint" dir="ltr">
              {{
                t('assets.regenerate.previousStill', {
                  id: assets.lastRegenerate.previousVersionId,
                })
              }}
            </p>
            <p class="rv-mono rv-assets__hint" dir="ltr">
              {{ t('assets.regenerate.newVersion', { id: assets.lastRegenerate.newVersionId }) }}
            </p>
          </div>

          <AssetDetailPanel
            :asset="assets.detail"
            :version="assets.selectedVersion"
            :report="assets.report"
            @close="closeAsset"
            @select-version="assets.selectVersion($event)"
            @regenerate="assets.beginRegenerate()"
          />
        </template>
      </div>
    </div>

    <RegenerateDialog
      v-if="
        (assets.regenerateStatus === 'confirming' ||
          assets.regenerateStatus === 'sending' ||
          assets.regenerateStatus === 'error') &&
        assets.detail &&
        assets.selectedVersion
      "
      :asset="assets.detail"
      :current-version="assets.selectedVersion"
      :estimate-nano-usd="regenerateEstimate"
      :sending="assets.regenerateStatus === 'sending'"
      :failed="assets.regenerateStatus === 'error'"
      @cancel="assets.cancelRegenerate()"
      @confirm="confirmRegenerate"
    />
  </div>
</template>

<style scoped>
.rv-assets {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
}

.rv-assets__header {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-assets__title {
  font-size: var(--rv-text-2xl);
}

.rv-assets__subtitle {
  color: var(--rv-color-text-muted);
  max-inline-size: 46rem;
}

.rv-assets__lead {
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-medium);
}

.rv-assets__hint {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  line-height: var(--rv-leading-snug);
  overflow-wrap: anywhere;
}

.rv-assets__search {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--rv-space-3);
  padding: var(--rv-space-4);
}

.rv-assets__field {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  flex: 1 1 22rem;
  min-inline-size: 0;
}

.rv-assets__label {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
}

.rv-assets__input {
  inline-size: 100%;
  min-block-size: 2.25rem;
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
}

.rv-assets__search-actions {
  display: flex;
  gap: var(--rv-space-2);
}

.rv-assets__cost-note {
  flex-basis: 100%;
}

.rv-assets__results {
  flex-basis: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

.rv-assets__hits {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-assets__hit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
  inline-size: 100%;
  min-block-size: 2.25rem;
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-2);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-sm);
  background-color: var(--rv-color-surface-sunken);
  cursor: pointer;
  text-align: start;
}

.rv-assets__hit:hover {
  border-color: var(--rv-color-accent);
}

.rv-assets__hit-key {
  color: var(--rv-color-text-muted);
}

.rv-assets__layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--rv-space-4);
  align-items: start;
}

@media (min-width: 78rem) {
  .rv-assets__layout:has(.rv-assets__aside) {
    grid-template-columns: minmax(0, 1fr) minmax(0, 26rem);
  }
}

.rv-assets__main {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
  min-inline-size: 0;
}

.rv-assets__aside {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  min-inline-size: 0;
  position: sticky;
  inset-block-start: var(--rv-space-4);
}

.rv-assets__aside-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  padding: var(--rv-space-4);
}

.rv-assets__summary {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

/*
 * Scrolls whenever it overflows, not only below a viewport breakpoint.
 *
 * The detail panel takes a third of the row, so the table runs out of room long before
 * the *window* does - and a media query keyed to the window silently clipped the
 * "updated" column instead of letting it scroll. Overflow is a property of the box, so
 * the rule has to be too.
 */
.rv-assets__sheet {
  overflow-x: auto;
  overflow-y: hidden;
}

.rv-assets__table {
  inline-size: 100%;
  min-inline-size: 44rem;
  border-collapse: collapse;
}

.rv-assets__table :is(th, td) {
  text-align: start;
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
  font-weight: var(--rv-weight-regular);
  vertical-align: top;
}

.rv-assets__table thead th {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  background-color: var(--rv-color-surface-sunken);
  font-weight: var(--rv-weight-semibold);
  white-space: nowrap;
}

.rv-assets__table tbody tr:last-child :is(th, td) {
  border-block-end: none;
}

.rv-assets__table tbody tr[data-open='true'] {
  background-color: var(--rv-color-accent-soft);
}

.rv-assets__open {
  display: flex;
  flex-direction: column;
  align-items: start;
  gap: 0.125rem;
  inline-size: 100%;
  min-block-size: 2.25rem;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  text-align: start;
  color: inherit;
}

.rv-assets__label-text {
  font-weight: var(--rv-weight-medium);
  color: var(--rv-color-accent);
}

.rv-assets__open:hover .rv-assets__label-text {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.rv-assets__semantic {
  color: var(--rv-color-text-muted);
}

.rv-assets__spend {
  font-weight: var(--rv-weight-medium);
}

.rv-assets__spend[data-zero='true'] {
  color: var(--rv-color-text-faint);
  font-weight: var(--rv-weight-regular);
}

.rv-assets__when {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
}

.rv-assets__skeleton-row {
  display: flex;
  align-items: center;
  gap: var(--rv-space-4);
  padding-block: var(--rv-space-3);
  padding-inline: var(--rv-space-4);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-assets__skeleton-row--head {
  background-color: var(--rv-color-surface-sunken);
}

.rv-assets__unavailable {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  padding: var(--rv-space-5);
  border-color: var(--rv-color-info);
  background-color: var(--rv-color-info-soft);
}

.rv-assets__unavailable-title {
  font-size: var(--rv-text-lg);
  color: var(--rv-color-info);
}

.rv-assets__incomplete {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  padding: var(--rv-space-4);
}

.rv-assets__section-title {
  font-size: var(--rv-text-lg);
}

.rv-assets__take {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  padding: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface-sunken);
}

.rv-assets__take-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--rv-space-2);
}

.rv-assets__appended {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  padding: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-success);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-success-soft);
  animation: rv-register-in var(--rv-duration-normal) var(--rv-ease-register) backwards;
}

.rv-assets__appended-title {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  font-weight: var(--rv-weight-bold);
  color: var(--rv-color-success);
}
</style>
