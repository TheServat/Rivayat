<script setup lang="ts">
import {
  PhBroadcast,
  PhCircleDashed,
  PhFilmStrip,
  PhFolders,
  PhGearSix,
  PhStack,
  PhSwatches,
  PhTreeStructure,
  PhUsersThree,
} from '@phosphor-icons/vue';
import { useResizeObserver } from '@vueuse/core';
import { computed, nextTick, onMounted, ref, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute } from 'vue-router';

import RegistrationMark from '../components/RegistrationMark.vue';
import { IMPLEMENTED, NAV_KEYS, type NavName } from '../router/index';

const { t } = useI18n();
const route = useRoute();

/**
 * Icons, one per section, from Phosphor.
 *
 * Chosen over Lucide for two reasons that matter here rather than in general. First,
 * six weights: `regular` idle and `fill` selected is a state signal that costs nothing
 * and needs no second icon set, which is exactly the trap that makes an interface look
 * unfinished. Second, coverage of this domain — a swatch sheet, a tree, a filmstrip, a
 * broadcast tower and a crosshair all exist in one hand, and running out and borrowing
 * one glyph from elsewhere is how sets get mixed.
 *
 * None of these are directional, so none of them mirror in Persian. An arrow would;
 * Phosphor's `mirrored` prop is the switch for that, and nothing in this menu needs it.
 */
const ICONS: Readonly<Record<NavName, Component>> = {
  projects: PhFolders,
  'style-lab': PhSwatches,
  story: PhTreeStructure,
  characters: PhUsersThree,
  assets: PhStack,
  timeline: PhFilmStrip,
  render: PhBroadcast,
  settings: PhGearSix,
};

/**
 * The menu is two rails, not one list.
 *
 * The first seven sections are the pipeline **in the order it runs** — an idea becomes
 * a style, then a story, then characters, then assets, then a timeline, then a render.
 * That order is real, so the rail encodes it: a hairline connecting the sections, with
 * the current one clamped to it. Settings is not a stage of anything, so it sits under
 * its own heading rather than pretending to be step eight.
 *
 * Membership is derived from the router rather than restated, so a route added there
 * appears here without a second list to keep in step.
 */
const STUDIO_SECTIONS = new Set<NavName>(['settings']);
const names = Object.keys(NAV_KEYS) as NavName[];

const groups = computed(() => [
  {
    id: 'pipeline',
    label: t('nav.pipeline'),
    items: names.filter((name) => !STUDIO_SECTIONS.has(name)),
  },
  {
    id: 'studio',
    label: t('nav.studio'),
    items: names.filter((name) => STUDIO_SECTIONS.has(name)),
  },
]);

function isActive(name: NavName): boolean {
  return route.name === name;
}

/**
 * The travelling registration mark.
 *
 * Selection does not blink from one item to the next; the mark slides along the rail
 * and settles with a small overshoot, the way a punched sheet is pushed onto a peg.
 * The eye follows one object instead of finding a new one, which is the whole reason
 * shared-element movement beats a cross-fade.
 *
 * Only the block axis moves, so this is direction-agnostic by construction: there is
 * no mirrored measurement to get wrong, and the rail is placed with
 * `inset-inline-start`. On a narrow screen the rail becomes a horizontal chip row and
 * the mark is not rendered at all — a travelling indicator across a scrolling strip
 * would chase the scroll rather than the selection.
 */
const railEl = ref<HTMLElement | null>(null);
const markY = ref(0);
const marked = ref(false);

