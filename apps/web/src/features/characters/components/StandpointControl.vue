<script setup lang="ts">
import { PhClockCounterClockwise, PhEye, PhFilmSlate } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppButton from '../../../components/AppButton.vue';
import { formatInstant, formatNumber } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';
import { useCharactersStore } from '../characters.store';

/**
 * Where the reader is standing, on both clocks and behind whose eyes.
 *
 * This is the screen's feature, so it is the screen's largest control. "As of E05" is
 * not a filter tucked into a corner that quietly narrows a list — it is the question,
 * and the answer to it is the whole graph below. Two clocks and a viewer, each a real
 * labelled control, with a sentence at the top that states the current standpoint in
 * words so it can be read at a glance and screenshotted without ambiguity.
 *
 * The authoring clock is the half nobody would ever find on their own, so it is given
 * named points to stand on rather than a date field. "The graph as it stood before the
 * episode-seven rewrite" is a thing an author wants; `2026-08-15T00:00` is not.
 */

const { t } = useI18n();
const characters = useCharactersStore();
const localeStore = useLocaleStore();

const marks = computed(() => characters.storyMarks);
const min = computed(() => marks.value.at(0)?.at.ordinal ?? 1);
const max = computed(() => marks.value.at(-1)?.at.ordinal ?? 1);

const whenLabel = computed(
  () =>
    characters.currentMark?.label ??
    t('characters.graph.standpoint.storyTimeValue', {
      ordinal: formatNumber(characters.storyOrdinal, localeStore.locale),
    }),
);

const viewerLabel = computed(
  () => characters.viewer?.canonicalName ?? t('characters.graph.standpoint.narrator'),
);

function onStoryTime(event: Event): void {
  characters.setStoryOrdinal(Number((event.target as HTMLInputElement).value));
}

function onViewer(value: string): void {
  characters.setViewer(value === '' ? null : value);
}
</script>

<template>
  <section class="rv-stand" :aria-label="t('characters.graph.standpoint.heading')">
    <header class="rv-stand__head">
      <h3 class="rv-stand__title">{{ t('characters.graph.standpoint.heading') }}</h3>
      <p class="rv-stand__hint">{{ t('characters.graph.standpoint.hint') }}</p>
    </header>

    <!--
      The standpoint, in one sentence. `aria-live` because the graph below changes
      without the user having navigated anywhere, and a change nobody is told about is a
      change a screen-reader user has to go looking for.
    -->
    <p class="rv-stand__summary" role="status">
      {{
        t('characters.graph.standpoint.summary', {
          viewer: viewerLabel,
          when: whenLabel,
        })
      }}
    </p>

    <div class="rv-stand__grid">
      <!-- ── whose eyes ─────────────────────────────────────────────────── -->
      <fieldset class="rv-stand__field">
        <legend class="rv-stand__legend">
          <PhEye :size="14" weight="fill" aria-hidden="true" />
          {{ t('characters.graph.standpoint.viewer') }}
        </legend>
        <p class="rv-stand__help">{{ t('characters.graph.standpoint.viewerHint') }}</p>
        <div class="rv-stand__choices">
          <label class="rv-stand__choice">
            <input
              type="radio"
              name="rv-viewer"
              value=""
              :checked="characters.viewerId === null"
              @change="onViewer('')"
            />
            <span>{{ t('characters.graph.standpoint.narrator') }}</span>
          </label>
          <label v-for="member in characters.cast" :key="member.id" class="rv-stand__choice">
            <input
              type="radio"
              name="rv-viewer"
              :value="member.id"
              :checked="characters.viewerId === member.id"
              @change="onViewer(member.id)"
            />
            <span>{{ member.canonicalName }}</span>
          </label>
        </div>
      </fieldset>

      <!-- ── story time ─────────────────────────────────────────────────── -->
      <div class="rv-stand__field">
        <label class="rv-stand__legend" for="rv-story-time">
          <PhFilmSlate :size="14" weight="fill" aria-hidden="true" />
          {{ t('characters.graph.standpoint.storyTime') }}
        </label>
        <p class="rv-stand__help">{{ t('characters.graph.standpoint.storyTimeHint') }}</p>
        <div class="rv-stand__slider">
          <input
            id="rv-story-time"
            class="rv-stand__range"
            type="range"
            :min="min"
            :max="max"
            step="1"
            :value="characters.storyOrdinal"
            :aria-valuetext="whenLabel"
            list="rv-story-marks"
            @input="onStoryTime"
          />
          <datalist id="rv-story-marks">
            <option v-for="mark in marks" :key="mark.at.ordinal" :value="mark.at.ordinal" />
          </datalist>
          <output class="rv-stand__output rv-tabular" for="rv-story-time">{{ whenLabel }}</output>
        </div>
      </div>

      <!-- ── authoring time ─────────────────────────────────────────────── -->
      <fieldset class="rv-stand__field">
        <legend class="rv-stand__legend">
          <PhClockCounterClockwise :size="14" weight="fill" aria-hidden="true" />
          {{ t('characters.graph.standpoint.authoring') }}
        </legend>
        <p class="rv-stand__help">{{ t('characters.graph.standpoint.authoringHint') }}</p>
        <div class="rv-stand__choices">
          <label class="rv-stand__choice">
            <input
              type="radio"
              name="rv-asof"
              value=""
              :checked="characters.asOf === null"
              @change="characters.setAsOf(null)"
            />
            <span>{{ t('characters.graph.standpoint.authoringNow') }}</span>
          </label>
          <label
            v-for="revision in characters.revisions"
            :key="revision.at"
            class="rv-stand__choice"
          >
            <input
              type="radio"
              name="rv-asof"
              :value="revision.at"
              :checked="characters.asOf === revision.at"
              @change="characters.setAsOf(revision.at)"
            />
            <span>
              <span>{{ revision.label }}</span>
              <span class="rv-stand__stamp rv-tabular">{{
                formatInstant(revision.at, localeStore.locale)
              }}</span>
            </span>
          </label>
        </div>
      </fieldset>
    </div>

    <div v-if="characters.asOf !== null" class="rv-stand__replay">
      <p>{{ t('characters.graph.standpoint.authoringPast') }}</p>
      <AppButton size="sm" @click="characters.setAsOf(null)">
        {{ t('characters.graph.standpoint.reset') }}
      </AppButton>
    </div>
  </section>
