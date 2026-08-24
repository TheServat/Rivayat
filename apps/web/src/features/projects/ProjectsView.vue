<script setup lang="ts">
import {
  PhCaretRight,
  PhCircleDashed,
  PhLockSimple,
  PhLockSimpleOpen,
  PhPlus,
} from '@phosphor-icons/vue';
import { nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../components/AppBadge.vue';
import AppButton from '../../components/AppButton.vue';
import AppSkeleton from '../../components/AppSkeleton.vue';
import EmptyState from '../../components/EmptyState.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import ProjectsMotif from '../../components/motifs/ProjectsMotif.vue';
import { formatInstant, formatNanoUsd, formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';
import { useProjectsStore } from '../../stores/projects.store';

import NewProjectPanel from './NewProjectPanel.vue';

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

/**
 * The form's visibility lives here rather than inside it, because three different
 * controls open it - the header, the empty state and the strip at the foot - and focus
 * has to return to whichever one was actually used. Anything else drops a keyboard user
 * back on `<body>`, at the top of the document, having lost their place.
 */
const TRIGGERS = {
  header: 'rv-projects-new-header',
  empty: 'rv-projects-new-empty',
  again: 'rv-projects-new-again',
} as const;

const composing = ref(false);
const announcement = ref('');
const lastTrigger = ref<string>(TRIGGERS.header);

function openComposer(trigger: string): void {
  lastTrigger.value = trigger;
  composing.value = true;
}

async function closeComposer(): Promise<void> {
  composing.value = false;
  await nextTick();
  document.getElementById(lastTrigger.value)?.focus();
}

async function onCreated(name: string): Promise<void> {
  announcement.value = t('projects.new.created', { name });
  await closeComposer();
}

onMounted(() => {
  void projects.load();
});
</script>

<template>
  <div class="rv-projects">
    <header class="rv-projects__header">
      <div class="rv-projects__headings">
        <h1 class="rv-projects__title">{{ t('projects.title') }}</h1>
        <p class="rv-projects__subtitle">{{ t('projects.subtitle') }}</p>
      </div>

      <!--
        The one action this screen exists to offer, in the header, at full size.

        It is present in every state and not only the empty one: a studio whose second
        project needs a different route from its first is a studio with a hidden door.
      -->
      <AppButton
        :id="TRIGGERS.header"
        variant="primary"
        :aria-expanded="composing"
        aria-controls="rv-new-project-panel"
        @click="composing ? closeComposer() : openComposer(TRIGGERS.header)"
      >
        <PhPlus :size="15" weight="bold" aria-hidden="true" />
        {{ t('projects.new.action') }}
      </AppButton>
    </header>

    <!--
      The announcement, not the panel. Announcing the panel's arrival would repeat what
      moving focus into it already says; the creation is the only thing here that happens
      without the user watching for it.
    -->
    <p class="rv-visually-hidden" role="status">{{ announcement }}</p>

    <NewProjectPanel v-if="composing" @close="closeComposer()" @created="onCreated" />

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
      <p class="rv-projects__lead">{{ t('projects.emptyTitle') }}</p>
      <p class="rv-projects__subtitle">{{ t('projects.emptyHint') }}</p>
      <AppButton
        :id="TRIGGERS.empty"
        variant="primary"
        :aria-expanded="composing"
        aria-controls="rv-new-project-panel"
        @click="composing ? closeComposer() : openComposer(TRIGGERS.empty)"
      >
        <PhPlus :size="15" weight="bold" aria-hidden="true" />
        {{ t('projects.new.action') }}
      </AppButton>
    </EmptyState>

    <template v-else>
      <div class="rv-projects__sheet rv-sheet">
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
              :class="{ 'rv-projects__row--new': project.id === projects.createdId }"
              :style="{ '--rv-i': index }"
            >
              <th scope="row" class="rv-projects__name">
                <!--
                  The row goes somewhere, so it looks like it does: accent colour, an
                  underline on hover, and a caret that mirrors with the document. The
                  link's `::after` covers the whole `<tr>`, which makes the hit target the
                  row rather than the word - Fitts, and WCAG 2.2 SC 2.5.8 several times
                  over.

                  Where it goes is Style Lab, because that is genuinely the next step: the
                  pipeline is style-first, and nothing downstream can run against a
                  project whose bible is not locked.
                -->
                <RouterLink
                  class="rv-projects__link"
                  :to="{ name: 'style-lab', query: { project: project.id } }"
                  :aria-label="t('projects.openProject', { name: project.name })"
                >
                  <span class="rv-projects__link-name">{{ project.name }}</span>
                  <PhCaretRight
                    class="rv-projects__caret"
                    :size="14"
                    weight="bold"
                    aria-hidden="true"
                  />
                </RouterLink>
                <!--
                  The partial row. A project can exist before its idea does, and a blank
                  cell would read as a rendering bug; saying so is both honest and a
                  prompt.
                -->
                <span v-if="project.logline" class="rv-projects__logline">
                  {{ project.logline }}
                </span>
                <span v-else class="rv-projects__logline rv-projects__logline--absent">
                  {{ t('projects.noLogline') }}
                </span>
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
          <!--
            What the studio has cost, under the column it belongs to.

            Both numbers are aggregates of rows already on screen rather than anything
            new fetched or invented, which is the only kind of summary worth the space:
            "what has this cost me" is the question a ledger-backed studio has to answer
            without being asked twice.
          -->
          <tfoot>
            <tr>
              <th scope="row" class="rv-projects__total-label">
                {{ t('projects.totals.label') }}
              </th>
              <td></td>
              <td class="rv-tabular">
                {{
                  t(
                    'projects.totals.projects',
                    { count: formatNumber(projects.projects.length, localeStore.locale) },
                    projects.projects.length,
                  )
                }}
              </td>
              <td class="rv-tabular rv-projects__spend">
                {{ formatNanoUsd(projects.totalSpentNanoUsd, localeStore.locale) }}
              </td>
              <td class="rv-projects__when">{{ t('projects.totals.spend') }}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!--
        The invitation, repeated in the populated state.

        The empty state is not the only place someone starts a project, and a screen that
        stops a third of the way down a tall viewport reads as unfinished. This strip is
        the same offer in a quieter voice, and it is the last thing on the page rather
        than the first.
      -->
      <div v-if="!composing" class="rv-projects__again">
        <p class="rv-projects__subtitle">{{ t('projects.startAnother') }}</p>
        <AppButton
          :id="TRIGGERS.again"
          variant="secondary"
          :aria-expanded="composing"
          aria-controls="rv-new-project-panel"
          @click="openComposer(TRIGGERS.again)"
        >
          <PhPlus :size="15" weight="bold" aria-hidden="true" />
          {{ t('projects.new.action') }}
        </AppButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.rv-projects {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
}

/*
 * A list is short and a monitor is tall, so on a desktop the page claims the height it
 * has and puts the invitation at the foot of it rather than leaving a third of the
 * screen blank under a two-row table. The measurement is the viewport less the top bar
 * and the main region's own padding, which is a calculation this screen can make about
 * itself without the shell having to grow a layout contract for it.
 *
 * Guarded to the wide layout: below 64rem the sidebar stacks above the content and the
 * space this subtracts is no longer the space that exists.
 */
@media (min-width: 64rem) {
  .rv-projects {
    min-block-size: calc(100dvh - var(--rv-topbar-height) - var(--rv-space-6) * 2);
  }
}

.rv-projects__header {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  justify-content: space-between;
  gap: var(--rv-space-4);
}

.rv-projects__headings {
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

/*
 * The row a person just created.
 *
 * A saffron edge on the inline-start of the row - the mark, used the way the rest of the
 * interface uses it: this is the thing you were looking for. It is not a colour-only
 * signal, because the announcement already said the name out loud and focus is about to
 * land on it.
 */
.rv-projects__row--new .rv-projects__name {
  box-shadow: inset 3px 0 0 0 var(--rv-color-mark);
}

:root[dir='rtl'] .rv-projects__row--new .rv-projects__name {
  box-shadow: inset -3px 0 0 0 var(--rv-color-mark);
}

/*
 * The cell is the containing block, not the row.
 *
 * `position: relative` on a `<tr>` is supported but historically inconsistent, and the
 * failure mode is not subtle: if the row does not establish a containing block, the
 * stretched `::after` resolves against the viewport and the page acquires one invisible
 * link covering all of it. A table cell has no such ambiguity, and the cell is still
 * 34% of the table wide and the full height of its row.
 */
.rv-projects__name {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  font-weight: var(--rv-weight-medium);
}

.rv-projects__link {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-2);
  min-block-size: 1.5rem;
  color: var(--rv-color-accent);
  font-weight: var(--rv-weight-semibold);
  text-decoration: none;
}

/*
 * The whole cell, not the word.
 *
 * A stretched pseudo-element rather than a link wrapped round each cell: one accessible
 * name, one tab stop, and a target as tall as the row instead of as tall as a line of
 * type. The cell holds no other interactive content, which is the condition that makes
 * this safe.
 */
.rv-projects__link::after {
  content: '';
  position: absolute;
  inset: 0;
}

.rv-projects__link:hover .rv-projects__link-name {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

/*
 * The caret encodes a direction, so it mirrors with the document; an icon of a real
 * object would not. `--rv-flip` is -1 in a right-to-left document, so the same
 * `translateX` on hover nudges it toward the trailing edge in both.
 */
.rv-projects__caret {
  transform: scaleX(var(--rv-flip));
  transition: transform var(--rv-duration-fast) var(--rv-ease-standard);
}

.rv-projects__link:hover .rv-projects__caret {
  transform: scaleX(var(--rv-flip)) translateX(2px);
}

/* The ring itself comes from `base.css` and is never removed. This is only the row
   saying which of its cells the ring belongs to. */
.rv-projects__table tbody tr:has(.rv-projects__link:focus-visible) {
  background-color: var(--rv-color-surface-sunken);
}

.rv-projects__logline {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-regular);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-muted);
  max-inline-size: 30rem;
}

.rv-projects__logline--absent {
  color: var(--rv-color-text-faint);
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

.rv-projects__table tfoot :is(th, td) {
  border-block-end: none;
  border-block-start: var(--rv-border-width) solid var(--rv-color-border-strong);
  background-color: var(--rv-color-surface-sunken);
  font-size: var(--rv-text-sm);
}

.rv-projects__total-label {
  font-weight: var(--rv-weight-semibold);
}

/*
 * The same offer as the empty state, in a quieter voice, and last on the page.
 *
 * `margin-block-start: auto` is what turns the dead space at the bottom of a tall
 * viewport into a deliberate one: the table stays at the top where it is read and the
 * invitation sits at the foot where it is reached for.
 */
.rv-projects__again {
  margin-block-start: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--rv-space-4);
  padding-block: var(--rv-space-4);
  padding-inline: var(--rv-space-5);
  border: var(--rv-border-width) dashed var(--rv-color-border-strong);
  border-radius: var(--rv-radius-lg);
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