function measure(): void {
  const root = railEl.value;
  if (root === null) return;
  const active = root.querySelector<HTMLElement>('[data-current="true"]');
  if (active === null) {
    // Nothing is selected — a 404, for instance. The mark is not "somewhere
    // approximate"; it is absent.
    marked.value = false;
    return;
  }
  // Rectangles rather than `offsetTop`. An element's `offsetTop` is measured from its
  // *offset parent*, and each group's `<ul>` is positioned so it can carry the rail —
  // which silently makes the number relative to the group instead of the nav, and puts
  // the mark beside the wrong section.
  const rootBox = root.getBoundingClientRect();
  const box = active.getBoundingClientRect();
  markY.value = box.top - rootBox.top + box.height / 2;
  marked.value = true;

  // On a narrow screen the sections are a scrolling strip; the selected chip has to be
  // brought into view or the current section can be off-screen entirely.
  if (root.scrollWidth > root.clientWidth) {
    active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

onMounted(measure);
useResizeObserver(railEl, measure);
watch(
  () => route.name,
  () => {
    // After the DOM has been patched, not before: measuring on the route change itself
    // reads the rectangle of the item that is about to stop being current.
    void nextTick(measure);
  },
);
</script>

<template>
  <nav ref="railEl" class="rv-nav" :aria-label="t('nav.label')">
    <span
      class="rv-nav__mark"
      :class="{ 'rv-nav__mark--placed': marked }"
      :style="{ transform: `translateY(${String(markY)}px)` }"
      aria-hidden="true"
    >
      <RegistrationMark />
    </span>

    <div v-for="group in groups" :key="group.id" class="rv-nav__group">
      <p :id="`rv-nav-${group.id}`" class="rv-eyebrow rv-nav__heading">{{ group.label }}</p>
      <ul class="rv-nav__list" :aria-labelledby="`rv-nav-${group.id}`">
        <li
          v-for="(name, index) in group.items"
          :key="name"
          class="rv-nav__item rv-enter-item"
          :style="{ '--rv-i': index }"
          :data-current="isActive(name)"
        >
          <RouterLink class="rv-nav__link" :to="{ name }">
            <component
              :is="ICONS[name]"
              class="rv-nav__icon"
              :size="18"
              :weight="isActive(name) ? 'fill' : 'regular'"
              aria-hidden="true"
            />
            <span class="rv-nav__label">{{ t(NAV_KEYS[name]) }}</span>
            <template v-if="!IMPLEMENTED[name]">
              <PhCircleDashed class="rv-nav__unbuilt" :size="14" aria-hidden="true" />
              <!-- The dashed ring is the sighted reader's cue; this is everyone
                   else's. Neither is colour, which is the point. -->
              <span class="rv-visually-hidden">{{ t('placeholder.badge') }}</span>
            </template>
          </RouterLink>
        </li>
      </ul>
    </div>
  </nav>
</template>

<style scoped>
.rv-nav {
  /* Where the rail sits, measured from the nav's own inline-start edge. The list draws
     the rail against its own box and the mark is positioned against the nav's, so the
     two origins have to be written down once instead of added up twice. */
  --rv-rail-x: calc(var(--rv-space-4) + var(--rv-rail-inset));

  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
  padding-block: var(--rv-space-5);
  padding-inline: var(--rv-space-4) var(--rv-space-3);
}

.rv-nav__group {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

.rv-nav__heading {
  padding-inline-start: var(--rv-space-5);
}

/* The peg rail: the hairline the pipeline hangs from. */
.rv-nav__list {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-nav__list::before {
  content: '';
  position: absolute;
  inset-block: 0.4rem;
  inset-inline-start: var(--rv-rail-inset);
  inline-size: 1px;
  background-color: var(--rv-color-rail);
}

.rv-nav__item {
  position: relative;
}

/* One tick per section, punched into the rail. */
.rv-nav__item::before {
  content: '';
  position: absolute;
  inset-block-start: 50%;
  inset-inline-start: calc(var(--rv-rail-inset) - 2px);
  inline-size: 5px;
  block-size: 1px;
  background-color: var(--rv-color-rail);
}

.rv-nav__mark {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: calc(var(--rv-rail-x) - 0.34rem);
  /* The list starts below the group heading; the mark measures against the nav, so it
     needs the same origin. `translateY` supplies the rest. */
  margin-block-start: -0.475rem;
  /*
   * Above the sections, not behind them.
   *
   * The mark and each `<li>` are both positioned with `z-index: auto`, so they paint in
   * tree order — and the mark is written first so that it is not nested inside any one
   * section. Without this, the selected row's own background paints over the very thing
   * that marks it selected, which looks exactly like the indicator not working.
   */
  z-index: 1;
  font-size: 0.95rem;
  color: var(--rv-color-mark);
  opacity: 0;
  transition:
    transform var(--rv-duration-normal) var(--rv-ease-register),
    opacity var(--rv-duration-fast) var(--rv-ease-standard);
}

.rv-nav__mark--placed {
  opacity: 1;
}

/*
 * The mark is drawn at a fifth of the size it has in the wordmark, and a stroke scaled
 * down with it disappears: at 15px the 1.25-unit stroke lands on two thirds of a device
 * pixel and the target reads as a smudge. Optical size is not a scale factor, so the
 * weight is set for this size rather than inherited from the other one.
 */
.rv-nav__mark :deep(.rv-mark__plate) {
  stroke-width: 2.1;
}

/* Named, so a view transition carries it from one section to the next rather than
   fading it out here and in over there. See `motion.css`. */
@supports (view-transition-name: none) {
  .rv-nav__mark {
    view-transition-name: rv-nav-mark;
  }
}

.rv-nav__link {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  min-block-size: 2.25rem;
  border-radius: var(--rv-radius-md);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-5) var(--rv-space-3);
  color: var(--rv-color-text-muted);
  text-decoration: none;
  transition:
    background-color var(--rv-duration-instant) var(--rv-ease-standard),
    color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-nav__icon {
  color: var(--rv-color-text-faint);
  transition: color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-nav__label {
  flex: 1;
  min-inline-size: 0;
  font-size: var(--rv-text-sm);
}

.rv-nav__unbuilt {
  color: var(--rv-color-text-faint);
  opacity: 0.8;
}

.rv-nav__link:hover {
  background-color: var(--rv-color-surface-sunken);
  color: var(--rv-color-text);
}

.rv-nav__link:hover .rv-nav__icon {
  color: var(--rv-color-accent);
}

.rv-nav__link.router-link-active {
  background-color: var(--rv-color-accent-soft);
  color: var(--rv-color-accent);
  font-weight: var(--rv-weight-medium);
}

.rv-nav__link.router-link-active .rv-nav__icon,
.rv-nav__link.router-link-active .rv-nav__unbuilt {
  color: var(--rv-color-accent);
}

/*
 * Narrow: the rail lies down.
 *
 * A vertical peg bar does not fit beside content on a 390px screen, so the sections
 * become a scrolling chip row and the travelling mark is dropped — an indicator that
 * slides across a strip the user is also scrolling reads as a bug, not a cue. The
 * selected chip carries the state on its own, in fill weight and a solid ground.
 */
@media (max-width: 63.99rem) {
  .rv-nav {
    flex-direction: row;
    gap: var(--rv-space-2);
    padding: var(--rv-space-2) var(--rv-space-3);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .rv-nav__mark,
  .rv-nav__heading,
  .rv-nav__list::before,
  .rv-nav__item::before {
    display: none;
  }

  .rv-nav__list {
    flex-direction: row;
    gap: var(--rv-space-2);
  }

  .rv-nav__link {
    padding-inline: var(--rv-space-3);
    border: var(--rv-border-width) solid var(--rv-color-border);
    white-space: nowrap;
  }

  .rv-nav__link.router-link-active {
    border-color: var(--rv-color-accent);
  }
}
</style>
