<script setup lang="ts">
import { PhWarningCircle } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { formatNumber } from '../../../i18n/format';
import type { StoryMark } from '../api/graph';
import { useLocaleStore } from '../../../stores/locale.store';
import { useCharactersStore } from '../characters.store';

/**
 * How the leads feel about each other, episode by episode.
 *
 * The derived view of RV-072, and the reason it earns a tab: a row that never moves is
 * an arc that never happened, and that is invisible in a graph of the present moment no
 * matter how carefully it is drawn. The flat rows are flagged in words, not left for
 * the reader to notice.
 *
 * Signed values, so zero means something. The bar grows from the centre using logical
 * insets, which puts "devotion" at the reader's own end of the line in both directions
 * without a mirrored rule.
 */

const { t } = useI18n();
const characters = useCharactersStore();
const localeStore = useLocaleStore();

const marks = computed(() => characters.storyMarks);

function fillStyle(strength: number): Record<string, string> {
  return strength >= 0
    ? { insetInlineStart: '50%', inlineSize: `${String(strength * 50)}%` }
    : { insetInlineEnd: '50%', inlineSize: `${String(-strength * 50)}%` };
}

/**
 * The column head for one story mark.
 *
 * A mark carries a `label` only when the fiction has a *name* for that moment. An
 * episode number is a number, so it is rendered here in the reader's own numerals
 * rather than shipped from the server as a string of Latin digits.
 */
function markLabel(mark: StoryMark): string {
  return (
    mark.label ??
    t('characters.graph.standpoint.storyTimeValue', {
      ordinal: formatNumber(mark.at.ordinal, localeStore.locale),
    })
  );
}

function signed(strength: number): string {
  return formatNumber(strength, localeStore.locale, {
    signDisplay: 'always',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}
</script>

<template>
  <section class="rv-matrix" :aria-label="t('characters.matrix.heading')">
    <header class="rv-matrix__head">
      <h2 class="rv-matrix__title">{{ t('characters.matrix.heading') }}</h2>
      <p class="rv-matrix__hint">{{ t('characters.matrix.hint') }}</p>
      <p class="rv-matrix__scale">{{ t('characters.matrix.scale') }}</p>
    </header>

    <p v-if="characters.matrix.length === 0" class="rv-matrix__empty">
      {{ t('characters.matrix.empty') }}
    </p>

    <div v-else class="rv-matrix__scroll">
      <table class="rv-matrix__table">
        <caption class="rv-visually-hidden">
          {{
            t('characters.matrix.heading')
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ t('characters.graph.relations.from') }}</th>
            <th v-for="mark in marks" :key="mark.at.ordinal" scope="col" class="rv-matrix__tick">
              {{ markLabel(mark) }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in characters.matrix" :key="`${row.from.id}-${row.to.id}`">
            <th scope="row" class="rv-matrix__pair">
              <span>{{
                t('characters.matrix.pair', {
                  from: row.from.canonicalName,
                  to: row.to.canonicalName,
                })
              }}</span>
              <span v-if="row.flat" class="rv-matrix__flat">
                <PhWarningCircle :size="12" weight="fill" aria-hidden="true" />
                {{ t('characters.matrix.flat') }}
              </span>
            </th>
            <td v-for="sample in row.samples" :key="sample.ordinal">
              <template v-if="sample.strength !== null">
                <span class="rv-matrix__track" aria-hidden="true">
                  <span class="rv-matrix__centre" />
                  <span
                    class="rv-matrix__fill"
                    :data-sign="sample.strength >= 0"
                    :style="fillStyle(sample.strength)"
                  />
                </span>
                <span class="rv-matrix__value rv-tabular">{{ signed(sample.strength) }}</span>
              </template>
              <span v-else class="rv-matrix__none">{{ t('common.none') }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="characters.matrix.some((row) => row.flat)" class="rv-matrix__hint">
      {{ t('characters.matrix.flatHint') }}
    </p>
  </section>
</template>

<style scoped>
.rv-matrix {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.rv-matrix__head {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-matrix__title {
  font-size: var(--rv-text-lg);
}

.rv-matrix__hint,
.rv-matrix__scale {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  max-inline-size: 46rem;
}

.rv-matrix__scale {
  color: var(--rv-color-text-faint);
}

.rv-matrix__empty {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

.rv-matrix__scroll {
  overflow-x: auto;
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-lg);
  background-color: var(--rv-color-surface);
}

.rv-matrix__table {
  inline-size: 100%;
  border-collapse: collapse;
}

.rv-matrix__table :is(th, td) {
  text-align: start;
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-2);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
  vertical-align: middle;
  font-weight: var(--rv-weight-regular);
}

.rv-matrix__table thead th {
  background-color: var(--rv-color-surface-sunken);
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-semibold);
  color: var(--rv-color-text-muted);
  white-space: nowrap;
}

.rv-matrix__tick {
  min-inline-size: 3.5rem;
}

.rv-matrix__pair {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  min-inline-size: 12rem;
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
}

.rv-matrix__flat {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-1);
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-medium);
  color: var(--rv-color-warning);
}

/*
 * The boundary is the thing WCAG measures on a control, so the track carries a
 * `border-strong` outline - the one neutral verified at 3:1 against a sunken plane.
 * The coloured fill inside it is supplementary: every bar on this screen prints its
 * signed value beside itself, so the colour is a second reading of a number that is
 * already there in words.
 */
.rv-matrix__track {
  position: relative;
  display: block;
  block-size: 0.375rem;
  border-radius: var(--rv-radius-pill);
  background-color: var(--rv-color-surface-sunken);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  overflow: hidden;
}

.rv-matrix__centre {
  position: absolute;
  inset-block: 0;
  inset-inline-start: calc(50% - 1px);
  inline-size: 2px;
  background-color: var(--rv-color-border-strong);
}

.rv-matrix__fill {
  position: absolute;
  inset-block: 0;
  background-color: var(--rv-color-success);
}

.rv-matrix__fill[data-sign='false'] {
  background-color: var(--rv-color-danger);
}

.rv-matrix__value {
  display: block;
  margin-block-start: var(--rv-space-1);
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-muted);
}

.rv-matrix__none {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
}
</style>
