<script setup lang="ts">
import type { Asset, AssetVersion, RegenerateIntent } from '@rv/contracts';
import { PhStackPlus, PhWarningCircle } from '@phosphor-icons/vue';
import { computed, onMounted, ref, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';

import AppButton from '../../components/AppButton.vue';
import { formatNanoUsd, formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';

/**
 * A second take, made deliberate.
 *
 * The second non-negotiable is either upheld here or quietly broken. Four things make
 * regeneration feel like a decision rather than a button:
 *
 *  1. **A reason from the enum, chosen explicitly.** `RegenerateIntent.reason` is a
 *     closed set in `@rv/contracts`, the radio group has no default, and the confirm
 *     button is disabled until one is picked. There is no path from a stray click to a
 *     provider call.
 *  2. **The cost first.** The estimate is on screen before the button is reachable, in
 *     the user's own numerals, and it is the same figure the plan panel shows.
 *  3. **The previous version, named.** Not "previous versions are kept" in the
 *     abstract - *version 2 is untouched and stays openable*, with its ordinal.
 *  4. **Cancel calls nothing.** The dialog is opened by one store action and closed by
 *     another, and neither touches the network; only `regenerate` does, and it cannot
 *     be called without an intent.
 *
 * `keepPrevious` is not a control. The contract types it as `z.literal(true)` precisely
 * so that an attempt to set it false is a visible diff in a review rather than a
 * checkbox somebody can clear, so this dialog states it and does not offer it.
 */
const props = defineProps<{
  asset: Asset;
  currentVersion: AssetVersion;
  estimateNanoUsd: number;
  sending: boolean;
  failed: boolean;
}>();

const emit = defineEmits<{ confirm: [intent: RegenerateIntent]; cancel: [] }>();

const { t } = useI18n();
const localeStore = useLocaleStore();

/**
 * The reasons, in the contract's own order.
 *
 * Written out rather than derived from the schema at runtime: each one needs a label
 * and a sentence explaining when it applies, and a list built by iterating the enum
 * would give five radio buttons with machine names on them.
 */
const REASONS = [
  'new-take',
  'style-changed',
  'quality-reject',
  'spec-changed',
  'manual-override',
] as const satisfies readonly RegenerateIntent['reason'][];

const REASON_LABELS: Readonly<Record<RegenerateIntent['reason'], string>> = {
  'new-take': 'assets.regenerate.reason.new-take',
  'style-changed': 'assets.regenerate.reason.style-changed',
  'quality-reject': 'assets.regenerate.reason.quality-reject',
  'spec-changed': 'assets.regenerate.reason.spec-changed',
  'manual-override': 'assets.regenerate.reason.manual-override',
};

const REASON_HINTS: Readonly<Record<RegenerateIntent['reason'], string>> = {
  'new-take': 'assets.regenerate.reasonHint.new-take',
  'style-changed': 'assets.regenerate.reasonHint.style-changed',
  'quality-reject': 'assets.regenerate.reasonHint.quality-reject',
  'spec-changed': 'assets.regenerate.reasonHint.spec-changed',
  'manual-override': 'assets.regenerate.reasonHint.manual-override',
};

/** No default. A pre-selected reason is a reason nobody chose. */
const reason = ref<RegenerateIntent['reason'] | null>(null);
const note = ref('');

const canConfirm = computed(() => reason.value !== null && !props.sending);

const dialog = useTemplateRef<HTMLElement>('dialogRoot');

onMounted(() => {
  // Focus lands inside the dialog rather than staying behind it, so the first Tab does
  // not walk the page underneath and the first Escape is heard here. Queried rather
  // than bound to a ref inside `v-for`: a per-item ref in a loop collects an array, and
  // "the first radio" is a DOM question, not a state one.
  dialog.value?.querySelector('input')?.focus();
});

function submit(): void {
  const chosen = reason.value;
  if (chosen === null) return;
  const trimmed = note.value.trim();
  // Spread-or-omit: `exactOptionalPropertyTypes` makes `{note: undefined}` a different
  // type from `{}`, and only one of them satisfies `RegenerateIntent`.
  emit('confirm', {
    reason: chosen,
    keepPrevious: true,
    basedOn: props.currentVersion.id,
    ...(trimmed === '' ? {} : { note: trimmed }),
  });
}
</script>

<template>
  <div class="rv-regen__scrim" @click.self="emit('cancel')">
    <div
      ref="dialogRoot"
      class="rv-regen"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rv-regen-title"
      aria-describedby="rv-regen-lead"
      @keydown.esc.stop="emit('cancel')"
    >
      <h2 id="rv-regen-title" class="rv-regen__title">
        {{ t('assets.regenerate.title') }}
      </h2>
      <p id="rv-regen-lead" class="rv-regen__lead">
        {{ t('assets.regenerate.lead', { label: asset.label }) }}
      </p>

      <!--
        The estimate is above the choice, not beside the button. An estimate somebody
        approved is a different experience from a bill they discovered, and the
        difference is whether it was legible before the decision.
      -->
      <p class="rv-regen__estimate rv-tabular">
        {{
          t('assets.regenerate.estimate', {
            amount: formatNanoUsd(estimateNanoUsd, localeStore.locale),
          })
        }}
      </p>

      <fieldset class="rv-regen__reasons">
        <legend class="rv-regen__legend">{{ t('assets.regenerate.reasonLabel') }}</legend>
        <label v-for="value in REASONS" :key="value" class="rv-regen__reason">
          <input
            v-model="reason"
            type="radio"
            name="rv-regen-reason"
            :value="value"
            :disabled="sending"
          />
          <span class="rv-regen__reason-body">
            <span class="rv-regen__reason-label">{{ t(REASON_LABELS[value]) }}</span>
            <span class="rv-regen__reason-hint">{{ t(REASON_HINTS[value]) }}</span>
          </span>
        </label>
      </fieldset>

      <label class="rv-regen__note">
        <span class="rv-regen__note-label">{{ t('assets.regenerate.note') }}</span>
        <textarea v-model="note" rows="2" :disabled="sending" class="rv-regen__textarea" />
        <span class="rv-regen__reason-hint">{{ t('assets.regenerate.noteHint') }}</span>
      </label>

      <!-- The evidence, before the fact: which version survives, by its ordinal. -->
      <p class="rv-regen__keeps">
        <PhStackPlus :size="16" weight="bold" aria-hidden="true" />
        {{
          t('assets.regenerate.keepsPrevious', {
            ordinal: formatNumber(currentVersion.ordinal, localeStore.locale),
          })
        }}
      </p>

      <p v-if="failed" class="rv-regen__failed" role="alert">
        <PhWarningCircle :size="16" weight="fill" aria-hidden="true" />
        {{ t('assets.regenerate.failed') }}
      </p>

      <div class="rv-regen__actions">
        <AppButton variant="ghost" :disabled="sending" @click="emit('cancel')">
          {{ t('assets.regenerate.cancel') }}
        </AppButton>
        <AppButton variant="primary" :disabled="!canConfirm" @click="submit">
          {{ sending ? t('assets.regenerate.sending') : t('assets.regenerate.confirm') }}
        </AppButton>
      </div>
      <p v-if="reason === null" class="rv-regen__required">
        {{ t('assets.regenerate.reasonRequired') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.rv-regen__scrim {
  position: fixed;
  inset: 0;
  z-index: var(--rv-z-overlay);
  display: grid;
  place-items: center;
  padding: var(--rv-space-4);
  background-color: color-mix(in oklch, var(--rv-color-canvas) 70%, transparent);
  animation: rv-fade-in var(--rv-fade-duration) var(--rv-ease-standard) backwards;
}

.rv-regen {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  inline-size: min(32rem, 100%);
  max-block-size: 90vh;
  overflow-y: auto;
  padding: var(--rv-space-5);
  background-color: var(--rv-color-surface-raised);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-lg);
  box-shadow: var(--rv-shadow-md);
  animation: rv-register-in var(--rv-duration-normal) var(--rv-ease-register) backwards;
}

.rv-regen__title {
  font-size: var(--rv-text-lg);
}

.rv-regen__lead {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
}

.rv-regen__estimate {
  padding: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-mark);
  background-color: var(--rv-color-mark-soft);
  border-radius: var(--rv-radius-md);
  color: var(--rv-color-mark-strong);
  font-weight: var(--rv-weight-semibold);
}

.rv-regen__reasons {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  margin: 0;
  padding: 0;
  border: none;
}

.rv-regen__legend {
  padding: 0;
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-semibold);
  margin-block-end: var(--rv-space-1);
}

.rv-regen__reason {
  display: flex;
  align-items: start;
  gap: var(--rv-space-2);
  padding: var(--rv-space-2);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  cursor: pointer;
  /* 24px minimum target by construction; the padding is the target, not the dot. */
  min-block-size: 2.5rem;
  transition: border-color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-regen__reason:hover {
  border-color: var(--rv-color-accent);
}

.rv-regen__reason:has(input:checked) {
  border-color: var(--rv-color-accent);
  background-color: var(--rv-color-accent-soft);
}

.rv-regen__reason input {
  margin-block-start: 0.3rem;
  inline-size: 1rem;
  block-size: 1rem;
  accent-color: var(--rv-color-accent);
}

.rv-regen__reason-body {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.rv-regen__reason-label {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
}

.rv-regen__reason-hint {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  line-height: var(--rv-leading-snug);
}

.rv-regen__note {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-regen__note-label {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
}

.rv-regen__textarea {
  inline-size: 100%;
  padding: var(--rv-space-2);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  resize: vertical;
}

.rv-regen__keeps {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  padding: var(--rv-space-3);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-success-soft);
  color: var(--rv-color-success);
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
}

.rv-regen__failed {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  color: var(--rv-color-danger);
  font-size: var(--rv-text-sm);
}

.rv-regen__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--rv-space-2);
}

.rv-regen__required {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
  text-align: end;
}
</style>
