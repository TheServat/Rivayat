<script setup lang="ts">
import { PhUsersThree, PhWarningCircle } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppButton from '../../../components/AppButton.vue';
import { useLocaleStore } from '../../../stores/locale.store';
import { useStoryStore } from '../story.store';

/**
 * Whether S0 has run, on the screen that can run it.
 *
 * The shortlist is invisible on every screen that uses it and, until now, on every
 * screen that could produce it. A series with a complete outline and an empty shortlist
 * is one the Characters screen can do nothing with - it refuses, correctly, naming a
 * stage the studio had no way to run - and there was nothing anywhere saying which of
 * the two states a given series was in.
 *
 * When the shortlist exists this is a line, not a panel: it is a precondition that has
 * been met, and a met precondition should take up the space of a met precondition.
 */
const { t } = useI18n();
const story = useStoryStore();
const localeStore = useLocaleStore();

const has = computed(() => story.castCandidates.length > 0);

/**
 * Re-runs S0 from the series' own title and premise.
 *
 * The rest of the brief is not asked for again. A series that exists was started from a
 * brief, or predates the form; either way the premise is the field intake actually reads,
 * and re-prompting for an audience to fix a missing shortlist would be a form standing
 * between someone and a retry.
 */
async function rerun(): Promise<void> {
  const series = story.series;
  if (series === null || story.starting) return;
  await story.runIntake(
    {
      title: series.title,
      premise: series.premise,
      targetAudience: t('story.intake.defaultAudience'),
      toneWords: [t('story.intake.defaultTone')],
      episodeMinutes: 8,
      seasons: 1,
      episodesPerSeason: 6,
    },
    localeStore.locale,
  );
}
</script>

<template>
  <p v-if="has" class="rv-intake rv-intake--done">
    <PhUsersThree :size="16" weight="fill" aria-hidden="true" />
    {{ t('story.intake.done', { count: story.castCandidates.length }) }}
  </p>

  <section v-else class="rv-intake rv-intake--missing" :aria-label="t('story.intake.heading')">
    <p class="rv-intake__line">
      <PhWarningCircle :size="18" weight="fill" aria-hidden="true" />
      <span>
        <strong>{{ t('story.intake.heading') }}</strong>
        {{ t('story.intake.body') }}
      </span>
    </p>
    <AppButton variant="primary" :disabled="story.starting" @click="rerun()">
      {{ story.starting ? t('story.intake.running') : t('story.intake.run') }}
    </AppButton>
  </section>
</template>

<style scoped>
.rv-intake {
  display: flex;
  align-items: center;
  gap: var(--rv-space-3);
  margin: 0;
  font-size: var(--rv-text-sm);
}

.rv-intake--done {
  color: var(--rv-ink-muted);
}

.rv-intake--missing {
  flex-wrap: wrap;
  padding: var(--rv-space-3);
  color: var(--rv-ink);
  background: var(--rv-surface-sunken);
  border: 1px solid var(--rv-border);
  border-radius: var(--rv-radius-2);
}

.rv-intake__line {
  display: flex;
  align-items: flex-start;
  gap: var(--rv-space-2);
  margin: 0;
  flex: 1 1 20rem;
}
</style>
