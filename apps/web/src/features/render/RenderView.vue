<script setup lang="ts">
import { FormatProfileId } from '@rv/contracts';
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';

import AppSkeleton from '../../components/AppSkeleton.vue';
import EmptyState from '../../components/EmptyState.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import RenderMotif from '../../components/motifs/RenderMotif.vue';
import { useProjectsStore } from '../../stores/projects.store';

import CostPanel from './components/CostPanel.vue';
import FormatGallery from './components/FormatGallery.vue';
import RunMonitor from './components/RunMonitor.vue';
import { isLiveRunStatus } from './render-wire';
import { useRenderStore } from './render.store';

/**
 * Render and delivery.
 *
 * **The job:** someone ready to publish leaves satisfied when they can see how each
 * platform will frame their composition, watch the delivery that produces the files,
 * and know what a minute of finished video costs.
 *
 * The screen is a composition surface and nothing else - it owns no fetching, no
 * folding and no formatting. What it does own is the *URL*, and that is not
 * bookkeeping: a render takes minutes, so the operation has to be survivable, and
 * survivable means the address bar carries which project, which run and which targets
 * were chosen. Close the tab at minute two, come back at minute six, and the same run
 * is on screen still streaming.
 *
 * Three loads, three statuses, and they are deliberately not merged. The platform
 * table always arrives - it is static data the API serves from the contract - while
 * the cost report needs a project with runs behind it. One combined status would hide
 * seven perfectly good previews behind a failed ledger read, which is the partial
 * state this screen exists in most of the time.
 */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const projects = useProjectsStore();
const render = useRenderStore();

const projectOptions = computed(() => projects.projects);

const selectedFormatIds = computed(() => [...render.selected]);

