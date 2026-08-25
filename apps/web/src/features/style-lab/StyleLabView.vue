<script setup lang="ts">
import { PhCaretLeft, PhCaretRight, PhFilmStrip, PhPlay } from '@phosphor-icons/vue';
import type { ProjectId, Slug } from '@rv/contracts';
import { usePreferredReducedMotion } from '@vueuse/core';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';

import AppBadge from '../../components/AppBadge.vue';
import AppSkeleton from '../../components/AppSkeleton.vue';
import EmptyState from '../../components/EmptyState.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import StyleLabMotif from '../../components/motifs/StyleLabMotif.vue';
import { formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';
import { useProjectsStore } from '../../stores/projects.store';
import { useStyleLabStore } from '../../stores/style-lab.store';

import LockPanel from './LockPanel.vue';
import { PREVIEW_FRAMES } from './motion-preview';
import PresetCard from './PresetCard.vue';
import ProbePanel from './ProbePanel.vue';

/**
 * Style Lab: choose, probe, lock. Three decisions, and deliberately not a fourth.
 *
 * RV-204 also asks for the motion block as *editable* controls with a live preview. That
 * is not here, and the omission is deliberate rather than unfinished: the API exposes no
 * way to persist an edited bible - there is no `PATCH /api/style/:id`, only
 * `from-preset`, `derive` and `lock` - so editable controls would be a fourth decision
 * that cannot be saved, on the one screen whose brief says three. The motion block is
 * shown in full instead, on every card, moving.
 */
const { t } = useI18n();
const lab = useStyleLabStore();
const localeStore = useLocaleStore();
const projects = useProjectsStore();
const route = useRoute();

/**
 * Which project this lock belongs to.
 *
 * `?project=` when given, the first project otherwise - the same rule the Story and
 * Characters screens follow, so the three agree about what "the current project" means
 * without a second picker to disagree with the one on the Projects screen.
 *
 * The Projects screen has linked here with `?project=` since it was written. This screen
 * ignored it, and the consequence was not cosmetic: a locked bible attached to nothing,
 * so a project stayed at "no style chosen" however many times someone locked one.
 */
const projectId = computed<ProjectId | null>(() => {
  const asked = route.query.project;
  if (typeof asked === 'string') {
    const match = projects.projects.find((project) => project.id === asked);
    if (match !== undefined) return match.id;
  }
  return projects.projects.at(0)?.id ?? null;
});

const project = computed(
  () => projects.projects.find((entry) => entry.id === projectId.value) ?? null,
);

/**
 * Reduced motion decides the default, not the availability.
 *
 * Under `prefers-reduced-motion` the blanket rule in `motion.css` collapses every
 * animation, so a Play control would be a button that does nothing - the strip is the
 * whole experience and it is stepped. Everyone else gets both, with Play the default,
 * because a still gallery is the exact failure this screen exists to avoid.
 */
const reducedMotion = usePreferredReducedMotion();
const canPlay = computed(() => reducedMotion.value !== 'reduce');

const playing = ref(true);
const frame = ref(0);

const stepping = computed(() => !canPlay.value || !playing.value);

function stepBy(delta: number): void {
  frame.value = (frame.value + delta + PREVIEW_FRAMES) % PREVIEW_FRAMES;
}

/** Eight cards' worth of skeleton: enough to fill the fold without pretending to know. */
const SKELETON_CARDS = [0, 1, 2, 3, 4, 5] as const;

function choose(id: Slug): void {
  void lab.select(id);
}

onMounted(() => {
  // Not awaited, and not in this order by accident: the shelf is eleven cards that depend
  // on nothing else on this screen, so it starts immediately and the project list resolves
  // beside it. `projectId` becomes non-null when that lands, and the watcher below picks
  // it up - which is also the path a person takes when they switch project.
  void lab.load();
  if (projects.status === 'idle') void projects.load();
});

watch(projectId, (id) => void lab.useProject(id), { immediate: true });
</script>

<template>
  <div class="sl">
    <header class="sl__header">
      <div class="sl__headings">
        <h1 class="sl__title">{{ t('styleLab.title') }}</h1>
        <p class="sl__subtitle">{{ t('styleLab.subtitle') }}</p>
      </div>
      <AppBadge
        :tone="lab.isLocked ? 'success' : lab.bible ? 'accent' : 'neutral'"
        :title="t('styleLab.state.label')"
      >
        {{
          lab.isLocked
            ? t('styleLab.state.locked')
            : lab.bible
              ? t('styleLab.state.draft')
              : t('styleLab.state.none')
        }}
      </AppBadge>
    </header>

    <template v-if="lab.status === 'loading'">
      <p class="rv-visually-hidden" role="status">{{ t('styleLab.loading') }}</p>
      <!--
        The skeleton is card-shaped, not a spinner: same grid, same aspect, same three
        text lines, so the eleven real cards land into the layout the reader is already
        looking at instead of shoving it down the page.
      -->
      <div class="sl__gallery" aria-hidden="true">
        <div v-for="card in SKELETON_CARDS" :key="card" class="sl__skeleton rv-sheet">
          <AppSkeleton shape="block" inline-size="100%" block-size="7rem" />
          <AppSkeleton inline-size="55%" block-size="1rem" />
          <AppSkeleton inline-size="90%" block-size="0.75rem" />
          <AppSkeleton inline-size="40%" block-size="0.75rem" />
        </div>
      </div>
    </template>

    <ErrorNotice
      v-else-if="lab.status === 'error' && lab.error"
      :error="lab.error"
      @retry="lab.load()"
    />

    <EmptyState v-else-if="lab.isEmpty">
      <template #art>
        <StyleLabMotif />
      </template>
      <p class="sl__lead">{{ t('styleLab.empty.heading') }}</p>
      <p class="sl__subtitle">{{ t('styleLab.empty.body') }}</p>
    </EmptyState>

    <template v-else>
      <section class="sl__step" :aria-label="t('styleLab.steps.choose')">
        <header class="sl__step-head">
          <div class="sl__headings">
            <h2 class="sl__step-title">{{ t('styleLab.steps.choose') }}</h2>
            <p class="sl__subtitle">{{ t('styleLab.steps.chooseHint') }}</p>
          </div>

          <!--
            One playback control for eleven cards, not eleven controls.

            The comparison is the point of the gallery, so every card is on the same frame
            at the same moment; stepping them independently would make two styles
            impossible to hold side by side.
          -->
          <div class="sl__playback" role="group" :aria-label="t('styleLab.playback.label')">
            <div v-if="canPlay" class="sl__toggle">
              <button
                type="button"
                class="sl__toggle-button"
                :class="{ 'sl__toggle-button--on': playing }"
                :aria-pressed="playing"
                @click="playing = true"
              >
                <PhPlay :size="14" weight="fill" aria-hidden="true" />
                {{ t('styleLab.playback.play') }}
              </button>
              <button
                type="button"
                class="sl__toggle-button"
                :class="{ 'sl__toggle-button--on': !playing }"
                :aria-pressed="!playing"
                @click="playing = false"
              >
                <PhFilmStrip :size="14" weight="fill" aria-hidden="true" />
                {{ t('styleLab.playback.step') }}
              </button>
            </div>

            <div v-if="stepping" class="sl__stepper">
              <button
                type="button"
                class="sl__step-button"
                :aria-label="t('styleLab.playback.previous')"
                @click="stepBy(-1)"
              >
                <PhCaretLeft class="sl__step-caret" :size="14" weight="bold" aria-hidden="true" />
              </button>
              <label class="sl__slider">
                <span class="rv-visually-hidden">{{ t('styleLab.playback.label') }}</span>
                <input
                  v-model.number="frame"
                  type="range"
                  min="0"
                  :max="PREVIEW_FRAMES - 1"
                  step="1"
                />
              </label>
              <button
                type="button"
                class="sl__step-button"
                :aria-label="t('styleLab.playback.next')"
                @click="stepBy(1)"
              >
                <PhCaretRight class="sl__step-caret" :size="14" weight="bold" aria-hidden="true" />
              </button>
              <p class="sl__frame rv-tabular" role="status">
                {{
                  t('styleLab.playback.frame', {
                    index: formatNumber(frame + 1, localeStore.locale),
                    total: formatNumber(PREVIEW_FRAMES, localeStore.locale),
                  })
                }}
              </p>
            </div>
          </div>
        </header>

        <p v-if="!canPlay" class="sl__notice">{{ t('styleLab.playback.reduced') }}</p>
        <p v-else class="sl__notice">
          {{ stepping ? t('styleLab.playback.stepHint') : t('styleLab.playback.playHint') }}
        </p>

        <div class="sl__gallery" role="radiogroup" :aria-label="t('styleLab.gallery.label')">
          <PresetCard
            v-for="(preset, index) in lab.presets"
            :key="preset.id"
            class="rv-enter-item"
            :style="{ '--rv-i': index }"
            :preset="preset"
            :selected="lab.selectedId === preset.id"
            :playing="!stepping"
            :frame="frame"
            @choose="choose(preset.id)"
          />
        </div>

        <p v-if="lab.adopting === 'busy'" class="sl__notice" role="status">
          {{ t('styleLab.gallery.adopting') }}
        </p>
      </section>

      <div class="sl__panels">
        <div class="sl__panel rv-sheet">
          <ProbePanel />
        </div>
        <div class="sl__panel rv-sheet">
          <LockPanel />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sl {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-6);
}

