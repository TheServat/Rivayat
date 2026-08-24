<script setup lang="ts">
import { PhCaretRight, PhPencilSimple, PhWarningCircle } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppSkeleton from '../../../components/AppSkeleton.vue';
import { formatNanoUsd, formatNumber } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';
import { childLevelOf, type StoryNode } from '../api/story-tree';
import { useStoryStore } from '../story.store';

/**
 * One level of the tree, and — through itself — every level below it.
 *
 * A nested `<ul>` of disclosure buttons rather than an ARIA `tree`. A real tree widget
 * owes the user roving tabindex, type-ahead and home/end, and a half-built one is worse
 * than none: `aria-expanded` on a plain `<button>` is a pattern every screen reader has
 * supported for a decade and every keyboard user already knows. Tab reaches every row,
 * Enter opens it, and the disclosure is a separate control from the row itself so
 * "look inside" and "open this node" are never the same keystroke.
 *
 * Indentation is `padding-inline-start`, so the tree hangs off the correct edge in
 * Persian with no second stylesheet. The caret points along the reading direction when
 * closed and straight down when open — the one icon on this screen that encodes a
 * direction, and so the one that mirrors.
 */
const props = defineProps<{
  nodes: readonly StoryNode[];
  depth: number;
}>();

const { t } = useI18n();
const story = useStoryStore();
const localeStore = useLocaleStore();

interface Row {
  readonly node: StoryNode;
  readonly children: readonly StoryNode[];
  readonly open: boolean;
  /** True while the level below this node is being written and has not landed. */
  readonly awaiting: boolean;
  readonly hasChildLevel: boolean;
}

const rows = computed<readonly Row[]>(() =>
  props.nodes.map((node) => {
    const children = story.childrenOf(node.id);
    const below = childLevelOf(node.level);
    return {
      node,
      children,
      open: story.isOpen(node.id),
      awaiting: children.length === 0 && below !== undefined && story.levelInFlight === below,
      hasChildLevel: below !== undefined,
    };
  }),
);

const SKELETON_ROWS = [0, 1] as const;
</script>

<template>
  <ul class="rv-branch" :style="{ '--rv-depth': depth }">
    <li v-for="row in rows" :key="row.node.id" class="rv-branch__item">
      <div
        class="rv-branch__row"
        :data-status="row.node.status"
        :data-selected="story.selectedId === row.node.id"
      >
        <button
          v-if="row.children.length > 0 || row.awaiting"
          type="button"
          class="rv-branch__disclose"
          :aria-expanded="row.open"
          :aria-controls="`rv-branch-${row.node.id}`"
          :aria-label="t('story.tree.disclose', { title: row.node.title })"
          @click="story.toggle(row.node.id)"
        >
          <PhCaretRight
            class="rv-branch__caret"
            :class="{ 'is-open': row.open }"
            :size="14"
            weight="bold"
            aria-hidden="true"
          />
        </button>
        <span v-else class="rv-branch__stub" aria-hidden="true" />

        <button
          type="button"
          class="rv-branch__open"
          :aria-current="story.selectedId === row.node.id ? 'true' : undefined"
          @click="story.select(row.node.id)"
        >
          <span class="rv-branch__head">
            <span class="rv-branch__level">{{ t(`story.levels.${row.node.level}`) }}</span>
            <span class="rv-tabular rv-branch__ordinal">{{
              formatNumber(row.node.ordinal, localeStore.locale)
            }}</span>
            <span class="rv-branch__title">{{ row.node.title }}</span>

            <!--
              Status carries three channels, not one: a word, a glyph and a colour. A
              stale node is the whole point of the edit flow, and one man in twelve
              cannot read the colour it would otherwise be told in.
            -->
            <span v-if="row.node.status === 'stale'" class="rv-branch__flag" data-tone="warning">
              <PhWarningCircle :size="12" weight="fill" aria-hidden="true" />
              {{ t('story.status.stale') }}
            </span>
            <span
              v-else-if="row.node.provenance?.source === 'author'"
              class="rv-branch__flag"
              data-tone="accent"
            >
              <PhPencilSimple :size="12" weight="fill" aria-hidden="true" />
              {{ t('story.provenance.handwritten') }}
            </span>
          </span>

          <span class="rv-branch__summary">{{ row.node.summary }}</span>

          <span class="rv-branch__meta">
            <span v-if="row.node.provenance?.model" class="rv-mono rv-branch__model">{{
              row.node.provenance.model
            }}</span>
            <span class="rv-tabular rv-branch__cost" :data-zero="row.node.spentNanoUsd === 0">{{
              formatNanoUsd(row.node.spentNanoUsd, localeStore.locale)
            }}</span>
            <span v-if="row.children.length > 0" class="rv-branch__children">
              {{
                t(
                  'story.tree.childCount',
                  { count: formatNumber(row.children.length, localeStore.locale) },
                  row.children.length,
                )
              }}
            </span>
          </span>
        </button>
      </div>

      <div v-if="row.open" :id="`rv-branch-${row.node.id}`">
        <StoryTreeBranch v-if="row.children.length > 0" :nodes="row.children" :depth="depth + 1" />

        <!--
          The level below is still being written. Rows the shape of real rows, indented
          where the real ones will be, so nothing shifts when they land.
        -->
        <ul v-else-if="row.awaiting" class="rv-branch" :style="{ '--rv-depth': depth + 1 }">
          <li v-for="index in SKELETON_ROWS" :key="index" class="rv-branch__item">
            <div class="rv-branch__row rv-branch__row--ghost">
              <span class="rv-branch__stub" aria-hidden="true" />
              <div class="rv-branch__ghost">
                <AppSkeleton inline-size="min(18rem, 60%)" block-size="0.9rem" />
                <AppSkeleton inline-size="min(30rem, 92%)" block-size="0.75rem" />
              </div>
            </div>
          </li>
        </ul>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.rv-branch {
  display: flex;
  flex-direction: column;
}

