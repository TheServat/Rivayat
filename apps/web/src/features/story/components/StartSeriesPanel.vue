<script setup lang="ts">
import { PhFilmSlate } from '@phosphor-icons/vue';
import type { ProjectId } from '@rv/contracts';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import AppButton from '../../../components/AppButton.vue';
import ErrorNotice from '../../../components/ErrorNotice.vue';
import { useLocaleStore } from '../../../stores/locale.store';
import { useStoryStore } from '../story.store';
import type { SeriesDraft } from '../story.store';

/**
 * The first step of the pipeline, which the studio previously could not take.
 *
 * A project began with no series. The Story screen said "no series yet" and offered
 * nothing that could make one, and every screen after this needs a series id - so a
 * project the studio had not been seeded with was a dead end from the moment it was
 * created. This is the missing control.
 *
 * A title and a premise, and no third field. `POST /projects/:id/series` takes exactly
 * these two, and asking for anything the server would discard teaches people that the
 * form is decorative.
 */
const props = defineProps<{ projectId: ProjectId }>();

const { t } = useI18n();
const story = useStoryStore();
const localeStore = useLocaleStore();

const title = ref('');
const premise = ref('');
/**
 * The rest of the S0 brief.
 *
 * Not optional and not hidden behind "advanced". Intake binds every later stage to these
 * answers - the outliner plans against the episode count, the screenwriter writes to the
 * tone words - so a default here is a decision made on someone's behalf that they will
 * meet again, unexplained, six screens later.
 *
 * The defaults that *are* here are shapes rather than content: 8 minutes and 1x6 is a
 * plausible short series, and a person who wants something else changes a number they
 * can see. `targetAudience` and `toneWords` have none, because "everyone" and "good" are
 * exactly the non-answers the brief's own description warns against.
 */
const targetAudience = ref('');
const toneWords = ref('');
const episodeMinutes = ref(8);
const seasons = ref(1);
const episodesPerSeason = ref(6);

const tones = computed(() =>
  toneWords.value
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word.length > 0),
);

function draftOf(): SeriesDraft {
  return {
    title: title.value.trim(),
    premise: premise.value.trim(),
    targetAudience: targetAudience.value.trim(),
    toneWords: tones.value,
    episodeMinutes: episodeMinutes.value,
    seasons: seasons.value,
    episodesPerSeason: episodesPerSeason.value,
  };
}

/**
 * Both fields, non-blank.
 *
 * Checked here so the button is honestly disabled rather than enabled-then-rejected.
 * `NonEmptyString` on the server is the authority; this only agrees with it early.
 */
const ready = computed(
  () =>
    title.value.trim().length > 0 &&
    premise.value.trim().length > 0 &&
    targetAudience.value.trim().length > 0 &&
    tones.value.length > 0 &&
    episodeMinutes.value > 0 &&
    seasons.value > 0 &&
    episodesPerSeason.value > 0,
);

async function start(): Promise<void> {
  if (!ready.value || story.starting) return;
  const ok = await story.startSeries(props.projectId, draftOf(), localeStore.locale);
  // Only cleared on success. A premise someone spent a minute writing should survive the
  // server being briefly unreachable.
  if (ok) {
    title.value = '';
    premise.value = '';
  }
}
</script>

