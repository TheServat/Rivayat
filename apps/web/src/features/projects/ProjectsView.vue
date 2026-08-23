<script setup lang="ts">
import { PhCircleDashed, PhLockSimple, PhLockSimpleOpen } from '@phosphor-icons/vue';
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../components/AppBadge.vue';
import AppSkeleton from '../../components/AppSkeleton.vue';
import EmptyState from '../../components/EmptyState.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import ProjectsMotif from '../../components/motifs/ProjectsMotif.vue';
import { formatInstant, formatNanoUsd, formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';
import { useProjectsStore } from '../../stores/projects.store';

const { t } = useI18n();
const projects = useProjectsStore();
const localeStore = useLocaleStore();

/**
 * Column proportions, shared by the skeleton and the real table.
 *
 * One list, used twice, because a skeleton that is the wrong width is worse than no
 * skeleton: the layout jumps when the data lands and the reader loses their place.
 * Keeping the numbers here rather than in two stylesheets is what stops the two drifting
 * the next time a column is added.
 */
const COLUMNS = ['34%', '16%', '14%', '16%', '20%'] as const;
const SKELETON_ROWS = [0, 1, 2] as const;

onMounted(() => {
  void projects.load();
});
</script>

<template>
  <div class="rv-projects">
    <header class="rv-projects__header">
      <h1 class="rv-projects__title">{{ t('projects.title') }}</h1>
      <p class="rv-projects__subtitle">{{ t('projects.subtitle') }}</p>
    </header>

    <!--
      The status line is for assistive technology; the skeleton is for everyone else.
      Announcing "Loading…" *and* drawing a spinner would say the same thing twice, and
      a live region that is also the visible layout is a live region that re-announces
      itself every time the layout changes.
    -->
    <template v-if="projects.status === 'loading'">
      <p class="rv-visually-hidden" role="status">{{ t('common.loading') }}</p>
      <div class="rv-projects__sheet rv-sheet" aria-hidden="true">
        <div class="rv-projects__skeleton-row rv-projects__skeleton-row--head">
          <AppSkeleton
            v-for="(width, index) in COLUMNS"
            :key="index"
            :inline-size="`calc(${width} - 2rem)`"
            block-size="0.75rem"
          />
        </div>
        <div v-for="row in SKELETON_ROWS" :key="row" class="rv-projects__skeleton-row">
          <AppSkeleton
            v-for="(width, index) in COLUMNS"
            :key="index"
            :inline-size="`calc(${width} - 2rem)`"
            :block-size="index === 0 ? '2.25rem' : '1rem'"
          />
        </div>
      </div>
    </template>

    <ErrorNotice
      v-else-if="projects.status === 'error' && projects.error"
      :error="projects.error"
      @retry="projects.load()"
    />

    <EmptyState v-else-if="projects.isEmpty">
      <template #art>
        <ProjectsMotif />
      </template>
      <p class="rv-projects__lead">{{ t('projects.empty') }}</p>
      <p class="rv-projects__subtitle">{{ t('projects.emptyHint') }}</p>
    </EmptyState>

    <div v-else class="rv-projects__sheet rv-sheet">
      <table class="rv-projects__table">
        <caption class="rv-visually-hidden">
          {{
            t('projects.title')
          }}
        </caption>
        <colgroup>
          <col v-for="(width, index) in COLUMNS" :key="index" :style="{ inlineSize: width }" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{{ t('projects.columns.name') }}</th>
            <th scope="col">{{ t('projects.columns.style') }}</th>
            <th scope="col">{{ t('projects.columns.episodes') }}</th>
            <th scope="col">{{ t('projects.columns.spend') }}</th>
            <th scope="col">{{ t('projects.columns.updated') }}</th>
          </tr>
        </thead>
        <!--
          Rows arrive staggered, 28ms apart, capped by the shared `rv-enter-item` rule.
          A `<TransitionGroup>` was tried here for its free FLIP on reorder and taken
          back out: nothing on this screen reorders yet, and machinery installed for a
          feature that does not exist is machinery nobody will remember to remove.
        -->
        <tbody>
          <tr
            v-for="(project, index) in projects.projects"
            :key="project.id"
            class="rv-enter-item"
            :style="{ '--rv-i': index }"
          >
            <th scope="row" class="rv-projects__name">
              <span>{{ project.name }}</span>
              <span v-if="project.logline" class="rv-projects__logline">{{ project.logline }}</span>
            </th>
            <td>
              <!--
                Lock, open lock, dashed ring. The tone carries the same three states in
                colour, and one man in twelve cannot read that channel — so the shape
                says it too, and the word says it a third time.
              -->
              <AppBadge v-if="project.styleBibleId === null" tone="neutral">
                <template #icon>
                  <PhCircleDashed :size="13" weight="bold" aria-hidden="true" />
                </template>
                {{ t('projects.styleAbsent') }}
              </AppBadge>
              <AppBadge v-else-if="project.styleLocked" tone="success">
                <template #icon>
                  <PhLockSimple :size="13" weight="fill" aria-hidden="true" />
                </template>
                {{ t('projects.styleLocked') }}
              </AppBadge>
              <AppBadge v-else tone="warning">
                <template #icon>
                  <PhLockSimpleOpen :size="13" weight="bold" aria-hidden="true" />
                </template>
                {{ t('projects.styleUnlocked') }}
              </AppBadge>
            </td>
            <td class="rv-tabular">
              {{
                t(
                  'projects.episodeCount',
                  { count: formatNumber(project.episodeCount, localeStore.locale) },
                  project.episodeCount,
                )
              }}
            </td>
            <td class="rv-tabular rv-projects__spend" :data-zero="project.spentNanoUsd === 0">
              {{ formatNanoUsd(project.spentNanoUsd, localeStore.locale) }}
            </td>
            <td class="rv-tabular rv-projects__when">
              {{ formatInstant(project.updatedAt, localeStore.locale) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.rv-projects {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
}

.rv-projects__header {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-projects__title {
  font-size: var(--rv-text-2xl);
}

.rv-projects__subtitle {
  color: var(--rv-color-text-muted);
  max-inline-size: 44rem;
}

.rv-projects__lead {
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-medium);
}

/* The sheet the table is printed on. Overflow is on the wrapper so the rounded corners
   survive and a narrow screen scrolls the columns instead of the page. */
.rv-projects__sheet {
  overflow: hidden;
}

.rv-projects__table {
  inline-size: 100%;
  min-inline-size: 32rem;
  border-collapse: collapse;
}

/*
 * `text-align: start` rather than `left`: the header of a Persian table has to sit at
 * the right edge, and it does so here without a direction-specific override.
 */
.rv-projects__table :is(th, td) {
  text-align: start;
  padding-block: var(--rv-space-3);
  padding-inline: var(--rv-space-4);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
  font-weight: var(--rv-weight-regular);
  vertical-align: top;
}

.rv-projects__table thead th {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  background-color: var(--rv-color-surface-sunken);
  font-weight: var(--rv-weight-semibold);
  white-space: nowrap;
}

.rv-projects__table tbody tr:last-child :is(th, td) {
  border-block-end: none;
}

.rv-projects__table tbody tr {
  transition: background-color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-projects__table tbody tr:hover {
  background-color: var(--rv-color-surface-sunken);
}

.rv-projects__name {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  font-weight: var(--rv-weight-medium);
}

.rv-projects__logline {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-regular);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-muted);
  max-inline-size: 30rem;
}

/* Money that has actually been spent is the only number on this screen worth finding
   at a glance, so nothing has been spent reads back as quiet rather than as zero. */
.rv-projects__spend {
  font-weight: var(--rv-weight-medium);
}

.rv-projects__spend[data-zero='true'] {
  color: var(--rv-color-text-faint);
  font-weight: var(--rv-weight-regular);
}

.rv-projects__when {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
}

.rv-projects__skeleton-row {
  display: flex;
  align-items: center;
  gap: var(--rv-space-4);
  padding-block: var(--rv-space-3);
  padding-inline: var(--rv-space-4);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-projects__skeleton-row--head {
  background-color: var(--rv-color-surface-sunken);
}

@media (max-width: 48rem) {
  .rv-projects__sheet {
    overflow-x: auto;
  }
}
</style>
