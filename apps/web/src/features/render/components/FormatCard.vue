<script setup lang="ts">
import { PhCheckCircle, PhWarningDiamond } from '@phosphor-icons/vue';
import type { FormatProfile, ShotReframe, Size } from '@rv/contracts';
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../../components/AppBadge.vue';
import { formatNumber, formatPercent } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';
import { durationChoice } from '../duration';
import { coveredFraction, reduceRatio, safeAreaFraction, safeAreaPx } from '../format-geometry';
import { STRATEGY_EXPLAIN_KEYS, STRATEGY_KEYS, zoneMessageKey } from '../labels';

import FormatFrame from './FormatFrame.vue';

/**
 * One delivery target: what it demands, what it hides, and what the reframer decided.
 *
 * The card is a control, not a tile with a control on it. The whole heading is the
 * checkbox's label, so the pointer target is the format's name rather than a 24px box
 * beside it, and a keyboard reaches it in one tab.
 *
 * The numbers are all derived from the profile the API served, which is
 * `FORMAT_PRESETS` from `@rv/contracts` - research 7's table, live-checked. Nothing on
 * this card is typed in.
 */
const props = withDefaults(
  defineProps<{
    profile: FormatProfile;
    selected: boolean;
    /** The solver's answer for the representative shot, when a plan exists. */
    plan?: ShotReframe | null;
    composition?: Size | null;
  }>(),
  { plan: null, composition: null },
);

defineEmits<{ toggle: [] }>();

const { t } = useI18n();
const localeStore = useLocaleStore();
const inputId = useId();

const locale = computed(() => localeStore.locale);

const safe = computed(() => safeAreaPx(props.profile));
const safeShare = computed(() => safeAreaFraction(props.profile));
const safeIsWholeFrame = computed(() => safeShare.value >= 1);

const chromeShare = computed(() =>
  coveredFraction(props.profile.exclusions.map((zone) => zone.rect)),
);

const zoneLabels = computed(() =>
  props.profile.exclusions.map((zone) => {
    const key = zoneMessageKey(zone.name);
    // Falls back to the contract's own name rather than throwing: a zone a platform
    // adds next year should show up untranslated, not take the screen down.
    return key === null ? zone.name : t(key);
  }),
);

const limit = computed(() => {
  const ms = props.profile.maxDurationMs;
  if (ms === null) return null;
  const choice = durationChoice(ms);
  const count = formatNumber(choice.count, locale.value);
  return choice.unit === 'minutes'
    ? t('render.duration.minutes', { count }, choice.count)
    : t('render.duration.seconds', { count }, choice.count);
});

const number = (value: number): string => formatNumber(value, locale.value);

/**
 * A resolution is written `1080`, never `1,080`.
 *
 * Grouping separators belong to quantities, and a pixel dimension is an identifier as
 * much as a number - nobody writes a screen as 1,920 by 1,080. Persian gets Persian
 * digits either way; only the separator is suppressed.
 */
const pixels = (value: number): string => formatNumber(value, locale.value, { useGrouping: false });
const percent = (value: number): string => formatPercent(value, locale.value);
</script>

<template>
  <li class="rv-format" :class="{ 'rv-format--on': selected }" :data-format="profile.id">
    <div class="rv-format__preview">
      <FormatFrame :profile="profile" :plan="plan" :composition="composition" />
    </div>

    <div class="rv-format__head">
      <input
        :id="inputId"
        class="rv-format__check"
        type="checkbox"
        :checked="selected"
        @change="$emit('toggle')"
      />
      <label class="rv-format__name" :for="inputId">
        <span>{{ profile.label }}</span>
        <span class="rv-format__spec rv-tabular">
          {{
            t('render.targets.size', {
              width: pixels(profile.size.width),
              height: pixels(profile.size.height),
            })
          }}
        </span>
      </label>
      <AppBadge tone="neutral">{{ reduceRatio(profile.size) }}</AppBadge>
    </div>

    <dl class="rv-format__facts">
      <div class="rv-format__fact">
        <dt>{{ t('render.safeArea.label') }}</dt>
        <dd v-if="safeIsWholeFrame" class="rv-format__quiet">{{ t('render.safeArea.whole') }}</dd>
        <dd v-else class="rv-tabular">
          {{
            t('render.safeArea.size', { width: pixels(safe.width), height: pixels(safe.height) })
          }}
          <span class="rv-format__quiet">
            {{ t('render.safeArea.share', { percent: percent(safeShare) }) }}
          </span>
        </dd>
      </div>

      <div class="rv-format__fact">
        <dt>{{ t('render.chrome.label') }}</dt>
        <dd v-if="zoneLabels.length === 0" class="rv-format__quiet">
          {{ t('render.chrome.none') }}
        </dd>
        <dd v-else>
          <span class="rv-format__chrome rv-tabular">
            {{ t('render.chrome.share', { percent: percent(chromeShare) }) }}
          </span>
          <!--
            Named, not just measured. "45 % is covered" tells a creator to move the
            subject; "the caption rail and the action rail" tells them *which way*.
          -->
          <ul class="rv-format__zones">
            <li v-for="label in zoneLabels" :key="label">{{ label }}</li>
          </ul>
        </dd>
      </div>

      <div class="rv-format__fact">
        <dt>{{ t('render.targets.encodeLabel') }}</dt>
        <dd class="rv-tabular">
          {{
            t('render.targets.encode', {
              codec: profile.codec,
              container: profile.container,
              fps: number(profile.fps),
            })
          }}
          <span class="rv-format__quiet">
            {{
              t('render.targets.bitrate', {
                min: number(profile.bitrateMbps.minMbps),
                max: number(profile.bitrateMbps.maxMbps),
              })
            }}
          </span>
          <!--
            What we encode and what the platform will take are different facts, kept
            apart in the contract for a reason: "Reels is H.264 only" has to survive as
            data so a future decision to ship HEVC everywhere fails validation here
            rather than failing an upload.
          -->
          <span v-if="profile.allowedCodecs.length > 1" class="rv-format__quiet">
            {{ t('render.targets.allowed', { codecs: profile.allowedCodecs.join(' · ') }) }}
          </span>
        </dd>
      </div>

      <div class="rv-format__fact">
        <dt>{{ t('render.targets.limitLabel') }}</dt>
        <dd :class="limit === null ? 'rv-format__quiet' : 'rv-tabular'">
          {{
            limit === null
              ? t('render.targets.noLimit')
              : t('render.targets.limit', { duration: limit })
          }}
        </dd>
      </div>
    </dl>

    <!--
      The reframer's verdict, in the reframer's own terms. `strategy` and
      `safeAreaViolation` come from the solver rather than being re-derived here: two
      implementations of one constraint is two answers, and the engine's is the one
      that will be rendered.
    -->
    <div v-if="plan !== null" class="rv-format__verdict">
      <AppBadge :tone="plan.safeAreaViolation ? 'danger' : 'success'">
        <template #icon>
          <PhWarningDiamond
            v-if="plan.safeAreaViolation"
            :size="13"
            weight="fill"
            aria-hidden="true"
          />
          <PhCheckCircle v-else :size="13" weight="fill" aria-hidden="true" />
        </template>
        {{ t(STRATEGY_KEYS[plan.strategy]) }}
      </AppBadge>
      <p class="rv-format__explain">
        {{
          plan.safeAreaViolation
            ? t('render.reframe.missed')
            : t(STRATEGY_EXPLAIN_KEYS[plan.strategy])
        }}
      </p>
    </div>
  </li>
