<script setup lang="ts">
import { PIPELINE_STAGE_CODES } from '@rv/contracts';
import type { PipelineStage } from '@rv/contracts';
import { PhCurrencyDollarSimple, PhFloppyDisk, PhSparkle } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type { SettingDescriptorMeta, SettingModelChoice } from '../../../api/schemas/settings';
import AppBadge from '../../../components/AppBadge.vue';
import AppButton from '../../../components/AppButton.vue';
import AppSkeleton from '../../../components/AppSkeleton.vue';
import ErrorNotice from '../../../components/ErrorNotice.vue';
import { localised } from '../../../i18n/localised';
import { useLocaleStore } from '../../../stores/locale.store';
import { useSettingsStore } from '../../../stores/settings.store';
import ModelPickerControl from '../../settings/controls/ModelPickerControl.vue';
import type { StoryRoleId } from '../api/story-tree';

/**
 * Which model writes which part, on the screen where that question is asked.
 *
 * It is the same registry, the same descriptors and the same control as the Settings
 * screen — `model.stage.<stage>` for the four stages the story is written by — because
 * a second picker with its own idea of what a model is would be a second thing to keep
 * in step with the catalogue. What is added here is the half Settings cannot show: the
 * *roles*. The stage is what the router keys off; the role is what the reader
 * recognises, and "the screenwriter and the continuity editor share one binding" is a
 * fact about the pipeline worth seeing before you change it.
 *
 * The price beside each row is the rate at the *current* binding, read off the live
 * catalogue rather than the descriptor's frozen options — the router syncs prices at
 * runtime, and a stale figure on a spend decision is worse than none.
 */

const { t } = useI18n();
const settings = useSettingsStore();
const localeStore = useLocaleStore();

/**
 * The four stages the story is written by, and the roles staffed on each.
 *
 * Mirrors the named roles the story engine instantiates (docs/00b-prior-art.md §B: one
 * mega-prompt writing writer, director and producer at once is what this replaces).
 *
 * **Report:** the role-to-stage map lives in the engine and is copied here because
 * `apps/web` may not import an engine. It belongs in `@rv/contracts` beside
 * `PipelineStageKey`, where the CLI and the API could read it too.
 */
const STORY_STAGES = [
  { stage: 'intake', roles: ['producer'] },
  { stage: 'story', roles: ['screenwriter', 'continuity-editor'] },
  { stage: 'cast', roles: ['art-director'] },
  { stage: 'sequence', roles: ['director', 'actor'] },
] as const satisfies readonly { stage: PipelineStage; roles: readonly StoryRoleId[] }[];

// Fails to compile if a role is dropped from the list above, so the screen cannot
// quietly stop showing one of the six.
type StaffedRole = (typeof STORY_STAGES)[number]['roles'][number];
type UnstaffedRole = Exclude<StoryRoleId, StaffedRole>;
const _everyRoleIsStaffed: UnstaffedRole extends never ? true : never = true;
void _everyRoleIsStaffed;

interface BindingRow {
  readonly stage: PipelineStage;
  readonly code: string;
  readonly key: string;
  readonly roles: readonly StoryRoleId[];
  readonly current: string | null;
  readonly choice: SettingModelChoice | null;
  /** `null` only if the registry ever stops declaring this stage's slot. Said out loud. */
  readonly descriptor: SettingDescriptorMeta | null;
}

const rows = computed<readonly BindingRow[]>(() =>
  STORY_STAGES.map((entry) => {
    const key = `model.stage.${entry.stage}`;
    const draft = settings.draftOf(key);
    const current = typeof draft === 'string' ? draft : null;
    return {
      stage: entry.stage,
      code: PIPELINE_STAGE_CODES[entry.stage],
      key,
      roles: entry.roles,
      current,
      choice: settings.models.find((model) => model.ref === current) ?? null,
      descriptor: narrowed(settings.descriptors.find((meta) => meta.key === key)),
    };
  }),
);

/**
 * The same control, without its free-text escape hatch.
 *
 * The registry declares `allowCustom` because Ollama serves whatever the operator
 * pulled and the catalogue is only seed data - and Settings, whose job is to reach
 * every option, keeps that field. Here the job is narrower: swap the brain writing one
 * stage, mid-draft, from the models the router can actually price. Four free-text
 * inputs nobody uses on this screen push the story tree below the fold, and the tree is
 * what this screen is for.
 */
function narrowed(meta: SettingDescriptorMeta | undefined): SettingDescriptorMeta | null {
  if (meta === undefined) return null;
  if (meta.control.kind !== 'model-picker') return meta;
  return { ...meta, control: { ...meta.control, allowCustom: false } };
}

const dirty = computed(() => rows.value.filter((row) => settings.isDirty(row.key)).length);

const loading = computed(() => settings.status === 'loading' || settings.status === 'idle');

async function save(): Promise<void> {
  await settings.save();
}

function onChange(key: string, value: unknown): void {
  settings.setValue(key, value);
}

/**
 * The tier the router falls back to when a stage is left unpinned, in the reader's own
 * language.
 *
 * Read off the registry's declared options rather than printed raw. `preview` is a
 * schema value, not a word anyone chose to show a user, and rendering it verbatim
 * beside translated text is a user-visible string that never went through the
 * catalogue - it just arrived from a different one.
 */
const tier = computed(() => {
  const value = settings.draftOf('model.qualityTier');
  if (typeof value !== 'string') return null;
  const options = settings.descriptors.find((meta) => meta.key === 'model.qualityTier')?.options;
  const option = options?.find((entry) => entry.value === value);
  return option === undefined ? null : localised(option.label, localeStore.locale);
});
</script>

