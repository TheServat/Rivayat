<script setup lang="ts">
import type { ProjectId } from '@rv/contracts';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute } from 'vue-router';

import AppBadge from '../../components/AppBadge.vue';
import AppSkeleton from '../../components/AppSkeleton.vue';
import EmptyState from '../../components/EmptyState.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import CharactersMotif from '../../components/motifs/CharactersMotif.vue';
import RegistrationMark from '../../components/RegistrationMark.vue';
import { useLocaleStore } from '../../stores/locale.store';
import { useProjectsStore } from '../../stores/projects.store';

import CastList from './components/CastList.vue';
import CharacterSheetPanel from './components/CharacterSheetPanel.vue';
import KnowledgeGraph from './components/KnowledgeGraph.vue';
import RelationMatrix from './components/RelationMatrix.vue';
import StateGrid from './components/StateGrid.vue';
import { useCharactersStore, type CharacterTab } from './characters.store';

/**
 * The Characters screen.
 *
 * The job: someone who needs strong, distinct characters leaves when every one carries
 * want / need / wound / lie / ghost, a voice and a motion signature, when the state grid
 * is complete and editable, and when they can ask *what did this character know at E05*
 * and get an answer.
 *
 * The last of those is the one that shapes the layout. The knowledge tab is not a
 * secondary view of the sheet — it is the reason this model was built with two clocks
 * and separate truth and belief edges, so the standpoint controls sit at the top of it
 * at full width rather than as a filter in a corner.
 */

const { t } = useI18n();
const route = useRoute();
const characters = useCharactersStore();
const projects = useProjectsStore();
const localeStore = useLocaleStore();

const TABS: readonly CharacterTab[] = ['sheet', 'states', 'graph', 'matrix'];
const SKELETON_LINES = [0, 1, 2, 3, 4] as const;

const tabRefs = ref<HTMLButtonElement[]>([]);

const projectId = computed<ProjectId | null>(() => {
  const asked = route.query.project;
  if (typeof asked === 'string') {
    const match = projects.projects.find((project) => project.id === asked);
    if (match !== undefined) return match.id;
  }
  return projects.projects.at(0)?.id ?? null;
});

const loading = computed(() => characters.status === 'loading');

onMounted(async () => {
  if (projects.status === 'idle') await projects.load();
  const id = projectId.value;
  if (id !== null) await characters.load(id);
});

watch(projectId, (id) => {
  if (id !== null) void characters.load(id);
});

function onSeriesChange(event: Event): void {
  void characters.chooseSeries((event.target as HTMLSelectElement).value);
}

/**
 * The tab pattern, done properly.
 *
 * `role="tablist"` promises arrow-key movement and a single tab stop; a tablist that
 * does not deliver them is worse than four plain buttons, because a screen-reader user
 * is told to press an arrow and nothing happens.
 */
function onTabKey(event: KeyboardEvent, index: number): void {
  const last = TABS.length - 1;
  // The browser reports the physical key. In a right-to-left document the *next* tab is
  // the one to the left, so the two horizontal arrows swap and the vertical pair does
  // not - which is exactly what a Persian reader expects and what a hard-coded
  // "right means next" gets wrong in the direction the studio ships in.
  const rtl = localeStore.direction === 'rtl';

  let next: number;
  switch (event.key) {
    case 'ArrowRight':
      next = index + (rtl ? -1 : 1);
      break;
    case 'ArrowLeft':
      next = index + (rtl ? 1 : -1);
      break;
    case 'ArrowDown':
      next = index + 1;
      break;
    case 'ArrowUp':
      next = index - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = last;
      break;
    default:
      return;
  }

  event.preventDefault();
  const target = TABS[(next + TABS.length) % TABS.length];
  if (target === undefined) return;
  characters.setTab(target);
  tabRefs.value[TABS.indexOf(target)]?.focus();
}
</script>

