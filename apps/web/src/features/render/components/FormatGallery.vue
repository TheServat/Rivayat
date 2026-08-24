<script setup lang="ts">
import type { FormatProfile, FormatProfileId, ReframePlan, ShotReframe, Size } from '@rv/contracts';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppButton from '../../../components/AppButton.vue';
import AppSkeleton from '../../../components/AppSkeleton.vue';
import ErrorNotice from '../../../components/ErrorNotice.vue';
import type { ApiError } from '../../../api/errors';
import { formatNumber } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';
import { formatSortIndex } from '../labels';
import type { LoadStatus } from '../render.store';

import FormatCard from './FormatCard.vue';

/**
 * Seven aspect ratios, side by side, each with its real safe area over it.
 *
 * The comparison is the point, so they share one legend, one box size and one reading
 * order - landscape, then the three verticals together, then the feed pair - because
 * the only interesting difference between Shorts, Reels and TikTok is that one of the
 * three carves half its own frame away, and that is invisible unless they sit next to
 * each other.
 */
const props = defineProps<{
  profiles: readonly FormatProfile[];
  selected: ReadonlySet<FormatProfileId>;
  status: LoadStatus;
  error: ApiError | null;
  /** Per-format solver output, keyed by format id. Empty until a composition is picked. */
  plans?: ReadonlyMap<FormatProfileId, ReframePlan>;
  composition?: Size | null;
}>();

const emit = defineEmits<{
  toggle: [id: FormatProfileId];
  selectAll: [];
  clearAll: [];
  retry: [];
}>();

const { t } = useI18n();
const localeStore = useLocaleStore();

const ordered = computed(() =>
  [...props.profiles].sort((left, right) => formatSortIndex(left.id) - formatSortIndex(right.id)),
);

const selectedCount = computed(() => ordered.value.filter((p) => props.selected.has(p.id)).length);

const hasPlans = computed(() => (props.plans?.size ?? 0) > 0);

/**
 * The representative shot of a plan: the one that decides what the card says.
 *
 * A plan holds one entry per shot and a card holds one badge, so the card shows the
 * *worst* answer rather than the first. A delivery whose opening wide shot crops
 * cleanly and whose close-up two shots later does not is a delivery that needs eyes,
 * and reporting the opening shot's verdict would say the opposite.
 */
function representative(id: FormatProfileId): ShotReframe | null {
  const plan = props.plans?.get(id);
  if (plan === undefined) return null;
  return plan.shots.find((shot) => shot.safeAreaViolation) ?? plan.shots[0] ?? null;
}

/** Seven placeholders, shaped like seven cards, so nothing moves when the data lands. */
const SKELETONS = [0, 1, 2, 3, 4, 5, 6] as const;
const SKELETON_FACTS = [0, 1, 2, 3] as const;
</script>