/** A query value that may legitimately be absent, an array, or nonsense a user typed. */
function queryString(key: string): string | null {
  const raw = route.query[key];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

function readFormatsFromQuery(): FormatProfileId[] | null {
  const raw = queryString('formats');
  if (raw === null) return null;
  const parsed = raw
    .split(',')
    .map((id) => FormatProfileId.safeParse(id))
    .flatMap((result) => (result.success ? [result.data] : []));
  return parsed.length === 0 ? null : parsed;
}

/**
 * Reflect the choice in the address without adding a history entry.
 *
 * `replace`, not `push`: picking a different run is not a navigation, and filling
 * someone's back button with seven format toggles is how a back button stops working.
 */
async function syncQuery(): Promise<void> {
  const query: Record<string, string> = {};
  if (render.projectId !== null) query.project = render.projectId;
  if (render.activeRunId !== null) query.run = render.activeRunId;
  if (
    selectedFormatIds.value.length > 0 &&
    selectedFormatIds.value.length < render.formats.length
  ) {
    query.formats = selectedFormatIds.value.join(',');
  }
  await router.replace({ query });
}

function follow(): void {
  const run = render.activeRun;
  if (run !== null && isLiveRunStatus(run.status)) render.watchActiveRun();
  else render.stopWatching();
}

onMounted(async () => {
  const fromQuery = readFormatsFromQuery();
  // Formats first and awaited, because the default selection is "everything" and
  // applying a narrower choice from the URL has to win over it.
  await render.loadFormats();
  if (fromQuery !== null) render.setSelection(fromQuery);

  await projects.load();
  const wanted = queryString('project');
  const chosen =
    projectOptions.value.find((project) => project.id === wanted) ?? projectOptions.value[0];
  if (chosen === undefined) return;

  await render.loadProject(chosen.id);

  const wantedRun = queryString('run');
  if (wantedRun !== null && render.runs.some((run) => run.id === wantedRun)) {
    render.selectRun(wantedRun);
  }
  follow();
  await syncQuery();
});

onBeforeUnmount(() => {
  render.stopWatching();
});

// A different run is a different stream, and a run that finishes has no stream left
// to hold open. Both are the same watcher because both are "the thing being followed
// changed".
watch(
  () => [render.activeRunId, render.activeRun?.status] as const,
  () => {
    follow();
  },
);

watch(
  () => [render.projectId, render.activeRunId, selectedFormatIds.value.join(',')] as const,
  () => {
    void syncQuery();
  },
);

async function chooseProject(id: string): Promise<void> {
  const parsed = projectOptions.value.find((project) => project.id === id);
  if (parsed === undefined) return;
  await render.loadProject(parsed.id);
  follow();
}
</script>

<template>
  <div class="rv-render">
    <header class="rv-render__header">
      <div class="rv-render__title">
        <h1>{{ t('render.title') }}</h1>
        <p class="rv-render__subtitle">{{ t('render.subtitle') }}</p>
      </div>

      <div class="rv-render__project">
        <label class="rv-render__project-label" for="rv-render-project">
          {{ t('render.project.label') }}
        </label>
        <AppSkeleton
          v-if="projects.status === 'loading'"
          inline-size="12rem"
          block-size="2.25rem"
        />
        <select
          v-else-if="projectOptions.length > 0"
          id="rv-render-project"
          class="rv-render__select"
          :value="render.projectId ?? ''"
          @change="chooseProject(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="project in projectOptions" :key="project.id" :value="project.id">
            {{ project.name }}
          </option>
        </select>
      </div>
    </header>

    <!--
      A failed project list does not stop the format table from being useful, so the
      error sits above the content instead of replacing it. This is the partial state,
      and it is the common one.
    -->
    <ErrorNotice
      v-if="projects.status === 'error' && projects.error"
      :error="projects.error"
      @retry="projects.load()"
    />

    <FormatGallery
      :profiles="render.formats"
      :selected="render.selected"
      :status="render.formatsStatus"
      :error="render.formatsError"
      @toggle="render.toggleFormat($event)"
      @select-all="render.setSelection(render.formats.map((profile) => profile.id))"
      @clear-all="render.setSelection([])"
      @retry="render.loadFormats()"
    />

    <EmptyState v-if="projects.status === 'ready' && projectOptions.length === 0">
      <template #art>
        <RenderMotif />
      </template>
      <p class="rv-render__lead">{{ t('render.project.empty') }}</p>
      <p class="rv-render__subtitle">{{ t('render.project.emptyHint') }}</p>
    </EmptyState>

    <template v-else-if="render.projectId !== null">
      <ErrorNotice
        v-if="render.runsStatus === 'error' && render.runsError"
        :error="render.runsError"
        @retry="render.reloadRuns()"
      />
      <RunMonitor
        v-else
        :run="render.activeRun"
        :runs="render.runs"
        :live="render.live"
        :stream-state="render.streamState"
        :stream-error="render.streamError"
        :acting="render.acting"
        :action-error="render.actionError"
        @select="render.selectRun($event)"
        @cancel="render.cancelActiveRun()"
        @resume="render.resumeActiveRun()"
        @retry="render.reloadRuns()"
      />

      <CostPanel
        :report="render.cost"
        :status="render.costStatus"
        :error="render.costError"
        @retry="render.reloadCost()"
      />
    </template>
  </div>
</template>

<style scoped>
.rv-render {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-6);
}

.rv-render__header {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  justify-content: space-between;
  gap: var(--rv-space-4);
}

.rv-render__title {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  min-inline-size: 0;
}

.rv-render__title h1 {
  font-size: var(--rv-text-2xl);
}

.rv-render__subtitle {
  color: var(--rv-color-text-muted);
  max-inline-size: 44rem;
}

.rv-render__lead {
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-medium);
}

.rv-render__project {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-render__project-label {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-render__select {
  min-block-size: 2.25rem;
  max-inline-size: 18rem;
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-2);
  background-color: var(--rv-color-surface);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  font-size: var(--rv-text-sm);
}
</style>
