<script setup lang="ts">
import { PhUsersThree } from '@phosphor-icons/vue';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

import AppButton from '../../../components/AppButton.vue';
import ErrorNotice from '../../../components/ErrorNotice.vue';
import { useCharactersStore } from '../characters.store';

/**
 * Asks S3 for the cast, on the screen where the cast is missing.
 *
 * The control existed already and was in the wrong place: it lived in the state grid's
 * empty state, which only appears once a character exists and has no states. A project
 * with *no* characters - which is every project until this runs - got a paragraph
 * pointing at the Story screen and no way to proceed. The Story screen produces the
 * shortlist; this is what turns a shortlist into characters.
 */
const { t } = useI18n();
const characters = useCharactersStore();

/**
 * The seed, stated rather than randomised.
 *
 * `Math.random` is banned in this codebase for exactly the reason it would be wrong
 * here: a run nobody can repeat is a run nobody can debug. Someone who wants a different
 * cast changes a number they can see, rather than pressing the button again and hoping.
 */
const seed = ref(7);

async function build(): Promise<void> {
  if (!(await characters.buildCast(seed.value))) return;
  // S3 calls a model per character, so this is minutes. Polling rather than waiting on
  // one long request: a run outlives the page that started it, and a person who reloads
  // should find it still going rather than apparently lost.
  const timer = window.setInterval(() => {
    void characters.awaitCast().then((finished) => {
      if (finished) window.clearInterval(timer);
    });
  }, 4000);
}
</script>

<template>
  <section class="rv-build" :aria-label="t('characters.build.heading')">
    <PhUsersThree :size="28" weight="duotone" aria-hidden="true" />
    <h2 class="rv-build__title">{{ t('characters.build.heading') }}</h2>
    <p class="rv-build__hint">{{ t('characters.build.hint') }}</p>

    <ErrorNotice
      v-if="characters.statesStatus === 'error' && characters.statesError"
      :error="characters.statesError"
    />

    <div class="rv-build__actions">
      <label class="rv-build__seed">
        <span class="rv-build__seed-label">{{ t('characters.build.seed') }}</span>
        <input
          v-model.number="seed"
          class="rv-build__seed-input rv-tabular"
          type="number"
          min="0"
          dir="ltr"
          :disabled="characters.castRunId !== null"
        />
      </label>
      <AppButton variant="primary" :disabled="characters.castRunId !== null" @click="build()">
        {{
          characters.castRunId === null
            ? t('characters.build.action')
            : t('characters.build.running')
        }}
      </AppButton>
    </div>
    <p class="rv-build__hint">{{ t('characters.build.seedHint') }}</p>
  </section>
</template>

<style scoped>
.rv-build {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--rv-space-3);
  padding: var(--rv-space-6) var(--rv-space-4);
  text-align: center;
  color: var(--rv-accent);
}

.rv-build__title {
  margin: 0;
  font-size: var(--rv-text-lg);
  color: var(--rv-ink);
}

.rv-build__hint {
  margin: 0;
  max-inline-size: 34rem;
  font-size: var(--rv-text-sm);
  color: var(--rv-ink-muted);
}

.rv-build__actions {
  display: flex;
  align-items: flex-end;
  gap: var(--rv-space-3);
}

.rv-build__seed {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  text-align: start;
}

.rv-build__seed-label {
  font-size: var(--rv-text-sm);
  color: var(--rv-ink);
}

.rv-build__seed-input {
  inline-size: 6rem;
  padding: var(--rv-space-2);
  font: inherit;
  color: var(--rv-ink);
  background: var(--rv-surface);
  border: 1px solid var(--rv-border);
  border-radius: var(--rv-radius-2);
}
</style>
