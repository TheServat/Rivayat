<script setup lang="ts">
import { PhCurrencyDollar, PhDesktopTower, PhSparkle } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { PROBE_TILE_COUNT, type StyleProbeLane } from '../../api/schemas/style';
import AppBadge from '../../components/AppBadge.vue';
import AppButton from '../../components/AppButton.vue';
import AppSkeleton from '../../components/AppSkeleton.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import { formatNanoUsd, formatNumber } from '../../i18n/format';
import { localised } from '../../i18n/localised';
import { useLocaleStore } from '../../stores/locale.store';
import { LANE_PRICE_NANO_USD, useStyleLabStore } from '../../stores/style-lab.store';

/**
 * Four tiles, and the price of them stated before the button does anything.
 *
 * The second trap in the brief: probing costs a model call, so the estimate and the lane
 * are on screen *before* the commitment, and the free lane is the obvious default rather
 * than the one you have to find. Both lanes carry their own price on the option itself,
 * so choosing between them is one read rather than a choice followed by a surprise.
 */
const { t } = useI18n();
const lab = useStyleLabStore();
const localeStore = useLocaleStore();

/** Literal keys, so the catalogue type-checks them. See `api/error-messages.ts`. */
const LANE_KEYS = {
  free: 'styleLab.probe.laneFree',
  paid: 'styleLab.probe.lanePaid',
} as const satisfies Record<StyleProbeLane, string>;

const LANE_HINT_KEYS = {
  free: 'styleLab.probe.laneFreeHint',
  paid: 'styleLab.probe.lanePaidHint',
} as const satisfies Record<StyleProbeLane, string>;

/**
 * What each lane would cost, not only the chosen one.
 *
 * A per-lane figure rather than one estimate that changes when you switch: the decision
 * is a comparison, and an interface that makes you toggle back and forth to compare two
 * numbers has hidden the number that matters. The price table is the store's, so there
 * is still one source for it.
 */
const perLane = computed(() =>
  (Object.keys(LANE_PRICE_NANO_USD) as StyleProbeLane[]).map((lane) => ({
    lane,
    nanoUsd: LANE_PRICE_NANO_USD[lane] * PROBE_TILE_COUNT,
  })),
);

const tileSlots = computed(() => Array.from({ length: PROBE_TILE_COUNT }, (_, index) => index));
const styleName = computed(() =>
  lab.selected === null ? '' : localised(lab.selected.name, localeStore.locale),
);
</script>

<template>
  <section class="sl-probe" :aria-label="t('styleLab.probe.heading')">
    <header class="sl-probe__head">
      <h2 class="sl-probe__title">{{ t('styleLab.probe.heading') }}</h2>
      <p class="sl-probe__hint">{{ t('styleLab.probe.hint') }}</p>
    </header>

    <fieldset class="sl-probe__lanes" :disabled="lab.bible === null">
      <legend class="rv-eyebrow">{{ t('styleLab.probe.lane') }}</legend>
      <label
        v-for="option in perLane"
        :key="option.lane"
        class="sl-probe__lane"
        :class="{ 'sl-probe__lane--on': lab.lane === option.lane }"
      >
        <input
          class="sl-probe__radio"
          type="radio"
          name="rv-probe-lane"
          :value="option.lane"
          :checked="lab.lane === option.lane"
          @change="lab.setLane(option.lane)"
        />
        <span class="sl-probe__lane-body">
          <span class="sl-probe__lane-head">
            <PhDesktopTower v-if="option.lane === 'free'" :size="15" aria-hidden="true" />
            <PhCurrencyDollar v-else :size="15" aria-hidden="true" />
            <span class="sl-probe__lane-name">{{ t(LANE_KEYS[option.lane]) }}</span>
            <!-- The free lane is marked as the recommendation rather than merely listed
                 first, because "which of these should I pick" is the actual question. -->
            <AppBadge v-if="option.lane === 'free'" tone="success">
              {{ t('styleLab.probe.recommended') }}
            </AppBadge>
          </span>
          <span class="sl-probe__lane-hint">{{ t(LANE_HINT_KEYS[option.lane]) }}</span>
          <span class="sl-probe__lane-cost rv-tabular" :data-zero="option.nanoUsd === 0">
            {{
              option.nanoUsd === 0
                ? t('styleLab.probe.estimateFree')
                : formatNanoUsd(option.nanoUsd, localeStore.locale)
            }}
          </span>
        </span>
      </label>
    </fieldset>

    <!--
      The estimate, on its own line, before the button and never after it. Non-negotiable
      #3 puts the guard on the server; what this screen owes the reader is the number they
      are about to approve.
    -->
    <p class="sl-probe__estimate">
      <span class="rv-eyebrow">{{ t('styleLab.probe.estimate') }}</span>
      <span>
        {{
          t('styleLab.probe.estimateLine', {
            images: formatNumber(lab.estimate.images, localeStore.locale),
            lane: t(LANE_KEYS[lab.lane]),
          })
        }}
      </span>
      <strong class="sl-probe__total rv-tabular" :data-zero="lab.estimate.nanoUsd === 0">
        {{
          lab.estimate.nanoUsd === 0
            ? t('styleLab.probe.estimateFree')
            : formatNanoUsd(lab.estimate.nanoUsd, localeStore.locale)
        }}
      </strong>
    </p>

    <div class="sl-probe__actions">
      <AppButton
        variant="secondary"
        :disabled="lab.bible === null || lab.probing === 'busy'"
        @click="lab.probe()"
      >
        <PhSparkle :size="15" aria-hidden="true" />
        {{
          lab.probing === 'busy'
            ? t('styleLab.probe.running')
            : lab.sheet
              ? t('styleLab.probe.again')
              : t('styleLab.probe.run')
        }}
      </AppButton>
      <p v-if="lab.bible === null" class="sl-probe__hint">{{ t('styleLab.probe.needsStyle') }}</p>
    </div>

    <ErrorNotice v-if="lab.actionError" :error="lab.actionError" @retry="lab.probe()" />

    <!--
      The sheet keeps its shape while it is being made: four skeletons in the grid the
      four tiles will occupy, so nothing jumps when they land.
    -->
    <div v-if="lab.probing === 'busy'" class="sl-probe__sheet" aria-hidden="true">
      <div v-for="slot in tileSlots" :key="slot" class="sl-probe__tile">
        <AppSkeleton shape="block" inline-size="100%" block-size="7.5rem" />
        <AppSkeleton inline-size="60%" block-size="0.75rem" />
      </div>
    </div>
    <p v-if="lab.probing === 'busy'" class="rv-visually-hidden" role="status">
      {{ t('styleLab.probe.running') }}
    </p>

    <div v-else-if="lab.sheet" class="sl-probe__result">
      <p class="sl-probe__result-head">
        <span class="rv-eyebrow">{{ t('styleLab.probe.sheetHeading') }}</span>
        <span>{{ t('styleLab.probe.ranOn', { lane: t(LANE_KEYS[lab.sheet.lane]) }) }}</span>
        <strong class="sl-probe__total rv-tabular" :data-zero="lab.sheet.totalCostNanoUsd === 0">
          {{ t('styleLab.probe.total') }}
          {{ formatNanoUsd(lab.sheet.totalCostNanoUsd, localeStore.locale) }}
        </strong>
      </p>
      <div class="sl-probe__sheet">
        <figure v-for="tile in lab.sheet.tiles" :key="tile.subject" class="sl-probe__tile">
          <img
            class="sl-probe__image"
            :src="tile.imageUrl"
            :alt="
              t('styleLab.probe.tileAlt', {
                subject: localised(tile.label, localeStore.locale),
                style: styleName,
              })
            "
            width="512"
            height="512"
          />
          <figcaption class="sl-probe__caption">
            <span>{{ localised(tile.label, localeStore.locale) }}</span>
            <!-- A zero meaning "free" and a zero meaning "we do not know" must never
                 render the same; the engine draws that distinction and so does this. -->
            <span class="rv-tabular" :data-zero="tile.costNanoUsd === 0">
              {{
                tile.priced
                  ? formatNanoUsd(tile.costNanoUsd, localeStore.locale)
                  : t('styleLab.probe.unpriced')
              }}
            </span>
          </figcaption>
        </figure>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sl-probe {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
}