.rv-branch__row {
  display: flex;
  align-items: start;
  gap: var(--rv-space-1);
  /* The one place depth becomes distance. Logical, so the tree hangs off the right
     edge in Persian and the left in English with no second rule. */
  padding-inline-start: calc(var(--rv-depth, 0) * var(--rv-space-4));
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
  /* Always drawn, usually invisible: a stale row colours this edge rather than gaining
     it, so nothing shifts when a node goes stale. Logical, so it is the leading edge in
     both directions and there is no mirrored rule anywhere in this file. */
  border-inline-start: 0.1875rem solid transparent;
}

.rv-branch__row[data-selected='true'] {
  background-color: var(--rv-color-accent-soft);
}

.rv-branch__row[data-status='stale'] {
  border-inline-start-color: var(--rv-color-warning);
}

.rv-branch__disclose,
.rv-branch__stub {
  flex: none;
  inline-size: 1.75rem;
  block-size: 1.75rem;
  margin-block-start: var(--rv-space-2);
}

.rv-branch__disclose {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--rv-border-width) solid transparent;
  border-radius: var(--rv-radius-sm);
  background-color: transparent;
  color: var(--rv-color-text-muted);
  cursor: pointer;
}

.rv-branch__disclose:hover {
  background-color: var(--rv-color-surface-sunken);
  color: var(--rv-color-text);
}

/* Closed: along the reading direction. Open: straight down, the same in both. */
.rv-branch__caret {
  transform: scaleX(var(--rv-flip));
  transition: transform var(--rv-duration-fast) var(--rv-ease-standard);
}

.rv-branch__caret.is-open {
  transform: rotate(90deg);
}

.rv-branch__open {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  flex: 1;
  min-inline-size: 0;
  text-align: start;
  border: var(--rv-border-width) solid transparent;
  border-radius: var(--rv-radius-sm);
  background-color: transparent;
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-2);
  cursor: pointer;
  color: inherit;
  transition: background-color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-branch__open:hover {
  background-color: var(--rv-color-surface-sunken);
}

.rv-branch__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--rv-space-2);
}

.rv-branch__level {
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-bold);
  color: var(--rv-color-text-faint);
}

.rv-branch__ordinal {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
}

.rv-branch__title {
  font-weight: var(--rv-weight-semibold);
  line-height: var(--rv-leading-snug);
}

.rv-branch__flag {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-1);
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-medium);
  border-radius: var(--rv-radius-pill);
  padding-block: 0.0625rem;
  padding-inline: var(--rv-space-2);
}

.rv-branch__flag[data-tone='warning'] {
  background-color: var(--rv-color-warning-soft);
  color: var(--rv-color-warning);
}

.rv-branch__flag[data-tone='accent'] {
  background-color: var(--rv-color-accent-soft);
  color: var(--rv-color-accent);
}

.rv-branch__summary {
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-muted);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.rv-branch__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-3);
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
}

.rv-branch__model {
  direction: ltr;
  unicode-bidi: isolate;
  font-size: var(--rv-text-2xs);
}

.rv-branch__cost[data-zero='false'] {
  color: var(--rv-color-text-muted);
  font-weight: var(--rv-weight-medium);
}

.rv-branch__row--ghost {
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-branch__ghost {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  flex: 1;
  padding-block: var(--rv-space-3);
  padding-inline: var(--rv-space-2);
}
</style>