</template>

<style scoped>
.rv-format {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  padding: var(--rv-space-4);
  background-color: var(--rv-color-surface);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-lg);
  box-shadow: var(--rv-shadow-cut);
  /* A person is doing the selecting, so the acknowledgement interpolates. */
  transition:
    border-color var(--rv-duration-fast) var(--rv-ease-standard),
    box-shadow var(--rv-duration-fast) var(--rv-ease-standard),
    opacity var(--rv-duration-fast) var(--rv-ease-standard);
}

/* Unselected is dimmed rather than hidden: the seven specs are worth reading whether
   or not a target is being delivered to, and hiding six of them would make the
   comparison this screen exists for impossible. */
.rv-format:not(.rv-format--on) {
  opacity: 0.62;
}

.rv-format--on {
  border-color: var(--rv-color-accent);
  box-shadow: var(--rv-shadow-md);
}

.rv-format:hover {
  opacity: 1;
}

.rv-format__preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-block-size: 11rem;
  padding-block: var(--rv-space-2);
}

.rv-format__head {
  display: flex;
  align-items: start;
  gap: var(--rv-space-2);
}

/* 24px square: WCAG 2.2 SC 2.5.8's floor, met by the control itself rather than by
   hoping the label is large enough. The label extends the target well past it. */
.rv-format__check {
  inline-size: 1.5rem;
  block-size: 1.5rem;
  margin: 0;
  accent-color: var(--rv-color-accent);
  flex: none;
  cursor: pointer;
}

.rv-format__name {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  flex: 1;
  min-inline-size: 0;
  font-weight: var(--rv-weight-semibold);
  line-height: var(--rv-leading-snug);
  cursor: pointer;
}

.rv-format__spec {
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-regular);
  color: var(--rv-color-text-muted);
}

/* Takes the slack from a stretched grid track, so the fact labels of two cards in a
   row still line up and the last line of each sits on the same baseline. */
.rv-format__facts {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  flex: 1;
  margin: 0;
  padding-block-start: var(--rv-space-2);
  border-block-start: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-format__fact {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.rv-format__fact dt {
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-semibold);
  color: var(--rv-color-text-faint);
}

.rv-format__fact dd {
  margin: 0;
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
}

.rv-format__quiet {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
}

/* Each qualifier on its own line. Run together, "8 to 12 Mbps" and "the platform
   accepts h264 - h265" read as one broken sentence, which is what the first browser
   screenshot showed and what no jsdom assertion on `.text()` could have. */
.rv-format__fact dd > span {
  display: block;
}

.rv-format__chrome {
  font-weight: var(--rv-weight-medium);
  color: var(--rv-color-warning);
}

.rv-format__zones {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-1) var(--rv-space-3);
  margin-block-start: 0.125rem;
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-format__zones li::before {
  content: '';
  display: inline-block;
  inline-size: 0.5rem;
  block-size: 0.5rem;
  margin-inline-end: var(--rv-space-1);
  border: var(--rv-border-width) solid var(--rv-color-text-faint);
  background-image: repeating-linear-gradient(
    45deg,
    transparent 0 2px,
    var(--rv-color-text-faint) 2px 3px
  );
}

.rv-format__verdict {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  align-items: start;
  padding-block-start: var(--rv-space-2);
  border-block-start: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-format__explain {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  line-height: var(--rv-leading-snug);
}
</style>
