<script setup lang="ts">
import type { CharacterEntity } from '@rv/contracts';
import { PhPersonSimpleWalk, PhWaveform } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../../components/AppBadge.vue';
import { formatNumber } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';

/**
 * The sheet: psychology first, appearance last, because that is the order the model is
 * built in and the order that makes a character readable.
 *
 * Want / need / wound / lie / ghost are given the top of the page and a card each, with
 * the one line that says what each *is* underneath. They are the dramatic engine, and a
 * sheet that buries them in a definition list beside "height" is a form rather than a
 * character. Voice and motion signature get their own blocks for the same reason they
 * exist as data at all: the two things that break a generated cast are everyone sounding
 * the same and everyone moving the same.
 *
 * Nothing here is a form. It is a document, and the fields it does not have are shown as
 * "not recorded" rather than as an empty input — a sheet with no `ghost` is a character
 * nobody has finished, and hiding the gap hides the work.
 */
const props = defineProps<{ character: CharacterEntity }>();

const { t } = useI18n();
const localeStore = useLocaleStore();

const psych = computed(() => props.character.payload.psych);
const voice = computed(() => props.character.payload.voice);
const motion = computed(() => props.character.payload.motionSignature);
const visual = computed(() => props.character.payload.visual);
const identity = computed(() => props.character.payload.identity);

/** The five bipolar axes, in declaration order. */
const AXES = ['warmth', 'dominance', 'volatility', 'openness', 'conscientiousness'] as const;

const temperament = computed(() =>
  AXES.map((axis) => {
    const value = psych.value.temperament[axis];
    return {
      axis,
      value,
      // Logical insets, so the bar grows from the centre towards the reader's own
      // "high" end and mirrors with the document instead of against it.
      style:
        value >= 0
          ? { insetInlineStart: '50%', inlineSize: `${String(value * 50)}%` }
          : { insetInlineEnd: '50%', inlineSize: `${String(-value * 50)}%` },
    };
  }),
);

const ENGINE = ['want', 'need', 'wound', 'lie', 'ghost'] as const;

const engine = computed(() => ENGINE.map((field) => ({ field, value: psych.value[field] })));

function list(values: readonly string[]): string {
  return values.length === 0 ? t('characters.sheet.none') : values.join(' · ');
}
</script>