<template>
  <div class="rv-chars">
    <header class="rv-chars__header">
      <h1 class="rv-chars__title">{{ t('characters.title') }}</h1>
      <p class="rv-chars__subtitle">{{ t('characters.subtitle') }}</p>
    </header>

    <div v-if="characters.seriesList.length > 1" class="rv-chars__context">
      <label class="rv-chars__context-label" for="rv-chars-series">
        {{ t('characters.context.series') }}
      </label>
      <select
        id="rv-chars-series"
        class="rv-chars__select"
        :value="characters.seriesId ?? ''"
        @change="onSeriesChange"
      >
        <option v-for="entry in characters.seriesList" :key="entry.id" :value="entry.id">
          {{ entry.title }}
        </option>
      </select>
    </div>

    <section v-if="characters.missingRoute" class="rv-chars__unbuilt rv-sheet">
      <RegistrationMark class="rv-chars__unbuilt-mark" misregistered />
      <div>
        <h2 class="rv-chars__unbuilt-title">{{ t('characters.errors.notImplemented') }}</h2>
        <p class="rv-chars__note">
          {{ t('characters.errors.notImplementedHint', { path: characters.missingRoute }) }}
        </p>
      </div>
    </section>

    <ErrorNotice
      v-else-if="characters.status === 'error' && characters.error"
      :error="characters.error"
      @retry="projectId && characters.load(projectId)"
    />

    <p v-else-if="!loading && characters.seriesList.length === 0" class="rv-chars__none">
      {{ t('characters.context.noSeries') }}
    </p>

    <EmptyState v-else-if="characters.isEmpty">
      <template #art>
        <CharactersMotif />
      </template>
      <p class="rv-chars__lead">{{ t('characters.empty.lead') }}</p>
      <p class="rv-chars__subtitle">{{ t('characters.empty.hint') }}</p>
      <RouterLink class="rv-chars__link" to="/story">{{ t('characters.empty.action') }}</RouterLink>
    </EmptyState>

    <div v-else class="rv-chars__layout">
      <CastList class="rv-chars__side" />

      <div class="rv-chars__main">
        <!-- ── loading: the shape of a sheet ─────────────────────────────── -->
        <template v-if="loading">
          <p class="rv-visually-hidden" role="status">{{ t('characters.loading.sheet') }}</p>
          <div class="rv-sheet rv-chars__panel" aria-hidden="true">
            <AppSkeleton inline-size="40%" block-size="1.5rem" />
            <AppSkeleton
              v-for="line in SKELETON_LINES"
              :key="line"
              inline-size="100%"
              block-size="0.9rem"
            />
          </div>
        </template>

        <template v-else-if="characters.selected">
          <header class="rv-chars__person">
            <div class="rv-chars__person-head">
              <h2 class="rv-chars__person-name">{{ characters.selected.canonicalName }}</h2>
              <AppBadge tone="accent">
                {{ t(`characters.cast.importance.${characters.selected.importance}`) }}
              </AppBadge>
              <AppBadge tone="neutral">
                {{ t(`characters.cast.kind.${characters.selected.kind}`) }}
              </AppBadge>
            </div>
            <p class="rv-chars__person-summary">{{ characters.selected.summary }}</p>
          </header>

          <div class="rv-chars__tabs" role="tablist" :aria-label="t('characters.tabs.label')">
            <button
              v-for="(tab, index) in TABS"
              :id="`rv-tab-${tab}`"
              :key="tab"
              :ref="
                (element) => {
                  if (element) tabRefs[index] = element as HTMLButtonElement;
                }
              "
              type="button"
              role="tab"
              class="rv-chars__tab"
              :aria-selected="characters.tab === tab"
              :aria-controls="`rv-panel-${tab}`"
              :tabindex="characters.tab === tab ? 0 : -1"
              @click="characters.setTab(tab)"
              @keydown="onTabKey($event, index)"
            >
              {{ t(`characters.tabs.${tab}`) }}
            </button>
          </div>

          <div
            :id="`rv-panel-${characters.tab}`"
            class="rv-sheet rv-chars__panel"
            role="tabpanel"
            :aria-labelledby="`rv-tab-${characters.tab}`"
            tabindex="0"
          >
            <CharacterSheetPanel
              v-if="characters.tab === 'sheet'"
              :character="characters.selected"
            />
            <StateGrid v-else-if="characters.tab === 'states'" />
            <KnowledgeGraph v-else-if="characters.tab === 'graph'" />
            <RelationMatrix v-else />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rv-chars {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
}

.rv-chars__header {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-chars__title {
  font-size: var(--rv-text-2xl);
}

.rv-chars__subtitle {
  color: var(--rv-color-text-muted);
  max-inline-size: 46rem;
}

.rv-chars__lead {
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-medium);
}

.rv-chars__link {
  font-weight: var(--rv-weight-medium);
}

.rv-chars__unbuilt {
  display: flex;
  align-items: start;
  gap: var(--rv-space-4);
  padding: var(--rv-space-5);
}

.rv-chars__unbuilt-mark {
  font-size: 2rem;
  color: var(--rv-color-text-faint);
  flex: none;
}

.rv-chars__unbuilt-title {
  font-size: var(--rv-text-md);
  margin-block-end: var(--rv-space-2);
}

.rv-chars__note {
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-muted);
  max-inline-size: 46rem;
}

.rv-chars__none {
  color: var(--rv-color-text-muted);
}

.rv-chars__context {
  display: flex;
  align-items: center;
  gap: var(--rv-space-3);
}

.rv-chars__context-label {
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-semibold);
  color: var(--rv-color-text-muted);
}

.rv-chars__select {
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  font-size: var(--rv-text-sm);
  min-block-size: 2rem;
}

.rv-chars__layout {
  display: grid;
  grid-template-columns: minmax(14rem, 19rem) minmax(0, 1fr);
  align-items: start;
  gap: var(--rv-space-5);
}

.rv-chars__side {
  position: sticky;
  inset-block-start: var(--rv-space-4);
  max-block-size: calc(100vh - var(--rv-space-8));
  overflow-y: auto;
}

.rv-chars__main {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  min-inline-size: 0;
}

.rv-chars__person {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

.rv-chars__person-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-chars__person-name {
  font-size: var(--rv-text-xl);
}

.rv-chars__person-summary {
  color: var(--rv-color-text-muted);
  line-height: var(--rv-leading-snug);
  max-inline-size: 52rem;
}

.rv-chars__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-1);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-chars__tab {
  border: none;
  background-color: transparent;
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-4);
  min-block-size: 2.25rem;
  cursor: pointer;
  /* Drawn on every tab, coloured on the selected one, so nothing shifts on selection. */
  border-block-end: 2px solid transparent;
  margin-block-end: -1px;
  transition: color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-chars__tab:hover {
  color: var(--rv-color-text);
}

.rv-chars__tab[aria-selected='true'] {
  color: var(--rv-color-accent);
  border-block-end-color: var(--rv-color-accent);
}

.rv-chars__panel {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  padding: var(--rv-space-5);
}

@media (max-width: 68rem) {
  .rv-chars__layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .rv-chars__side {
    position: static;
    max-block-size: none;
  }
}
</style>
