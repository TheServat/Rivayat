<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type {
  SettingDescriptorMeta,
  SettingGroup,
  SettingModelChoice,
} from '../../api/schemas/settings';
import { useSettingsStore } from '../../stores/settings.store';

import SettingRow from './SettingRow.vue';

const props = defineProps<{
  group: SettingGroup;
  descriptors: readonly SettingDescriptorMeta[];
  models: readonly SettingModelChoice[];
}>();

const { t } = useI18n();
const settings = useSettingsStore();

/** Literal keys so the catalogue can type-check them; see `api/error-messages.ts`. */
const GROUP_KEYS = {
  providers: 'settings.groups.providers',
  models: 'settings.groups.models',
  image: 'settings.groups.image',
  budget: 'settings.groups.budget',
  render: 'settings.groups.render',
  delivery: 'settings.groups.delivery',
  interface: 'settings.groups.interface',
  runtime: 'settings.groups.runtime',
} as const satisfies Record<SettingGroup, string>;

const heading = computed(() => t(GROUP_KEYS[props.group]));
const headingId = computed(() => `settings-panel-${props.group}`);
</script>

<template>
  <section class="rv-panel" :aria-labelledby="headingId">
    <h2 :id="headingId" class="rv-panel__heading">{{ heading }}</h2>
    <div class="rv-panel__rows">
      <SettingRow
        v-for="descriptor in descriptors"
        :key="descriptor.key"
        :descriptor="descriptor"
        :value="settings.valueOf(descriptor.key)"
        :draft="settings.draftOf(descriptor.key)"
        :models="models"
        :target="settings.target"
        :dirty="settings.isDirty(descriptor.key)"
        :clearable="settings.canClear(descriptor.key)"
        :readonly="!settings.isEditable(descriptor.key)"
        :problem="settings.validate(descriptor.key)"
        @change="settings.setValue(descriptor.key, $event)"
        @clear="settings.clearOverride(descriptor.key)"
        @revert="settings.revert(descriptor.key)"
      />
    </div>
  </section>
</template>

<style scoped>
.rv-panel {
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-lg);
  background-color: var(--rv-color-surface);
  padding-inline: var(--rv-space-5);
  padding-block: var(--rv-space-4) var(--rv-space-2);
  box-shadow: var(--rv-shadow-sm);
}

.rv-panel__heading {
  font-size: var(--rv-text-lg);
  padding-block-end: var(--rv-space-2);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-panel__rows {
  display: flex;
  flex-direction: column;
}
</style>
