<script setup lang="ts">
import { type ProjectId } from '@rv/contracts';
import { PhArrowDown, PhStop } from '@phosphor-icons/vue';
import { computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';

import AppButton from '../../components/AppButton.vue';
import AppSkeleton from '../../components/AppSkeleton.vue';
import EmptyState from '../../components/EmptyState.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import RegistrationMark from '../../components/RegistrationMark.vue';
import StoryMotif from '../../components/motifs/StoryMotif.vue';
import { formatNanoUsd, formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';
import { useProjectsStore } from '../../stores/projects.store';
import { useSettingsStore } from '../../stores/settings.store';

import StoryNodeInspector from './components/StoryNodeInspector.vue';
import StoryStageBindings from './components/StoryStageBindings.vue';
import StoryTreeBranch from './components/StoryTreeBranch.vue';
import { OUTLINE_LEVELS } from './api/story-tree';
import { useStoryStore } from './story.store';

/**
 * The Story screen.
 *
 * The job, in one sentence: someone with an idea leaves when a story tree exists at
 * every level, they have edited a beat and it stuck, and they can see which model wrote
 * which part.
 *
 * Everything below follows from three facts about that job.
 *
 * **Generation is past the ten-second threshold**, so it is not a modal and not a
 * spinner. It is seven requests, one per level, and the tree is written back after each
 * one — readable, navigable and editable while the rest is still arriving. The progress
 * strip is determinate because the total is known: there are seven levels, always.
 *
 * **The tree cannot skip a level**, so the only build action ever offered is the next
 * one down. There is no control on this screen that rewrites the whole outline; the
 * per-node rebuild in the inspector is the deliberate, scoped version of that wish.
 *
 * **A model choice is a mid-draft decision**, so the bindings sit here rather than only
 * in Settings, with the rate at each binding beside it.
 */

const { t } = useI18n();
const route = useRoute();
const story = useStoryStore();
const projects = useProjectsStore();
const settings = useSettingsStore();
const localeStore = useLocaleStore();

const TOTAL_LEVELS = OUTLINE_LEVELS.length;
const SKELETON_DEPTHS = [0, 1, 1, 2, 2, 2] as const;

/**
 * Which project's series to show.
 *
 * A query parameter when one is given, the first project otherwise. There is no project
 * picker on this screen: the studio's project switch belongs on the Projects screen and
 * a second one here would be two places to be in disagreement.
 */
const projectId = computed<ProjectId | null>(() => {
  const asked = route.query.project;
  if (typeof asked === 'string') {
    const match = projects.projects.find((project) => project.id === asked);
    if (match !== undefined) return match.id;
  }
  return projects.projects.at(0)?.id ?? null;
});

const busy = computed(() => story.status === 'loading');
const levelsDone = computed(() => story.builtLevels.length);
const complete = computed(() => story.nextLevel === null && levelsDone.value > 0);

/** The level currently being written, or the one that would be written next. */
const upcoming = computed(() => story.levelInFlight ?? story.nextLevel);

onMounted(async () => {
  if (settings.status === 'idle') void settings.load(localeStore.locale);
  if (projects.status === 'idle') await projects.load();
  const id = projectId.value;
  if (id !== null) await story.load(id);
});

watch(projectId, (id) => {
  if (id !== null) void story.load(id);
});

function onSeriesChange(event: Event): void {
  void story.chooseSeries((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="rv-story">
    <header class="rv-story__header">
      <h1 class="rv-story__title">{{ t('story.title') }}</h1>
      <p class="rv-story__subtitle">{{ t('story.subtitle') }}</p>
    </header>

    <!-- ── which series ────────────────────────────────────────────────────── -->
    <div v-if="story.seriesList.length > 1" class="rv-story__context">
      <label class="rv-story__context-label" for="rv-story-series">
        {{ t('story.context.series') }}
      </label>
      <select
        id="rv-story-series"
        class="rv-story__select"
        :value="story.seriesId ?? ''"
        @change="onSeriesChange"
      >
        <option v-for="entry in story.seriesList" :key="entry.id" :value="entry.id">
          {{ entry.title }}
        </option>
      </select>
    </div>

    <StoryStageBindings />

    <!-- ── loading: the shape of a tree, not a spinner ─────────────────────── -->
    <template v-if="busy">
      <p class="rv-visually-hidden" role="status">{{ t('story.loading.tree') }}</p>
      <div class="rv-story__sheet rv-sheet" aria-hidden="true">
        <div
          v-for="(depth, index) in SKELETON_DEPTHS"
          :key="index"
          class="rv-story__skeleton-row"
          :style="{ '--rv-depth': depth }"
        >
          <AppSkeleton inline-size="1.25rem" block-size="1.25rem" shape="block" />
          <div class="rv-story__skeleton-lines">
            <AppSkeleton inline-size="min(20rem, 55%)" block-size="0.9rem" />
            <AppSkeleton inline-size="min(34rem, 90%)" block-size="0.75rem" />
          </div>
        </div>
      </div>
    </template>

    <!--
      The route does not exist on the server. Not "no data": a named, missing feature.
      The mark is held out of register on purpose - it is the studio's way of saying two
      halves that should line up do not.
    -->
    <section v-else-if="story.missingRoute" class="rv-story__unbuilt rv-sheet">
      <RegistrationMark class="rv-story__unbuilt-mark" misregistered />
      <div>
        <h2 class="rv-story__unbuilt-title">{{ t('story.errors.notImplemented') }}</h2>
        <p class="rv-story__note">
          {{ t('story.errors.notImplementedHint', { path: story.missingRoute }) }}
        </p>
      </div>
    </section>

    <!-- ── error, with nothing to fall back on ─────────────────────────────── -->
    <ErrorNotice
      v-else-if="story.status === 'error' && story.error"
      :error="story.error"
      @retry="projectId && story.load(projectId)"
    />

    <p v-else-if="story.seriesList.length === 0" class="rv-story__none">
      {{ t('story.context.noSeries') }}
    </p>

    <!-- ── empty: an invitation, and one action ────────────────────────────── -->
    <EmptyState v-else-if="story.isEmpty">
      <template #art>
        <StoryMotif />
      </template>
      <p class="rv-story__lead">{{ t('story.empty.lead') }}</p>
      <p class="rv-story__subtitle">{{ t('story.empty.hint') }}</p>
      <template v-if="story.series">
        <p class="rv-eyebrow">{{ t('story.empty.ideaLabel') }}</p>
        <p class="rv-story__premise">{{ story.series.premise }}</p>
      </template>
      <AppButton variant="primary" :disabled="story.generating" @click="story.buildRemaining()">
        {{ t('story.empty.start') }}
      </AppButton>
      <p class="rv-story__note">{{ t('story.tree.expandNextHint') }}</p>
    </EmptyState>

    <!-- ── the tree ────────────────────────────────────────────────────────── -->
    <div v-else class="rv-story__layout">
      <div class="rv-story__main">
        <!--
          A failure part-way down the tree is not an empty screen. The notice sits above
          the levels that did land, and they stay open, readable and editable.
        -->
        <ErrorNotice v-if="story.error" :error="story.error" @retry="story.buildNextLevel()" />

        <section class="rv-story__sheet rv-sheet" :aria-label="t('story.tree.ariaLabel')">
          <header class="rv-story__tree-head">
            <div>
              <h2 class="rv-story__tree-title">{{ t('story.tree.heading') }}</h2>
              <p class="rv-story__note rv-tabular">
                {{
                  t('story.stream.progress', {
                    done: formatNumber(levelsDone, localeStore.locale),
                    total: formatNumber(TOTAL_LEVELS, localeStore.locale),
                  })
                }}
                — {{ formatNanoUsd(story.totalSpentNanoUsd, localeStore.locale) }}
              </p>
            </div>

            <div class="rv-story__tree-actions">
              <AppButton
                v-if="story.generating"
                size="sm"
                variant="danger"
                @click="story.stopBuilding()"
              >
                <PhStop :size="14" weight="fill" aria-hidden="true" />
                {{ t('story.stream.cancel') }}
              </AppButton>
              <AppButton
                v-else-if="story.nextLevel"
                variant="primary"
                size="sm"
                @click="story.buildNextLevel()"
              >
                <PhArrowDown :size="14" aria-hidden="true" />
                {{ t('story.tree.expandNext', { level: t(`story.levels.${story.nextLevel}`) }) }}
              </AppButton>
              <span v-else class="rv-story__note">{{ t('story.tree.complete') }}</span>
            </div>
          </header>

          <!--
            Determinate, because the total is known: seven levels, always. The bar moves
            in seven discrete jumps and its transition is stepped, which is this
            interface's way of saying the machine is driving — a person dragging
            something gets a smooth curve, a job in progress does not.
          -->
          <div v-if="story.generating" class="rv-story__progress">
            <RegistrationMark class="rv-story__busy" busy />
            <div
              class="rv-story__bar"
              role="progressbar"
              :aria-valuemin="0"
              :aria-valuemax="TOTAL_LEVELS"
              :aria-valuenow="levelsDone"
              :aria-valuetext="
                t('story.stream.progress', {
                  done: formatNumber(levelsDone, localeStore.locale),
                  total: formatNumber(TOTAL_LEVELS, localeStore.locale),
                })
              "
            >
              <span
                class="rv-story__bar-fill"
                :style="{ inlineSize: `${String((levelsDone / TOTAL_LEVELS) * 100)}%` }"
              />
            </div>
            <p class="rv-story__note" role="status">
              <template v-if="upcoming">
                {{ t('story.stream.building', { level: t(`story.levels.${upcoming}`) }) }}
              </template>
              {{ t('story.stream.keepReading') }}
            </p>
          </div>

          <StoryTreeBranch :nodes="story.roots" :depth="0" />
        </section>

        <p v-if="!complete && !story.generating" class="rv-story__note rv-story__discipline">
          {{ t('story.tree.expandNextHint') }}
        </p>
      </div>

      <StoryNodeInspector />
    </div>
  </div>
</template>

<style scoped>
.rv-story {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
}

.rv-story__header {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-story__title {
  font-size: var(--rv-text-2xl);
}

.rv-story__subtitle {
  color: var(--rv-color-text-muted);
  max-inline-size: 46rem;
}

.rv-story__lead {
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-medium);
}

.rv-story__premise {
  border-inline-start: 2px solid var(--rv-color-accent-line);
  padding-inline-start: var(--rv-space-3);
  color: var(--rv-color-text-muted);
  line-height: var(--rv-leading-snug);
  max-inline-size: 42rem;
}

.rv-story__note {
  font-size: var(--rv-text-xs);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-faint);
  max-inline-size: 46rem;
}

.rv-story__discipline {
  max-inline-size: 60rem;
}

.rv-story__unbuilt {
  display: flex;
  align-items: start;
  gap: var(--rv-space-4);
  padding: var(--rv-space-5);
}

.rv-story__unbuilt-mark {
  font-size: 2rem;
  color: var(--rv-color-text-faint);
  flex: none;
}

.rv-story__unbuilt-title {
  font-size: var(--rv-text-md);
  margin-block-end: var(--rv-space-2);
}

.rv-story__none {
  color: var(--rv-color-text-muted);
}

.rv-story__context {
  display: flex;
  align-items: center;
  gap: var(--rv-space-3);
}

.rv-story__context-label {
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-semibold);
  color: var(--rv-color-text-muted);
}

.rv-story__select {
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  font-size: var(--rv-text-sm);
  min-block-size: 2rem;
}

.rv-story__sheet {
  overflow: hidden;
}

.rv-story__tree-head {
  display: flex;
  flex-wrap: wrap;
  align-items: start;
  justify-content: space-between;
  gap: var(--rv-space-3);
  padding: var(--rv-space-4);
  background-color: var(--rv-color-surface-sunken);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-story__tree-title {
  font-size: var(--rv-text-md);
}

.rv-story__tree-actions {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-story__progress {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-3);
  padding: var(--rv-space-3) var(--rv-space-4);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-story__busy {
  font-size: 1.25rem;
  color: var(--rv-color-accent);
}

.rv-story__bar {
  flex: 1;
  min-inline-size: 8rem;
  block-size: 0.375rem;
  border-radius: var(--rv-radius-pill);
  background-color: var(--rv-color-surface-sunken);
  overflow: hidden;
}

.rv-story__bar-fill {
  display: block;
  block-size: 100%;
  background-color: var(--rv-color-accent);
  transition: inline-size var(--rv-duration-slow) var(--rv-step-2s);
}

.rv-story__layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(18rem, 24rem);
  align-items: start;
  gap: var(--rv-space-5);
}

.rv-story__main {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
  min-inline-size: 0;
}

.rv-story__skeleton-row {
  display: flex;
  align-items: start;
  gap: var(--rv-space-3);
  padding-block: var(--rv-space-3);
  padding-inline: var(--rv-space-4);
  padding-inline-start: calc(var(--rv-space-4) + var(--rv-depth, 0) * var(--rv-space-4));
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-story__skeleton-lines {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  flex: 1;
}

@media (max-width: 72rem) {
  .rv-story__layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
