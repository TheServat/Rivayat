<script setup lang="ts">
import { PhMagnifyingGlass } from '@phosphor-icons/vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../../components/AppBadge.vue';
import AppSkeleton from '../../../components/AppSkeleton.vue';
import { useCharactersStore } from '../characters.store';

/**
 * The cast, as a list of people rather than a table of rows.
 *
 * Importance is a badge with a word in it and not a colour alone, because "lead" and
 * "background" decide how much budget an entity gets and that is not a distinction to
 * carry in hue. The search matches names, aliases and occupation — aliases in
 * particular, because a Persian series calls the same person three things and the one
 * the reader remembers is rarely the canonical one.
 */

const { t } = useI18n();
const characters = useCharactersStore();

const SKELETON_ROWS = [0, 1, 2, 3] as const;

const IMPORTANCE_TONE = {
  lead: 'accent',
  supporting: 'info',
  recurring: 'neutral',
  background: 'neutral',
  mentioned: 'neutral',
} as const;
</script>

<template>
  <nav class="rv-cast" :aria-label="t('characters.cast.heading')">
    <h2 class="rv-eyebrow">{{ t('characters.cast.heading') }}</h2>

    <label class="rv-cast__search">
      <span class="rv-visually-hidden">{{ t('characters.cast.search') }}</span>
      <PhMagnifyingGlass class="rv-cast__glass" :size="15" aria-hidden="true" />
      <input
        v-model="characters.query"
        class="rv-cast__input"
        type="search"
        :placeholder="t('characters.cast.searchHint')"
      />
    </label>

    <template v-if="characters.status === 'loading'">
      <p class="rv-visually-hidden" role="status">{{ t('characters.loading.cast') }}</p>
      <ul class="rv-cast__list" aria-hidden="true">
        <li v-for="row in SKELETON_ROWS" :key="row" class="rv-cast__ghost">
          <AppSkeleton inline-size="60%" block-size="1rem" />
          <AppSkeleton inline-size="90%" block-size="0.75rem" />
        </li>
      </ul>
    </template>

    <p v-else-if="characters.filteredCast.length === 0" class="rv-cast__empty">
      {{ t('characters.cast.noMatches') }}
    </p>

    <ul v-else class="rv-cast__list">
      <li v-for="(member, index) in characters.filteredCast" :key="member.id">
        <button
          type="button"
          class="rv-cast__item rv-enter-item"
          :style="{ '--rv-i': index }"
          :aria-current="characters.selectedId === member.id ? 'true' : undefined"
          :aria-label="t('characters.cast.open', { name: member.canonicalName })"
          @click="characters.select(member.id)"
        >
          <span class="rv-cast__head">
            <span class="rv-cast__name">{{ member.canonicalName }}</span>
            <AppBadge :tone="IMPORTANCE_TONE[member.importance]">
              {{ t(`characters.cast.importance.${member.importance}`) }}
            </AppBadge>
          </span>
          <span class="rv-cast__role">{{ member.payload.identity.occupation }}</span>
          <span v-if="member.aliases.length > 0" class="rv-cast__aliases">
            {{ t('characters.cast.aliases') }}: {{ member.aliases.join(' · ') }}
          </span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.rv-cast {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.rv-cast__search {
  position: relative;
  display: flex;
  align-items: center;
}

.rv-cast__glass {
  position: absolute;
  inset-inline-start: var(--rv-space-3);
  color: var(--rv-color-text-faint);
  pointer-events: none;
}

.rv-cast__input {
  inline-size: 100%;
  min-block-size: 2.25rem;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline-start: var(--rv-space-8);
  padding-inline-end: var(--rv-space-3);
  font-size: var(--rv-text-sm);
}

.rv-cast__list {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

.rv-cast__item {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  inline-size: 100%;
  text-align: start;
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  color: inherit;
  padding: var(--rv-space-3);
  cursor: pointer;
  transition:
    border-color var(--rv-duration-instant) var(--rv-ease-standard),
    background-color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-cast__item:hover {
  border-color: var(--rv-color-accent);
}

.rv-cast__item[aria-current='true'] {
  background-color: var(--rv-color-accent-soft);
  border-color: var(--rv-color-accent);
}

.rv-cast__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--rv-space-2);
}

.rv-cast__name {
  font-weight: var(--rv-weight-semibold);
}

.rv-cast__role {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-cast__aliases {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
}

.rv-cast__empty {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

.rv-cast__ghost {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  padding: var(--rv-space-3);
}
</style>