</template>

<style scoped>
.rv-stand {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-accent-line);
  border-radius: var(--rv-radius-lg);
  background-color: var(--rv-color-surface);
  padding: var(--rv-space-4);
}

.rv-stand__head {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-stand__title {
  font-size: var(--rv-text-md);
}

.rv-stand__hint {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

/* The sentence the whole panel exists to produce. Deliberately the largest text here. */
.rv-stand__summary {
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-semibold);
  line-height: var(--rv-leading-snug);
  border-inline-start: 3px solid var(--rv-color-mark);
  padding-inline-start: var(--rv-space-3);
  padding-block: var(--rv-space-1);
}

.rv-stand__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: var(--rv-space-4);
  align-items: start;
}

.rv-stand__field {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  border: none;
  margin: 0;
  padding: 0;
  min-inline-size: 0;
}

.rv-stand__legend {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-bold);
  color: var(--rv-color-text);
  padding: 0;
}

.rv-stand__help {
  font-size: var(--rv-text-2xs);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-faint);
}

.rv-stand__choices {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-stand__choice {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-sm);
  cursor: pointer;
  /* 24px of target even when the word is two letters long (SC 2.5.8). */
  min-block-size: 1.5rem;
}

.rv-stand__choice input {
  inline-size: 1.125rem;
  block-size: 1.125rem;
  accent-color: var(--rv-color-accent);
  flex: none;
}

.rv-stand__choice > span {
  display: flex;
  flex-direction: column;
}

.rv-stand__stamp {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
}

.rv-stand__slider {
  display: flex;
  align-items: center;
  gap: var(--rv-space-3);
}

/*
 * A native range. In a right-to-left document the browser already runs the track from
 * the trailing edge, so episode one sits where a Persian reader starts and there is no
 * mirrored control to maintain.
 */
.rv-stand__range {
  flex: 1;
  min-inline-size: 6rem;
  block-size: 1.5rem;
  accent-color: var(--rv-color-accent);
}

.rv-stand__output {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-semibold);
  white-space: nowrap;
}

.rv-stand__replay {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--rv-space-3);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-mark-soft);
  color: var(--rv-color-mark-strong);
  font-size: var(--rv-text-sm);
  padding: var(--rv-space-3);
}
</style>
