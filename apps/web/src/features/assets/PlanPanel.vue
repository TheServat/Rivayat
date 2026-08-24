<script setup lang="ts">
import type { AssetDemandPlan, AssetResolution } from '@rv/contracts';
import { PhArrowsClockwise, PhSealCheck } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../components/AppBadge.vue';
import AppButton from '../../components/AppButton.vue';
import AppSkeleton from '../../components/AppSkeleton.vue';
import { formatNanoUsd, formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';

/**
 * Plan before produce: hits, misses, and the exact estimate.
 *
 * The number that has to be believable is `$0.00`. A run whose demand resolves entirely
 * to cache hits costs nothing, and this panel is where the user sees that *before*
 * anybody presses anything - so a zero total is stated as a zero and given its own
 * sentence rather than being rendered as an empty cell somebody has to interpret.
 *
 * The resolver writes nothing and calls no provider, which is a property
 * `@rv/asset-registry` asserts directly. That is why this panel can be open by default
 * instead of hidden behind a button: reading the estimate is free, and hiding a free,
 * relevant number behind a click is how people end up not reading it.
 */
const props = defineProps<{
  status: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  plan: AssetDemandPlan | null;
}>();

defineEmits<{ reload: [] }>();

const { t } = useI18n();
const localeStore = useLocaleStore();

const TONES: Readonly<
  Record<AssetResolution['outcome'], 'success' | 'accent' | 'warning' | 'danger'>
> = {
  'cache-hit': 'success',
  'variant-of-hit': 'accent',
  miss: 'warning',
  'blocked-by-budget': 'danger',
};

const OUTCOME_KEYS: Readonly<Record<AssetResolution['outcome'], string>> = {
  'cache-hit': 'assets.plan.outcome.cache-hit',
  'variant-of-hit': 'assets.plan.outcome.variant-of-hit',
  miss: 'assets.plan.outcome.miss',
  'blocked-by-budget': 'assets.plan.outcome.blocked-by-budget',
};

const isFree = computed(() => props.plan !== null && props.plan.totalEstimatedNanoUsd === 0);

/** Misses first: they are the only rows that will spend anything. */
const rows = computed(() =>
  [...(props.plan?.resolutions ?? [])].sort(
    (left, right) =>
      right.estimatedCostNanoUsd - left.estimatedCostNanoUsd ||
      left.spec.semanticKey.localeCompare(right.spec.semanticKey),
  ),
);
</script>

<template>
  <section class="rv-plan rv-sheet" aria-labelledby="rv-plan-heading">
    <header class="rv-plan__head">
      <div>
        <h2 id="rv-plan-heading" class="rv-plan__title">{{ t('assets.plan.heading') }}</h2>
        <p class="rv-plan__hint">{{ t('assets.plan.hint') }}</p>
      </div>
      <AppButton size="sm" variant="ghost" @click="$emit('reload')">
        <PhArrowsClockwise :size="14" aria-hidden="true" />
        {{ t('assets.plan.reload') }}
      </AppButton>
    </header>

    <div v-if="status === 'loading'" class="rv-plan__figures" aria-hidden="true">
      <AppSkeleton
        v-for="index in 3"
        :key="index"
        inline-size="8rem"
        block-size="2.75rem"
        shape="block"
      />
    </div>

    <p v-else-if="status === 'unavailable'" class="rv-plan__hint">
      {{ t('assets.plan.unavailable') }}
    </p>

    <template v-else-if="plan">
      <dl class="rv-plan__figures">
        <div class="rv-plan__figure">
          <dt>{{ t('assets.plan.hits') }}</dt>
          <dd class="rv-tabular">{{ formatNumber(plan.hitCount, localeStore.locale) }}</dd>
        </div>
        <div class="rv-plan__figure">
          <dt>{{ t('assets.plan.misses') }}</dt>
          <dd class="rv-tabular">{{ formatNumber(plan.missCount, localeStore.locale) }}</dd>
        </div>
        <div class="rv-plan__figure rv-plan__figure--total" :data-free="isFree">
          <dt>{{ t('assets.plan.estimate') }}</dt>
          <dd class="rv-tabular">
            {{ formatNanoUsd(plan.totalEstimatedNanoUsd, localeStore.locale) }}
          </dd>
        </div>
      </dl>

      <p v-if="isFree" class="rv-plan__free">
        <PhSealCheck :size="16" weight="fill" aria-hidden="true" />
        {{ t('assets.plan.freeNote') }}
      </p>
      <AppBadge v-if="plan.requiresConfirmation" tone="warning">
        {{ t('assets.plan.requiresConfirmation') }}
      </AppBadge>

      <table class="rv-plan__table">
        <caption class="rv-visually-hidden">
          {{
            t('assets.plan.resolutions')
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ t('assets.columns.asset') }}</th>
            <th scope="col">{{ t('assets.columns.status') }}</th>
            <th scope="col">{{ t('assets.plan.estimate') }}</th>
            <th scope="col">{{ t('assets.plan.reason') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key">
            <th scope="row" class="rv-plan__key rv-mono">{{ row.spec.semanticKey }}</th>
            <td>
              <AppBadge :tone="TONES[row.outcome]">{{ t(OUTCOME_KEYS[row.outcome]) }}</AppBadge>
            </td>
            <td class="rv-tabular" :data-zero="row.estimatedCostNanoUsd === 0">
              {{ formatNanoUsd(row.estimatedCostNanoUsd, localeStore.locale) }}
            </td>
            <td class="rv-plan__reason">{{ row.reason }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>

<style scoped>
.rv-plan {
  display: flex;
  flex-direction: column;
  align-items: start;
  gap: var(--rv-space-4);
  padding: var(--rv-space-4);
}

.rv-plan__head {
  display: flex;
  inline-size: 100%;
  flex-wrap: wrap;
  align-items: start;
  justify-content: space-between;
  gap: var(--rv-space-3);
}

.rv-plan__title {
  font-size: var(--rv-text-lg);
}

.rv-plan__hint {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
  max-inline-size: 46rem;
}

.rv-plan__figures {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-3);
  margin: 0;
}

.rv-plan__figure {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  min-inline-size: 8rem;
  padding: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface-sunken);
}

.rv-plan__figure dt {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-plan__figure dd {
  margin: 0;
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-bold);
}

.rv-plan__figure--total {
  border-color: var(--rv-color-mark);
  background-color: var(--rv-color-mark-soft);
}

.rv-plan__figure--total dd {
  color: var(--rv-color-mark-strong);
}

/* Zero is not nothing: it is the claim the whole cache exists to make, so it stays
   emphatic rather than dimming into the background the way an empty cell would. */
.rv-plan__figure--total[data-free='true'] {
  border-color: var(--rv-color-success);
  background-color: var(--rv-color-success-soft);
}

.rv-plan__figure--total[data-free='true'] dd {
  color: var(--rv-color-success);
}

.rv-plan__free {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  color: var(--rv-color-success);
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
}

.rv-plan__table {
  inline-size: 100%;
  border-collapse: collapse;
  font-size: var(--rv-text-sm);
}

.rv-plan__table :is(th, td) {
  text-align: start;
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-2);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
  font-weight: var(--rv-weight-regular);
  vertical-align: top;
}

.rv-plan__table thead th {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  font-weight: var(--rv-weight-semibold);
  white-space: nowrap;
}

.rv-plan__key {
  overflow-wrap: anywhere;
}

.rv-plan__table td[data-zero='true'] {
  color: var(--rv-color-text-faint);
}

.rv-plan__reason {
  color: var(--rv-color-text-muted);
  max-inline-size: 26rem;
}
</style>