<template>
  <article class="rv-sheet-panel">
    <!-- ── the dramatic engine ─────────────────────────────────────────────── -->
    <section class="rv-sheet-panel__block">
      <h3 class="rv-sheet-panel__head">{{ t('characters.sheet.psychology') }}</h3>
      <ul class="rv-sheet-panel__engine">
        <li v-for="entry in engine" :key="entry.field" class="rv-sheet-panel__card">
          <p class="rv-eyebrow">{{ t(`characters.sheet.${entry.field}`) }}</p>
          <p class="rv-sheet-panel__value">{{ entry.value }}</p>
          <p class="rv-sheet-panel__hint">{{ t(`characters.sheet.${entry.field}Hint`) }}</p>
        </li>
      </ul>

      <dl class="rv-sheet-panel__facts">
        <div>
          <dt>{{ t('characters.sheet.virtues') }}</dt>
          <dd>{{ list(psych.virtues) }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.flaws') }}</dt>
          <dd>{{ list(psych.flaws) }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.fears') }}</dt>
          <dd>{{ list(psych.fears) }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.values') }}</dt>
          <dd>{{ list(psych.values) }}</dd>
        </div>
      </dl>
    </section>

    <!-- ── temperament ─────────────────────────────────────────────────────── -->
    <section class="rv-sheet-panel__block">
      <h3 class="rv-sheet-panel__head">{{ t('characters.sheet.temperament') }}</h3>
      <ul class="rv-sheet-panel__axes">
        <li v-for="entry in temperament" :key="entry.axis" class="rv-sheet-panel__axis">
          <p class="rv-sheet-panel__axis-name">
            {{ t(`characters.sheet.axis.${entry.axis}`) }}
            <span class="rv-tabular rv-sheet-panel__axis-value">{{
              formatNumber(entry.value, localeStore.locale, {
                signDisplay: 'always',
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              })
            }}</span>
          </p>
          <span class="rv-sheet-panel__track">
            <span class="rv-sheet-panel__centre" aria-hidden="true" />
            <span class="rv-sheet-panel__fill" :data-sign="entry.value >= 0" :style="entry.style" />
          </span>
          <p class="rv-sheet-panel__poles">
            <span>{{ t(`characters.sheet.axisLow.${entry.axis}`) }}</span>
            <span>{{ t(`characters.sheet.axisHigh.${entry.axis}`) }}</span>
          </p>
        </li>
      </ul>
    </section>

    <!-- ── voice ───────────────────────────────────────────────────────────── -->
    <section class="rv-sheet-panel__block">
      <h3 class="rv-sheet-panel__head">
        <PhWaveform :size="16" weight="fill" aria-hidden="true" />
        {{ t('characters.sheet.voice') }}
      </h3>
      <dl class="rv-sheet-panel__facts">
        <div>
          <dt>{{ t('characters.sheet.register') }}</dt>
          <dd>{{ voice.register }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.verbosity') }}</dt>
          <dd>{{ voice.verbosity }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.rhythm') }}</dt>
          <dd>{{ voice.sentenceRhythm }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.humour') }}</dt>
          <dd>{{ voice.humourMode }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.profanity') }}</dt>
          <dd>{{ voice.profanity }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.idiolect') }}</dt>
          <dd>{{ list(voice.idiolect) }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.verbalTics') }}</dt>
          <dd>{{ list(voice.verbalTics) }}</dd>
        </div>
      </dl>
      <p class="rv-sheet-panel__prose">
        <span class="rv-eyebrow">{{ t('characters.sheet.silence') }}</span>
        {{ voice.silenceHabits }}
      </p>
    </section>

    <!-- ── motion signature ────────────────────────────────────────────────── -->
    <section class="rv-sheet-panel__block">
      <h3 class="rv-sheet-panel__head">
        <PhPersonSimpleWalk :size="16" weight="fill" aria-hidden="true" />
        {{ t('characters.sheet.motion') }}
      </h3>
      <dl class="rv-sheet-panel__facts">
        <div>
          <dt>{{ t('characters.sheet.gait') }}</dt>
          <dd>{{ motion.gaitStyle }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.posture') }}</dt>
          <dd>{{ motion.posture }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.gesture') }}</dt>
          <dd class="rv-tabular">
            {{ formatNumber(motion.gestureFrequency, localeStore.locale) }}
          </dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.energy') }}</dt>
          <dd class="rv-tabular">{{ formatNumber(motion.energy, localeStore.locale) }}</dd>
        </div>
      </dl>
      <p class="rv-sheet-panel__prose">
        <span class="rv-eyebrow">{{ t('characters.sheet.idle') }}</span>
        {{ motion.idleBehaviour }}
      </p>
      <p class="rv-sheet-panel__prose">
        <span class="rv-eyebrow">{{ t('characters.sheet.tell') }}</span>
        {{ motion.tellOnLying }}
      </p>
    </section>

    <!-- ── arc, identity, appearance ───────────────────────────────────────── -->
    <section class="rv-sheet-panel__block">
      <h3 class="rv-sheet-panel__head">{{ t('characters.sheet.arc') }}</h3>
      <p class="rv-sheet-panel__prose">
        <span class="rv-eyebrow">{{ t('characters.sheet.arcStart') }}</span>
        {{ character.payload.arc.startState }}
      </p>
      <p class="rv-sheet-panel__prose">
        <span class="rv-eyebrow">{{ t('characters.sheet.arcEnd') }}</span>
        {{ character.payload.arc.endState }}
      </p>
    </section>

    <section class="rv-sheet-panel__block">
      <h3 class="rv-sheet-panel__head">{{ t('characters.sheet.identity') }}</h3>
      <dl class="rv-sheet-panel__facts">
        <div>
          <dt>{{ t('characters.sheet.age') }}</dt>
          <dd>{{ identity.age }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.gender') }}</dt>
          <dd>{{ identity.gender }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.species') }}</dt>
          <dd>{{ identity.species }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.occupation') }}</dt>
          <dd>{{ identity.occupation }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.origin') }}</dt>
          <dd>{{ identity.origin }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.knowledgeScope') }}</dt>
          <dd>
            <AppBadge
              :tone="character.payload.knowledgeScope === 'omniscient' ? 'warning' : 'neutral'"
            >
              {{
                character.payload.knowledgeScope === 'omniscient'
                  ? t('characters.sheet.omniscient')
                  : t('characters.sheet.limited')
              }}
            </AppBadge>
          </dd>
        </div>
      </dl>
      <p v-if="character.payload.knowledgeScope === 'omniscient'" class="rv-sheet-panel__warn">
        {{ t('characters.sheet.omniscientHint') }}
      </p>
    </section>

    <section class="rv-sheet-panel__block">
      <h3 class="rv-sheet-panel__head">{{ t('characters.sheet.visual') }}</h3>
      <p class="rv-sheet-panel__prose">
        <span class="rv-eyebrow">{{ t('characters.sheet.silhouette') }}</span>
        {{ visual.silhouetteNote }}
      </p>
      <dl class="rv-sheet-panel__facts">
        <div>
          <dt>{{ t('characters.sheet.build') }}</dt>
          <dd>{{ visual.build }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.height') }}</dt>
          <dd>{{ visual.height }}</dd>
        </div>
        <div>
          <dt>{{ t('characters.sheet.marks') }}</dt>
          <dd>{{ list(visual.distinguishingMarks) }}</dd>
        </div>
      </dl>
      <ul class="rv-sheet-panel__palette">
        <li v-for="colour in visual.palette" :key="colour.name" class="rv-sheet-panel__swatch">
          <span
            class="rv-sheet-panel__chip"
            :style="{ backgroundColor: colour.hex }"
            aria-hidden="true"
          />
          {{ colour.name }}
        </li>
      </ul>
    </section>
  </article>
</template>

<style scoped>
.rv-sheet-panel {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
}

.rv-sheet-panel__block {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.rv-sheet-panel__head {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-md);
}

.rv-sheet-panel__engine {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: var(--rv-space-3);
}

.rv-sheet-panel__card {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  border-inline-start: 3px solid var(--rv-color-accent);
  padding: var(--rv-space-3);
}

.rv-sheet-panel__value {
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
}

.rv-sheet-panel__hint {
  font-size: var(--rv-text-2xs);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-faint);
}

.rv-sheet-panel__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--rv-space-3);
  margin: 0;
}

.rv-sheet-panel__facts dt {
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-semibold);
  color: var(--rv-color-text-faint);
}

.rv-sheet-panel__facts dd {
  margin: 0;
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
}

.rv-sheet-panel__prose {
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-normal);
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-sheet-panel__warn {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-warning);
  background-color: var(--rv-color-warning-soft);
  border-radius: var(--rv-radius-md);
  padding: var(--rv-space-2) var(--rv-space-3);
}

/* ── temperament ──────────────────────────────────────────────────────────── */

.rv-sheet-panel__axes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: var(--rv-space-3);
}

.rv-sheet-panel__axis {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-sheet-panel__axis-name {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-semibold);
}

.rv-sheet-panel__axis-value {
  color: var(--rv-color-text-muted);
  font-weight: var(--rv-weight-regular);
}

/*
 * The boundary is the thing WCAG measures on a control, so the track carries a
 * `border-strong` outline - the one neutral verified at 3:1 against a sunken plane.
 * The coloured fill inside it is supplementary: every bar on this screen prints its
 * signed value beside itself, so the colour is a second reading of a number that is
 * already there in words.
 */
.rv-sheet-panel__track {
  position: relative;
  display: block;
  block-size: 0.5rem;
  border-radius: var(--rv-radius-pill);
  background-color: var(--rv-color-surface-sunken);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  overflow: hidden;
}

.rv-sheet-panel__centre {
  position: absolute;
  inset-block: 0;
  inset-inline-start: calc(50% - 1px);
  inline-size: 2px;
  background-color: var(--rv-color-border-strong);
}

.rv-sheet-panel__fill {
  position: absolute;
  inset-block: 0;
  background-color: var(--rv-color-accent);
}

.rv-sheet-panel__fill[data-sign='false'] {
  background-color: var(--rv-color-mark);
}

.rv-sheet-panel__poles {
  display: flex;
  justify-content: space-between;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
}

/* ── palette ──────────────────────────────────────────────────────────────── */

.rv-sheet-panel__palette {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-3);
}

.rv-sheet-panel__swatch {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

/*
 * The one place a literal colour is legitimate: this is *content*, not chrome — the
 * palette the author chose for the character, carried on the entity and rendered as
 * itself. It comes from the data, never from a stylesheet.
 */
.rv-sheet-panel__chip {
  inline-size: 1.25rem;
  block-size: 1.25rem;
  border-radius: var(--rv-radius-sm);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
}
</style>
