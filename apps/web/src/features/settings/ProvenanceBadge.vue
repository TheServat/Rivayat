<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type { SettingOrigin, SettingScope } from '../../api/schemas/settings';
import AppBadge from '../../components/AppBadge.vue';

const props = defineProps<{
  /** The layer the effective value came from. `default` means no layer set it. */
  origin: SettingOrigin;
  /** The layer this view writes to, so "here" can be distinguished from "above". */
  target: SettingScope;
  /** Layers that held a value for this key and lost to a more specific one. */
  shadowed: readonly SettingScope[];
}>();

const { t } = useI18n();

/**
 * "Why is this model being used" - answered on the row.
 *
 * Architecture 7b says the question is otherwise unanswerable once four layers exist,
 * so the origin is never implied by styling alone: it is a word, translated, plus a
 * sentence saying whether the value was set here, inherited, or set here and beaten.
 * The tone only reinforces it.
 *
 * The third state is the one a two-way badge gets wrong. A layer can hold a value *and*
 * not be the winner, and "I changed it and nothing happened" is exactly what that looks
 * like from the outside. `shadowed` is checked first because it is the surprising
 * answer.
 */
type Provenance = 'shadowed' | 'here' | 'inherited';

const state = computed<Provenance>(() => {
  if (props.shadowed.includes(props.target)) return 'shadowed';
  return props.origin === props.target ? 'here' : 'inherited';
});

const tone = computed(() => {
  if (state.value === 'shadowed') return 'warning' as const;
  if (state.value === 'here') return 'accent' as const;
  return props.origin === 'default' ? ('neutral' as const) : ('info' as const);
});

/** Literal keys, so the catalogue can type-check them. See `api/error-messages.ts`. */
const LAYER_KEYS = {
  default: 'settings.provenance.default',
  machine: 'settings.provenance.machine',
  global: 'settings.provenance.global',
  project: 'settings.provenance.project',
  run: 'settings.provenance.run',
} as const satisfies Record<SettingOrigin, string>;

const layerName = computed(() => t(LAYER_KEYS[props.origin]));

const explanation = computed(() => {
  if (state.value === 'shadowed') {
    return t('settings.provenance.shadowed', { layer: layerName.value });
  }
  if (state.value === 'here') return t('settings.provenance.overridden');
  return t('settings.provenance.inherited', { layer: layerName.value });
});
</script>

<template>
  <AppBadge :tone="tone" :title="explanation">
    <span class="rv-visually-hidden">{{ t('settings.provenance.label') }}:</span>
    {{ layerName }}
  </AppBadge>
</template>