<template>
  <section class="rv-bindings rv-sheet" :aria-label="t('story.bindings.heading')">
    <header class="rv-bindings__head">
      <div>
        <h2 class="rv-bindings__title">{{ t('story.bindings.heading') }}</h2>
        <p class="rv-bindings__hint">{{ t('story.bindings.hint') }}</p>
      </div>
      <div class="rv-bindings__actions">
        <AppBadge v-if="dirty > 0" tone="warning">
          {{ t('story.bindings.unsaved', { count: dirty }, dirty) }}
        </AppBadge>
        <AppButton
          variant="primary"
          size="sm"
          :disabled="dirty === 0 || settings.saving"
          @click="save"
        >
          <PhFloppyDisk :size="14" aria-hidden="true" />
          {{ settings.saving ? t('story.bindings.saving') : t('story.bindings.save') }}
        </AppButton>
      </div>
    </header>

    <ErrorNotice
      v-if="settings.status === 'error' && settings.error"
      :error="settings.error"
      @retry="settings.load(localeStore.locale)"
    />

    <!--
      A skeleton with one row per stage, at the height of a real row. The registry has
      fifty-nine settings and this panel needs four of them, so the wait is short — but
      a panel that collapses to nothing and then pushes the tree down the page when it
      lands is worse than the wait it was hiding.
    -->
    <ul v-else-if="loading" class="rv-bindings__list" aria-hidden="true">
      <li v-for="row in 4" :key="row" class="rv-bindings__row">
        <AppSkeleton inline-size="9rem" block-size="1rem" />
        <AppSkeleton inline-size="100%" block-size="2.5rem" shape="block" />
        <AppSkeleton inline-size="7rem" block-size="0.875rem" />
      </li>
    </ul>

    <ul v-else class="rv-bindings__list">
      <li v-for="row in rows" :key="row.key" class="rv-bindings__row">
        <div class="rv-bindings__who">
          <p class="rv-bindings__stage">
            <span class="rv-mono rv-bindings__code">{{ row.code }}</span>
            {{ t(`story.bindings.stages.${row.stage}`) }}
          </p>
          <ul class="rv-bindings__roles">
            <li v-for="role in row.roles" :key="role" class="rv-bindings__role">
              <span class="rv-bindings__role-name">{{ t(`story.bindings.roles.${role}`) }}</span>
              <span class="rv-bindings__role-help">{{ t(`story.bindings.roleHelp.${role}`) }}</span>
            </li>
          </ul>
        </div>

        <div class="rv-bindings__control">
          <label class="rv-visually-hidden" :for="`story-binding-${row.stage}`">
            {{ t('story.bindings.model') }} — {{ t(`story.bindings.stages.${row.stage}`) }}
          </label>
          <ModelPickerControl
            v-if="row.descriptor !== null"
            :descriptor="row.descriptor"
            :value="settings.valueOf(row.key)"
            :draft="settings.draftOf(row.key)"
            :invalid="settings.validate(row.key) !== null"
            :readonly="!settings.isEditable(row.key)"
            :input-id="`story-binding-${row.stage}`"
            :described-by="`story-binding-${row.stage}-price`"
            :models="settings.models"
            @change="(value: unknown) => onChange(row.key, value)"
          />
          <p v-else class="rv-bindings__router">{{ t('story.bindings.loadFailed') }}</p>
        </div>

        <p :id="`story-binding-${row.stage}-price`" class="rv-bindings__price">
          <template v-if="row.choice">
            <AppBadge v-if="row.choice.free" tone="success">
              <template #icon>
                <PhSparkle :size="12" weight="fill" aria-hidden="true" />
              </template>
              {{ t('story.bindings.free') }}
            </AppBadge>
            <span v-else class="rv-bindings__rate rv-mono">
              <PhCurrencyDollarSimple :size="13" aria-hidden="true" />
              {{ row.choice.pricing }}
            </span>
          </template>
          <span v-else class="rv-bindings__router">
            {{ t('story.bindings.router') }}
            <template v-if="tier"> — {{ tier }}</template>
          </span>
        </p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.rv-bindings {
  padding: var(--rv-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
}

.rv-bindings__head {
  display: flex;
  flex-wrap: wrap;
  align-items: start;
  justify-content: space-between;
  gap: var(--rv-space-3);
}

.rv-bindings__title {
  font-size: var(--rv-text-lg);
}

.rv-bindings__hint {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
  max-inline-size: 46rem;
}

.rv-bindings__actions {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-bindings__list {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

/*
 * Three columns: who, the picker, the price. `minmax(0, …)` on the middle one so a long
 * model id shrinks the select instead of widening the row past the card.
 */
.rv-bindings__row {
  display: grid;
  grid-template-columns: minmax(11rem, 15rem) minmax(0, 1fr) minmax(8rem, 14rem);
  align-items: start;
  gap: var(--rv-space-4);
  padding-block: var(--rv-space-3);
  border-block-start: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-bindings__row:first-child {
  border-block-start: none;
}

.rv-bindings__stage {
  display: flex;
  align-items: baseline;
  gap: var(--rv-space-2);
  font-weight: var(--rv-weight-semibold);
}

.rv-bindings__code {
  color: var(--rv-color-text-faint);
}

.rv-bindings__roles {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  margin-block-start: var(--rv-space-2);
}

.rv-bindings__role {
  display: flex;
  flex-direction: column;
}

.rv-bindings__role-name {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-accent);
  font-weight: var(--rv-weight-medium);
}

.rv-bindings__role-help {
  font-size: var(--rv-text-xs);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-faint);
}

.rv-bindings__price {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-bindings__rate {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-1);
  direction: ltr;
  unicode-bidi: isolate;
}

.rv-bindings__router {
  color: var(--rv-color-text-faint);
}

@media (max-width: 56rem) {
  .rv-bindings__row {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--rv-space-2);
  }
}
</style>
