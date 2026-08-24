<script setup lang="ts">
import { PhCheck, PhCircleDashed, PhClockCounterClockwise, PhX } from '@phosphor-icons/vue';
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';

import { formatNanoUsd, formatNumber } from '../../i18n/format';
import type { AssetProduceReport, ProduceStep, ProduceStepOutcome } from '../../api/schemas/assets';
import { PRODUCE_STEPS } from '../../api/schemas/assets';
import { useLocaleStore } from '../../stores/locale.store';

/**
 * Where a take stopped, and why.
 *
 * A failed asset is not a missing asset: it reached step four of eight, and the
 * difference between "matting failed" and *"removed nothing: alpha coverage 0.9912 is
 * above 0.98"* is the difference between a dead end and something the user can act on.
 * So the diagnosis is rendered verbatim, in the engine's own words, monospaced, and it
 * is the one string on this screen that does not come from the catalogue - see the note
 * at the top of `i18n/messages/fa/assets.ts`.
 *
 * `not-reached` is drawn as its own state rather than as a paler failure. An asset that
 * stopped at `matte` did not fail at `rig`; painting both as problems sends the reader
 * to look at the rig.
 */
const props = defineProps<{ report: AssetProduceReport }>();

const { t } = useI18n();
const localeStore = useLocaleStore();

const ICONS: Readonly<Record<ProduceStepOutcome, Component>> = {
  ran: PhCheck,
  resumed: PhClockCounterClockwise,
  failed: PhX,
  'not-reached': PhCircleDashed,
};

const STEP_KEYS: Readonly<Record<ProduceStep, string>> = {
  generate: 'assets.produce.step.generate',
  matte: 'assets.produce.step.matte',
  split: 'assets.produce.step.split',
  score: 'assets.produce.step.score',
  rig: 'assets.produce.step.rig',
  clips: 'assets.produce.step.clips',
  bake: 'assets.produce.step.bake',
  register: 'assets.produce.step.register',
};

const OUTCOME_KEYS: Readonly<Record<ProduceStepOutcome, string>> = {
  ran: 'assets.produce.outcome.ran',
  resumed: 'assets.produce.outcome.resumed',
  failed: 'assets.produce.outcome.failed',
  'not-reached': 'assets.produce.outcome.not-reached',
};

const total = PRODUCE_STEPS.length;

const steps = computed(() =>
  props.report.steps.map((record, index) => ({
    ...record,
    position: index + 1,
    icon: ICONS[record.outcome],
    stepLabel: t(STEP_KEYS[record.step]),
    outcomeLabel: t(OUTCOME_KEYS[record.outcome]),
  })),
);

const failure = computed(() => props.report.steps.find((record) => record.outcome === 'failed'));
const failureIndex = computed(() =>
  props.report.steps.findIndex((record) => record.outcome === 'failed'),
);
</script>

<template>
  <section class="rv-trail">
    <header class="rv-trail__head">
      <h4 class="rv-trail__title">{{ t('assets.produce.heading') }}</h4>
      <p v-if="failure" class="rv-trail__verdict rv-trail__verdict--bad">
        {{
          t('assets.produce.stoppedAt', {
            step: t(STEP_KEYS[failure.step]),
          })
        }}
        <span class="rv-trail__of">
          {{
            t('assets.produce.stepOf', {
              index: formatNumber(failureIndex + 1, localeStore.locale),
              total: formatNumber(total, localeStore.locale),
            })
          }}
        </span>
      </p>
      <p v-else class="rv-trail__verdict">{{ t('assets.produce.complete') }}</p>
    </header>

    <!--
      An ordered list, because the order is the information. Flex with logical gaps, so
      the chain reads right-to-left in Persian without a mirrored copy of the markup.
    -->
    <ol class="rv-trail__steps">
      <li
        v-for="step in steps"
        :key="step.step"
        class="rv-trail__step"
        :data-outcome="step.outcome"
      >
        <span class="rv-trail__glyph" aria-hidden="true">
          <component :is="step.icon" :size="13" weight="bold" />
        </span>
        <span class="rv-trail__name">{{ step.stepLabel }}</span>
        <span class="rv-visually-hidden">{{ step.outcomeLabel }}</span>
      </li>
    </ol>

    <div v-if="failure?.detail" class="rv-trail__diagnosis">
      <p class="rv-eyebrow">{{ t('assets.produce.diagnosis') }}</p>
      <!-- Verbatim. Paraphrasing it would lose the number the reader has to act on. -->
      <p class="rv-trail__detail rv-mono" dir="ltr">{{ failure.detail }}</p>
    </div>

    <p class="rv-trail__spend rv-tabular">
      {{
        t('assets.produce.spent', {
          amount: formatNanoUsd(report.spentNanoUsd, localeStore.locale),
        })
      }}
    </p>
  </section>
</template>

<style scoped>
.rv-trail {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.rv-trail__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--rv-space-2);
}

.rv-trail__title {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-semibold);
}

.rv-trail__verdict {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

.rv-trail__verdict--bad {
  color: var(--rv-color-danger);
  font-weight: var(--rv-weight-medium);
}

.rv-trail__of {
  color: var(--rv-color-text-faint);
  font-weight: var(--rv-weight-regular);
}

.rv-trail__steps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-1);
}

.rv-trail__step {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-1);
  padding-block: 0.125rem;
  padding-inline: var(--rv-space-2);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-sm);
  font-size: var(--rv-text-2xs);
  background-color: var(--rv-color-surface-sunken);
  color: var(--rv-color-text-muted);
}

/*
 * Four states, four shapes as well as four colours. Roughly one man in twelve cannot
 * separate the failed tone from the ran one by hue, and the glyph is what carries it
 * for them: a tick, a clock, a cross, a dashed ring.
 */
.rv-trail__step[data-outcome='ran'] {
  border-color: color-mix(in oklch, var(--rv-color-success) 40%, transparent);
  background-color: var(--rv-color-success-soft);
  color: var(--rv-color-success);
}

.rv-trail__step[data-outcome='resumed'] {
  border-color: color-mix(in oklch, var(--rv-color-info) 40%, transparent);
  background-color: var(--rv-color-info-soft);
  color: var(--rv-color-info);
}

.rv-trail__step[data-outcome='failed'] {
  border-color: var(--rv-color-danger);
  background-color: var(--rv-color-danger-soft);
  color: var(--rv-color-danger);
  font-weight: var(--rv-weight-bold);
}

.rv-trail__step[data-outcome='not-reached'] {
  border-style: dashed;
  color: var(--rv-color-text-faint);
  background-color: transparent;
}

.rv-trail__glyph {
  display: inline-flex;
}

.rv-trail__diagnosis {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  padding: var(--rv-space-3);
  border-inline-start: 3px solid var(--rv-color-danger);
  background-color: var(--rv-color-danger-soft);
  border-radius: var(--rv-radius-sm);
}

.rv-trail__detail {
  color: var(--rv-color-text);
  line-height: var(--rv-leading-snug);
  overflow-wrap: anywhere;
}

.rv-trail__spend {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
}
</style>