.sl-probe__head {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.sl-probe__title {
  font-size: var(--rv-text-lg);
}

.sl-probe__hint {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
  max-inline-size: 44rem;
}

.sl-probe__lanes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: var(--rv-space-3);
  margin: 0;
  padding: 0;
  border: 0;
  min-inline-size: 0;
}

.sl-probe__lanes:disabled {
  opacity: 0.55;
}

.sl-probe__lane {
  display: flex;
  align-items: start;
  gap: var(--rv-space-3);
  padding: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  cursor: pointer;
  transition: border-color var(--rv-duration-instant) var(--rv-ease-standard);
}

.sl-probe__lane--on {
  border-color: var(--rv-color-accent);
  box-shadow: inset 0 0 0 1px var(--rv-color-accent);
}

/* A real radio, at 18px plus the label's padding, which clears SC 2.5.8 by construction
   and gets the platform's own focus ring for free. */
.sl-probe__radio {
  margin-block-start: 0.2rem;
  inline-size: 1.125rem;
  block-size: 1.125rem;
  accent-color: var(--rv-color-accent);
  flex: none;
}

.sl-probe__lane-body {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  min-inline-size: 0;
}

.sl-probe__lane-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
}

.sl-probe__lane-name {
  font-weight: var(--rv-weight-semibold);
}

.sl-probe__lane-hint {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  line-height: var(--rv-leading-snug);
}

.sl-probe__lane-cost {
  font-weight: var(--rv-weight-bold);
  color: var(--rv-color-text);
}

.sl-probe__lane-cost[data-zero='true'] {
  color: var(--rv-color-success);
}

.sl-probe__estimate {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--rv-space-2) var(--rv-space-3);
  padding: var(--rv-space-3);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface-sunken);
  border: var(--rv-border-width) solid var(--rv-color-border);
  font-size: var(--rv-text-sm);
}

.sl-probe__total {
  margin-inline-start: auto;
  font-size: var(--rv-text-md);
}

.sl-probe__total[data-zero='true'] {
  color: var(--rv-color-success);
}

.sl-probe__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-3);
}

.sl-probe__result {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.sl-probe__result-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--rv-space-3);
  font-size: var(--rv-text-sm);
}

/*
 * Two by two, always.
 *
 * `auto-fit` let the four tiles reflow to three and one, which reads as a wrapped list
 * rather than as a sheet - and the sheet is the point: four fixed subjects laid out the
 * same way every time, so two styles can be held side by side and compared. It stays
 * 2x2 at every width and the tiles shrink instead.
 */
.sl-probe__sheet {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--rv-space-3);
}

.sl-probe__tile {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  margin: 0;
}

.sl-probe__image {
  inline-size: 100%;
  block-size: auto;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: var(--rv-radius-md);
  border: var(--rv-border-width) solid var(--rv-color-border);
  background-color: var(--rv-color-surface-sunken);
}

.sl-probe__caption {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.sl-probe__caption [data-zero='true'] {
  color: var(--rv-color-text-faint);
}
</style>