<template>
  <section class="rv-start" :aria-label="t('story.start.heading')">
    <header class="rv-start__head">
      <PhFilmSlate :size="22" weight="duotone" aria-hidden="true" />
      <div>
        <h2 class="rv-start__title">{{ t('story.start.heading') }}</h2>
        <p class="rv-start__hint">{{ t('story.start.hint') }}</p>
      </div>
    </header>

    <ErrorNotice v-if="story.error" :error="story.error" />

    <label class="rv-start__field">
      <span class="rv-start__label">{{ t('story.start.titleLabel') }}</span>
      <input
        v-model="title"
        class="rv-start__input"
        type="text"
        :placeholder="t('story.start.titlePlaceholder')"
        :disabled="story.starting"
        @keydown.enter="start()"
      />
    </label>

    <label class="rv-start__field">
      <span class="rv-start__label">{{ t('story.start.premiseLabel') }}</span>
      <textarea
        v-model="premise"
        class="rv-start__input rv-start__input--area"
        rows="4"
        :placeholder="t('story.start.premisePlaceholder')"
        :disabled="story.starting"
      ></textarea>
      <span class="rv-start__hint">{{ t('story.start.premiseHint') }}</span>
    </label>

    <label class="rv-start__field">
      <span class="rv-start__label">{{ t('story.start.audienceLabel') }}</span>
      <input
        v-model="targetAudience"
        class="rv-start__input"
        type="text"
        :placeholder="t('story.start.audiencePlaceholder')"
        :disabled="story.starting"
      />
      <span class="rv-start__hint">{{ t('story.start.audienceHint') }}</span>
    </label>

    <label class="rv-start__field">
      <span class="rv-start__label">{{ t('story.start.toneLabel') }}</span>
      <input
        v-model="toneWords"
        class="rv-start__input"
        type="text"
        :placeholder="t('story.start.tonePlaceholder')"
        :disabled="story.starting"
      />
      <span class="rv-start__hint">{{ t('story.start.toneHint') }}</span>
    </label>

    <div class="rv-start__row">
      <label class="rv-start__field rv-start__field--narrow">
        <span class="rv-start__label">{{ t('story.start.minutesLabel') }}</span>
        <input
          v-model.number="episodeMinutes"
          class="rv-start__input"
          type="number"
          min="1"
          :disabled="story.starting"
        />
      </label>
      <label class="rv-start__field rv-start__field--narrow">
        <span class="rv-start__label">{{ t('story.start.seasonsLabel') }}</span>
        <input
          v-model.number="seasons"
          class="rv-start__input"
          type="number"
          min="1"
          :disabled="story.starting"
        />
      </label>
      <label class="rv-start__field rv-start__field--narrow">
        <span class="rv-start__label">{{ t('story.start.perSeasonLabel') }}</span>
        <input
          v-model.number="episodesPerSeason"
          class="rv-start__input"
          type="number"
          min="1"
          :disabled="story.starting"
        />
      </label>
    </div>

    <div class="rv-start__actions">
      <AppButton variant="primary" :disabled="!ready || story.starting" @click="start()">
        {{ story.starting ? t('story.start.starting') : t('story.start.action') }}
      </AppButton>
    </div>
  </section>
</template>

<style scoped>
.rv-start {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
  max-inline-size: 44rem;
}

.rv-start__head {
  display: flex;
  align-items: flex-start;
  gap: var(--rv-space-3);
  color: var(--rv-accent);
}

.rv-start__title {
  margin: 0;
  font-size: var(--rv-text-lg);
  color: var(--rv-ink);
}

.rv-start__hint {
  margin: 0;
  font-size: var(--rv-text-sm);
  color: var(--rv-ink-muted);
}

.rv-start__field {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-start__label {
  font-size: var(--rv-text-sm);
  font-weight: 600;
  color: var(--rv-ink);
}

.rv-start__input {
  inline-size: 100%;
  padding: var(--rv-space-2) var(--rv-space-3);
  font: inherit;
  color: var(--rv-ink);
  background: var(--rv-surface);
  border: 1px solid var(--rv-border);
  border-radius: var(--rv-radius-2);
}

.rv-start__input--area {
  resize: vertical;
  min-block-size: 6rem;
}

.rv-start__input:focus-visible {
  outline: 2px solid var(--rv-accent);
  outline-offset: 1px;
}

.rv-start__row {
  display: flex;
  gap: var(--rv-space-3);
  flex-wrap: wrap;
}

.rv-start__field--narrow {
  flex: 1 1 8rem;
}

.rv-start__actions {
  display: flex;
  gap: var(--rv-space-2);
}
</style>
