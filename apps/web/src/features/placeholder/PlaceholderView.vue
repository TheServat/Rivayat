<script setup lang="ts">
import { PhCircleDashed } from '@phosphor-icons/vue';
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../components/AppBadge.vue';
import EmptyState from '../../components/EmptyState.vue';
import AssetsMotif from '../../components/motifs/AssetsMotif.vue';
import CharactersMotif from '../../components/motifs/CharactersMotif.vue';
import RenderMotif from '../../components/motifs/RenderMotif.vue';
import StoryMotif from '../../components/motifs/StoryMotif.vue';
import StyleLabMotif from '../../components/motifs/StyleLabMotif.vue';
import TimelineMotif from '../../components/motifs/TimelineMotif.vue';
import { formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';

import type { PlaceholderTopic } from './topics';

const props = defineProps<{
  topic: PlaceholderTopic;
  /** The backlog stories that will build this screen. Shown, not hidden. */
  stories: readonly string[];
}>();

const { t } = useI18n();
const localeStore = useLocaleStore();

/**
 * An honest empty screen that is still worth opening.
 *
 * It renders no fake data and no disabled controls that suggest a working feature —
 * navigating here answers "is this missing or is it broken?" without asking anyone, and
 * a convincing mock would answer it wrongly.
 *
 * What it adds to that honesty is a *drawing of the thing that will be here*, made from
 * the product's own material rather than from a stock illustration set. Six of the
 * studio's eight screens are in this state today, so these are the screens its author
 * looks at most; a page reading "not built yet" over white space six times is a worse
 * description of the work than six diagrams of what the work is.
 */
const TITLE_KEYS = {
  styleLab: 'placeholder.styleLab.title',
  story: 'placeholder.story.title',
  characters: 'placeholder.characters.title',
  assets: 'placeholder.assets.title',
  timeline: 'placeholder.timeline.title',
  render: 'placeholder.render.title',
} as const satisfies Record<PlaceholderTopic, string>;

const BODY_KEYS = {
  styleLab: 'placeholder.styleLab.body',
  story: 'placeholder.story.body',
  characters: 'placeholder.characters.body',
  assets: 'placeholder.assets.body',
  timeline: 'placeholder.timeline.body',
  render: 'placeholder.render.body',
} as const satisfies Record<PlaceholderTopic, string>;

const MOTIFS = {
  styleLab: StyleLabMotif,
  story: StoryMotif,
  characters: CharactersMotif,
  assets: AssetsMotif,
  timeline: TimelineMotif,
  render: RenderMotif,
} as const satisfies Record<PlaceholderTopic, Component>;

/**
 * Where this screen sits in the pipeline.
 *
 * A numbered marker is usually decoration pretending to be structure. Here the sequence
 * is real — an idea becomes a style, then a story, then characters, then assets, then a
 * timeline, then a render, and none of those can happen before the one in front of it —
 * so saying "stage 4 of 7" tells the reader something the heading does not: how much of
 * the road runs behind this screen. Projects is stage one, which is why these start at
 * two.
 */
const PIPELINE_STAGE = {
  styleLab: 2,
  story: 3,
  characters: 4,
  assets: 5,
  timeline: 6,
  render: 7,
} as const satisfies Record<PlaceholderTopic, number>;

const PIPELINE_LENGTH = 7;

const title = computed(() => t(TITLE_KEYS[props.topic]));
const body = computed(() => t(BODY_KEYS[props.topic]));
const motif = computed<Component>(() => MOTIFS[props.topic]);
/**
 * Both numbers go through `formatNumber` before they are interpolated.
 *
 * vue-i18n substitutes whatever it is handed, and a raw JavaScript number arrives as
 * `2`, not `۲` — so a Persian sentence ends up with two Latin digits in the middle of
 * it. Every number this studio shows a reader is localised; a number in a message is
 * not an exception to that.
 */
const stage = computed(() =>
  t('placeholder.stage', {
    index: formatNumber(PIPELINE_STAGE[props.topic], localeStore.locale),
    total: formatNumber(PIPELINE_LENGTH, localeStore.locale),
  }),
);
const stories = computed(() => props.stories.join('، '));
</script>

<template>
  <div class="rv-placeholder">
    <!--
      No registration mark on this line.

      There is already one in the wordmark and one clamped to the rail beside this
      section, and the drawing below is bracketed by four more. A signature repeated
      five times on one screen is not a signature; it is a pattern. The stage label
      keeps the saffron and gives up the glyph.
    -->
    <p class="rv-eyebrow rv-placeholder__stage">{{ stage }}</p>

    <header class="rv-placeholder__header">
      <h1 class="rv-placeholder__title">{{ title }}</h1>
      <AppBadge tone="warning">
        <template #icon>
          <PhCircleDashed :size="13" weight="bold" aria-hidden="true" />
        </template>
        {{ t('placeholder.badge') }}
      </AppBadge>
    </header>

    <EmptyState>
      <template #art>
        <component :is="motif" />
      </template>

      <p class="rv-placeholder__lead">{{ t('placeholder.heading') }}</p>

      <h2 class="rv-eyebrow">{{ t('placeholder.willContain') }}</h2>
      <p class="rv-placeholder__scope">{{ body }}</p>

      <p class="rv-placeholder__stories rv-mono">{{ t('placeholder.dependsOn', { stories }) }}</p>
    </EmptyState>
  </div>
</template>

<style scoped>
.rv-placeholder {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.rv-placeholder__stage {
  color: var(--rv-color-mark-strong);
}

.rv-placeholder__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-3);
  margin-block-end: var(--rv-space-2);
}

.rv-placeholder__title {
  font-size: var(--rv-text-2xl);
}

.rv-placeholder__lead {
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-medium);
  line-height: var(--rv-leading-snug);
}

.rv-placeholder__scope {
  color: var(--rv-color-text-muted);
  max-inline-size: 42rem;
}

.rv-placeholder__stories {
  color: var(--rv-color-text-faint);
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-2);
  border-radius: var(--rv-radius-sm);
  background-color: var(--rv-color-surface-sunken);
}
</style>
