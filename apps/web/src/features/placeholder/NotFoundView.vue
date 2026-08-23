<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';

import EmptyState from '../../components/EmptyState.vue';
import LostMotif from '../../components/motifs/LostMotif.vue';

const { t } = useI18n();

/**
 * The one screen where the plates never come into register.
 *
 * Everywhere else in the studio the signature is a print that lands: three plates
 * converge and the mark resolves. Here they sit apart over the empty target they were
 * meant to hit, and nothing animates them home. It reads as "misprint" before the
 * heading is read, and withholding the interface's own flourish is a stronger way to
 * say "there is nothing at this address" than another apologetic paragraph.
 */
</script>

<template>
  <div class="rv-notfound">
    <EmptyState>
      <template #art>
        <LostMotif />
      </template>

      <h1 class="rv-notfound__title">{{ t('notFound.title') }}</h1>
      <p class="rv-notfound__body">{{ t('notFound.body') }}</p>
      <RouterLink class="rv-notfound__back" to="/projects">
        {{ t('notFound.backToProjects') }}
      </RouterLink>
    </EmptyState>
  </div>
</template>

<style scoped>
.rv-notfound__title {
  font-size: var(--rv-text-2xl);
}

.rv-notfound__body {
  color: var(--rv-color-text-muted);
}

.rv-notfound__back {
  font-weight: var(--rv-weight-medium);
}
</style>