<template>
  <section class="rv-gallery" aria-labelledby="rv-targets-heading">
    <header class="rv-gallery__head">
      <div class="rv-gallery__title">
        <h2 id="rv-targets-heading">{{ t('render.targets.heading') }}</h2>
        <p class="rv-gallery__lead">{{ t('render.targets.lead') }}</p>
      </div>

      <div class="rv-gallery__actions">
        <p class="rv-gallery__count rv-tabular" role="status">
          {{
            t(
              'render.targets.count',
              {
                count: formatNumber(selectedCount, localeStore.locale),
                total: formatNumber(ordered.length, localeStore.locale),
              },
              selectedCount,
            )
          }}
        </p>
        <AppButton
          size="sm"
          :disabled="status !== 'ready' || selectedCount === ordered.length"
          @click="emit('selectAll')"
        >
          {{ t('render.targets.selectAll') }}
        </AppButton>
        <AppButton
          size="sm"
          :disabled="status !== 'ready' || selectedCount === 0"
          @click="emit('clearAll')"
        >
          {{ t('render.targets.clearAll') }}
        </AppButton>
      </div>
    </header>

    <!--
      The key is drawn from the same tokens the overlay is, so a reader matches gold to
      gold rather than to a caption that describes gold.
    -->
    <ul class="rv-gallery__legend">
      <li>
        <span class="rv-key rv-key--frame" aria-hidden="true" />{{ t('render.legend.frame') }}
      </li>
      <li>
        <span class="rv-key rv-key--safe" aria-hidden="true" />{{ t('render.legend.safeArea') }}
      </li>
      <li>
        <span class="rv-key rv-key--chrome" aria-hidden="true" />{{ t('render.legend.chrome') }}
      </li>
    </ul>
    <p class="rv-gallery__note">{{ t('render.safeArea.explain') }}</p>
    <!--
      Said once, not seven times. The framing verdict is per format the moment there is
      a plan; until then it is one fact about the whole screen, and repeating it under
      every card turns a useful admission into noise.
    -->
    <p v-if="!hasPlans && status === 'ready'" class="rv-gallery__note rv-gallery__pending">
      <strong>{{ t('render.reframe.unplanned') }}</strong>
      {{ t('render.reframe.unplannedHint') }}
    </p>

    <template v-if="status === 'loading' || status === 'idle'">
      <p class="rv-visually-hidden" role="status">{{ t('common.loading') }}</p>
      <ul class="rv-gallery__grid" aria-hidden="true">
        <li v-for="row in SKELETONS" :key="row" class="rv-gallery__ghost">
          <AppSkeleton shape="block" inline-size="9rem" block-size="9rem" />
          <AppSkeleton inline-size="70%" block-size="1rem" />
          <AppSkeleton
            v-for="fact in SKELETON_FACTS"
            :key="fact"
            inline-size="90%"
            block-size="0.75rem"
          />
        </li>
      </ul>
    </template>

    <ErrorNotice v-else-if="status === 'error' && error" :error="error" @retry="emit('retry')" />

    <ul v-else class="rv-gallery__grid">
      <FormatCard
        v-for="(profile, index) in ordered"
        :key="profile.id"
        class="rv-enter-item"
        :style="{ '--rv-i': index }"
        :profile="profile"
        :selected="selected.has(profile.id)"
        :plan="representative(profile.id)"
        :composition="composition ?? null"
        @toggle="emit('toggle', profile.id)"
      />
    </ul>

    <p class="rv-gallery__note rv-gallery__note--source">{{ t('render.targets.verified') }}</p>
  </section>
</template>

<style scoped>
.rv-gallery {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
}

.rv-gallery__head {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  justify-content: space-between;
  gap: var(--rv-space-4);
}

.rv-gallery__title {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  min-inline-size: 0;
}

.rv-gallery__title h2 {
  font-size: var(--rv-text-lg);
}

.rv-gallery__lead {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
  max-inline-size: 46rem;
}

.rv-gallery__actions {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-gallery__count {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
  margin-inline-end: var(--rv-space-1);
}

.rv-gallery__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-2) var(--rv-space-5);
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-gallery__legend li {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-key {
  display: inline-block;
  inline-size: 1.25rem;
  block-size: 0.875rem;
}

.rv-key--frame {
  background-color: var(--rv-color-surface-sunken);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
}

.rv-key--safe {
  border: 1.5px dashed var(--rv-color-mark);
}

.rv-key--chrome {
  border: var(--rv-border-width) solid var(--rv-color-text-faint);
  background-image: repeating-linear-gradient(
    45deg,
    transparent 0 3px,
    var(--rv-color-text-faint) 3px 4px
  );
}

.rv-gallery__note {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  max-inline-size: 46rem;
}

.rv-gallery__note--source {
  color: var(--rv-color-text-faint);
}

.rv-gallery__pending {
  padding-inline-start: var(--rv-space-3);
  border-inline-start: 2px solid var(--rv-color-border-strong);
}

.rv-gallery__pending strong {
  color: var(--rv-color-text);
}

/*
 * Stretch, not `start`.
 *
 * Seven cards of four aspect ratios carry different amounts of text - TikTok alone
 * names three exclusion zones and a second codec - so letting each size to its own
 * content left holes punched through the row and a card hanging below its neighbours.
 * Equal-height cards make the row read as a row, which is the whole basis of the
 * comparison this gallery exists for.
 */
.rv-gallery__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: var(--rv-space-4);
  align-items: stretch;
}

.rv-gallery__ghost {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--rv-space-2);
  padding: var(--rv-space-4);
  background-color: var(--rv-color-surface);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-lg);
}
</style>
