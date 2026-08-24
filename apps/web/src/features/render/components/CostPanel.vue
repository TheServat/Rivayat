<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../../components/AppBadge.vue';
import AppSkeleton from '../../../components/AppSkeleton.vue';
import ErrorNotice from '../../../components/ErrorNotice.vue';
import type { ApiError } from '../../../api/errors';
import { formatInstant, formatNanoUsd } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';
import { formatClock } from '../duration';
import { STATUS_KEYS } from '../labels';
import type { LoadStatus } from '../render.store';
import type { CostReport, RunStatus } from '../render-wire';

/**
 * What a delivery costs, per minute of finished video.
 *
 * Cost per *run* is the number that is easy to show and useless to compare: runs are
 * different lengths, so a one-minute short and a nine-minute episode produce two
 * figures that cannot be put side by side. Cost per delivered minute is the one that
 * answers "can I afford a season of this", which is the question a series owner is
 * actually asking, so it is the headline and the run total is the supporting detail.
 *
 * A run that delivered nothing reports no rate at all rather than zero. "This episode
 * cost nothing per minute" and "this episode delivered no minutes" are different
 * facts, and only one of them is good news.
 */
const props = defineProps<{
  report: CostReport | null;
  status: LoadStatus;
  error: ApiError | null;
}>();

const emit = defineEmits<{ retry: [] }>();

const { t } = useI18n();
const localeStore = useLocaleStore();

const locale = computed(() => localeStore.locale);

const perMinute = computed(() => props.report?.nanoUsdPerDeliveredMinute ?? null);
const deliveredMs = computed(() => props.report?.deliveredMs ?? 0);
const total = computed(() => props.report?.summary.total.costNanoUsd ?? 0);
const rows = computed(() => props.report?.runs ?? []);

const statusTone = (status: RunStatus): 'neutral' | 'info' | 'success' | 'danger' | 'warning' => {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'neutral';
  if (status === 'paused') return 'warning';
  return 'info';
};

const SKELETON_ROWS = [0, 1, 2] as const;
</script>

<template>
  <section class="rv-cost" aria-labelledby="rv-cost-heading">
    <header class="rv-cost__head">
      <h2 id="rv-cost-heading">{{ t('render.cost.heading') }}</h2>
      <p class="rv-cost__lead">{{ t('render.cost.lead') }}</p>
    </header>

    <template v-if="status === 'loading' || status === 'idle'">
      <p class="rv-visually-hidden" role="status">{{ t('common.loading') }}</p>
      <div class="rv-cost__sheet rv-sheet" aria-hidden="true">
        <div class="rv-cost__figures">
          <AppSkeleton
            v-for="row in SKELETON_ROWS"
            :key="row"
            inline-size="8rem"
            block-size="2rem"
          />
        </div>
      </div>
    </template>

    <ErrorNotice v-else-if="status === 'error' && error" :error="error" @retry="emit('retry')" />

    <div v-else class="rv-cost__sheet rv-sheet">
      <dl class="rv-cost__figures">
        <div class="rv-cost__figure rv-cost__figure--headline">
          <dt>{{ t('render.cost.perMinute') }}</dt>
          <dd v-if="perMinute === null" class="rv-cost__none">
            {{ t('render.cost.perMinuteNone') }}
          </dd>
          <dd v-else class="rv-tabular">{{ formatNanoUsd(perMinute, locale) }}</dd>
        </div>

        <div class="rv-cost__figure">
          <dt>{{ t('render.cost.total') }}</dt>
          <dd class="rv-tabular" :data-zero="total === 0">
            {{ total === 0 ? t('render.cost.free') : formatNanoUsd(total, locale) }}
          </dd>
        </div>

        <div class="rv-cost__figure">
          <dt>{{ t('render.cost.delivered') }}</dt>
          <dd v-if="deliveredMs === 0" class="rv-cost__none">
            {{ t('render.cost.deliveredNone') }}
          </dd>
          <dd v-else class="rv-tabular">
            <bdi>{{ formatClock(deliveredMs, locale) }}</bdi>
          </dd>
        </div>
      </dl>

      <table v-if="rows.length > 0" class="rv-cost__table">
        <caption class="rv-eyebrow">
          {{
            t('render.cost.runsHeading')
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ t('render.cost.columns.run') }}</th>
            <th scope="col">{{ t('render.cost.columns.status') }}</th>
            <th scope="col">{{ t('render.cost.columns.delivered') }}</th>
            <th scope="col">{{ t('render.cost.columns.cost') }}</th>
            <th scope="col">{{ t('render.cost.columns.perMinute') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.runId">
            <th scope="row" class="rv-tabular">{{ formatInstant(row.startedAt, locale) }}</th>
            <td>
              <AppBadge :tone="statusTone(row.status)">{{ t(STATUS_KEYS[row.status]) }}</AppBadge>
            </td>
            <td class="rv-tabular">
              <bdi v-if="row.deliveredMs !== null">{{ formatClock(row.deliveredMs, locale) }}</bdi>
              <span v-else class="rv-cost__none">{{ t('render.cost.deliveredNone') }}</span>
            </td>
            <td class="rv-tabular" :data-zero="row.costNanoUsd === 0">
              {{
                row.costNanoUsd === 0
                  ? t('render.cost.free')
                  : formatNanoUsd(row.costNanoUsd, locale)
              }}
            </td>
            <td class="rv-tabular">
              <span v-if="row.nanoUsdPerDeliveredMinute === null" class="rv-cost__none">
                {{ t('render.cost.perMinuteNone') }}
              </span>
              <template v-else>{{ formatNanoUsd(row.nanoUsdPerDeliveredMinute, locale) }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.rv-cost {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
}

.rv-cost__head {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-cost__head h2 {
  font-size: var(--rv-text-lg);
}

.rv-cost__lead {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
  max-inline-size: 46rem;
}

.rv-cost__sheet {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
  padding: var(--rv-space-4);
  overflow-x: auto;
}

.rv-cost__figures {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-6);
  margin: 0;
}

.rv-cost__figure {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-cost__figure dt {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-cost__figure dd {
  margin: 0;
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-semibold);
}

/* The headline is the affordability number. It is the only figure on this screen set
   larger than body copy, because it is the only one that decides anything. */
.rv-cost__figure--headline dd {
  font-size: var(--rv-text-2xl);
  color: var(--rv-color-mark-strong);
}

.rv-cost__none {
  color: var(--rv-color-text-faint);
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-regular);
}

.rv-cost__figure--headline .rv-cost__none {
  font-size: var(--rv-text-md);
}

.rv-cost__table {
  inline-size: 100%;
  min-inline-size: 34rem;
  border-collapse: collapse;
}

.rv-cost__table caption {
  text-align: start;
  padding-block-end: var(--rv-space-2);
}

.rv-cost__table :is(th, td) {
  text-align: start;
  padding-block: var(--rv-space-2);
  padding-inline-end: var(--rv-space-4);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
  font-weight: var(--rv-weight-regular);
  font-size: var(--rv-text-sm);
  vertical-align: middle;
}

.rv-cost__table thead th {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  font-weight: var(--rv-weight-semibold);
  white-space: nowrap;
}

.rv-cost__table tbody tr:last-child :is(th, td) {
  border-block-end: none;
}

[data-zero='true'] {
  color: var(--rv-color-text-faint);
}
</style>