.sl__header {
  display: flex;
  flex-wrap: wrap;
  align-items: start;
  justify-content: space-between;
  gap: var(--rv-space-4);
}

.sl__headings {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  min-inline-size: 0;
}

.sl__title {
  font-size: var(--rv-text-2xl);
}

.sl__step-title {
  font-size: var(--rv-text-lg);
}

.sl__subtitle {
  color: var(--rv-color-text-muted);
  max-inline-size: 44rem;
}

.sl__lead {
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-medium);
}

.sl__step {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.sl__step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  justify-content: space-between;
  gap: var(--rv-space-4);
}

.sl__notice {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

.sl__playback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-3);
}

.sl__toggle {
  display: flex;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  overflow: hidden;
}

.sl__toggle-button {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-2);
  min-block-size: 2rem;
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-3);
  border: 0;
  background-color: var(--rv-color-surface);
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-medium);
  cursor: pointer;
  transition:
    background-color var(--rv-duration-instant) var(--rv-ease-standard),
    color var(--rv-duration-instant) var(--rv-ease-standard);
}

/* Pressed is carried by fill *and* by `aria-pressed`, never by colour alone. */
.sl__toggle-button--on {
  background-color: var(--rv-color-accent);
  color: var(--rv-color-accent-text);
}

.sl__stepper {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.sl__step-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 32px square: SC 2.5.8 wants 24, and an icon-only control is the one that most often
     misses it. */
  min-inline-size: 2rem;
  min-block-size: 2rem;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  color: var(--rv-color-text);
  cursor: pointer;
}

.sl__step-button:hover {
  border-color: var(--rv-color-accent);
  color: var(--rv-color-accent);
}

/* The carets encode a direction, so they mirror with the document. */
.sl__step-caret {
  transform: scaleX(var(--rv-flip));
}

.sl__slider input {
  inline-size: 7rem;
  accent-color: var(--rv-color-accent);
}

.sl__frame {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  min-inline-size: 6.5rem;
}

/*
 * The gallery.
 *
 * `auto-fill` at 17rem gives three or four columns on a studio display and one on a
 * phone, and - more importantly - puts the eleven films in a row where they can be
 * compared, which is the only way the motion differences are legible at all.
 */
.sl__gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: var(--rv-space-4);
}

.sl__skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  padding: var(--rv-space-3);
}

.sl__panels {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: var(--rv-space-4);
  align-items: start;
}

.sl__panel {
  padding: var(--rv-space-5);
}

@media (max-width: 60rem) {
  .sl__panels {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
