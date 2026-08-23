<script setup lang="ts">
import { PhArrowClockwise, PhWarningOctagon } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { errorMessageKey } from '../api/error-messages';
import type { ApiError } from '../api/errors';

import AppButton from './AppButton.vue';

const props = defineProps<{ error: ApiError }>();
defineEmits<{ retry: [] }>();

const { t } = useI18n();

const headline = computed(() => t(errorMessageKey(props.error)));

/**
 * For a schema failure, name the field. "The response did not match its contract" is
 * true and useless; "invalid field: values.3.origin" is what someone can act on.
 */
const detail = computed(() => {
  const first = props.error.issues[0];
  if (props.error.failure === 'schema' && first !== undefined) {
    return t('errors.schemaMismatchDetail', { path: first.path });
  }
  return props.error.message;
});
</script>

<template>
  <div class="rv-error" role="alert">
    <!--
      The octagon is redundant to a sighted reader who can see the red, and it is the
      only signal for a reader who cannot. `aria-hidden` because the alert already
      announces itself and the headline already says what happened.
    -->
    <PhWarningOctagon class="rv-error__glyph" :size="20" weight="fill" aria-hidden="true" />

    <div class="rv-error__body">
      <p class="rv-error__headline">{{ headline }}</p>
      <p v-if="detail" class="rv-error__detail">{{ detail }}</p>
      <p v-if="error.retryable" class="rv-error__detail">{{ t('errors.retryable') }}</p>

      <div class="rv-error__foot">
        <AppButton variant="danger" size="sm" @click="$emit('retry')">
          <PhArrowClockwise :size="14" aria-hidden="true" />
          {{ t('common.retry') }}
        </AppButton>
        <p class="rv-error__code rv-mono">{{ t('errors.code', { code: error.code }) }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rv-error {
  display: flex;
  align-items: start;
  gap: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-danger);
  border-radius: var(--rv-radius-lg);
  background-color: var(--rv-color-danger-soft);
  padding: var(--rv-space-4);
  animation: rv-rise-in var(--rv-duration-normal) var(--rv-ease-decelerate) backwards;
}

.rv-error__glyph {
  color: var(--rv-color-danger);
  margin-block-start: 0.15rem;
}

.rv-error__body {
  display: flex;
  flex-direction: column;
  align-items: start;
  gap: var(--rv-space-2);
  min-inline-size: 0;
}

.rv-error__headline {
  font-weight: var(--rv-weight-bold);
  color: var(--rv-color-danger);
  line-height: var(--rv-leading-snug);
}

.rv-error__detail {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

.rv-error__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-3);
  margin-block-start: var(--rv-space-1);
}

.rv-error__code {
  color: var(--rv-color-text-faint);
}
</style>
