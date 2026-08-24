<script setup lang="ts">
import { PIPELINE_STAGE_CODES } from '@rv/contracts';
import { PhArrowCounterClockwise, PhPencilSimple, PhWarningCircle } from '@phosphor-icons/vue';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../../components/AppBadge.vue';
import AppButton from '../../../components/AppButton.vue';
import { formatInstant, formatNanoUsd, formatNumber } from '../../../i18n/format';
import { LOCALE_TAG } from '../../../i18n/index';
import { useLocaleStore } from '../../../stores/locale.store';
import { type ChildDisposition, type StoryNode } from '../api/story-tree';
import { useStoryStore } from '../story.store';

/**
 * The selected node: what it is, who wrote it, and the two ways to change it.
 *
 * The edit path is the whole reason this panel exists in the shape it does. RV-205 says
 * an edit must not silently invalidate its children, so the form carries a *live* count
 * of what is underneath and, when there is anything under it at all, the primary button
 * does not save — it opens the impact step. There the user picks between keeping the
 * children (they are marked stale, nothing is thrown away, it costs nothing) and
 * rebuilding them (the subtree is rewritten, the old one stays in the history), with
 * the estimate visible before either button is pressed.
 *
 * "Regenerate this node only" is the other change, and it is deliberately per-node.
 * There is no button anywhere on this screen that rewrites the whole tree.
 */

const { t } = useI18n();
const story = useStoryStore();
const localeStore = useLocaleStore();

type Mode = 'view' | 'edit' | 'impact' | 'regenerate';

const mode = ref<Mode>('view');
const draftTitle = ref('');
const draftSummary = ref('');
const disposition = ref<ChildDisposition>('keep');
const justSaved = ref(false);

const node = computed<StoryNode | null>(() => story.selected);

const impact = computed(() =>
  node.value === null
    ? { childCount: 0, levels: [], staleStages: [] }
    : story.impactOf(node.value.id),
);

/**
 * What rebuilding the subtree cost the last time it was built.
 *
 * Presented as exactly that and not as a quote: the studio has no price for work it has
 * not planned, and a made-up number in front of a spend decision is worse than an
 * honest one that says where it came from.
 */
const subtreeSpentNanoUsd = computed(() => {
  const current = node.value;
  if (current === null) return 0;
  const ids = new Set([current.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of story.nodes) {
      if (candidate.parentId !== null && ids.has(candidate.parentId) && !ids.has(candidate.id)) {
        ids.add(candidate.id);
        grew = true;
      }
    }
  }
  return story.nodes
    .filter((candidate) => candidate.id !== current.id && ids.has(candidate.id))
    .reduce((sum, candidate) => sum + candidate.spentNanoUsd, 0);
});

/**
 * The affected levels as one phrase.
 *
 * `Intl.ListFormat`, not `join(', ')`: the separator between list items is a
 * *localisable* string, and a Persian comma hard-coded in a component is a user-visible
 * string outside the catalogue by another route.
 */
const affectedLevels = computed(() =>
  new Intl.ListFormat(LOCALE_TAG[localeStore.locale], { style: 'short', type: 'unit' }).format(
    impact.value.levels.map((level) => t(`story.levels.${level}`)),
  ),
);

/** The earliest stage this edit invalidates. Everything after it goes with it. */
const firstStaleStage = computed(() => {
  const first = impact.value.staleStages.at(0);
  return first === undefined ? null : PIPELINE_STAGE_CODES[first];
});

const changed = computed(() => {
  const current = node.value;
  if (current === null) return false;
  return draftTitle.value !== current.title || draftSummary.value !== current.summary;
});

const valid = computed(
  () => draftTitle.value.trim().length > 0 && draftSummary.value.trim().length > 0,
);

// A different node is a different edit. Leaving the previous draft in the fields is how
// someone saves one node's text onto another.
watch(
  () => node.value?.id,
  () => {
    mode.value = 'view';
    justSaved.value = false;
  },
);

function startEdit(): void {
  const current = node.value;
  if (current === null) return;
  draftTitle.value = current.title;
  draftSummary.value = current.summary;
  disposition.value = 'keep';
  justSaved.value = false;
  mode.value = 'edit';
}

function cancel(): void {
  mode.value = 'view';
}

function review(): void {
  mode.value = 'impact';
}

async function commit(children: ChildDisposition): Promise<void> {
  const current = node.value;
  if (current === null) return;
  const ok = await story.saveEdit(current.id, {
    title: draftTitle.value.trim(),
    summary: draftSummary.value.trim(),
    children,
  });
  if (ok) {
    justSaved.value = true;
    mode.value = 'view';
  }
}

async function rebuild(): Promise<void> {
  const current = node.value;
  if (current === null) return;
  const ok = await story.regenerate(current.id);
  if (ok) mode.value = 'view';
}
</script>

<template>
  <aside class="rv-inspector rv-sheet" :aria-label="t('story.node.heading')">
    <p v-if="node === null" class="rv-inspector__idle">{{ t('story.tree.noSelection') }}</p>

    <template v-else>
      <header class="rv-inspector__head">
        <p class="rv-eyebrow">
          {{ t(`story.levels.${node.level}`) }}
          <span class="rv-tabular">{{ formatNumber(node.ordinal, localeStore.locale) }}</span>
        </p>
        <h2 class="rv-inspector__title">{{ node.title }}</h2>
      </header>

      <p v-if="justSaved" class="rv-inspector__saved" role="status">
        {{ t('story.node.saved') }}
      </p>

      <!-- ── who wrote it ─────────────────────────────────────────────────── -->
      <dl class="rv-inspector__facts">
        <div class="rv-inspector__fact">
          <dt>{{ t('story.provenance.role') }}</dt>
          <dd>
            <span v-if="node.roleId">{{ t(`story.bindings.roles.${node.roleId}`) }}</span>
            <span v-else>{{ t('story.provenance.handwritten') }}</span>
          </dd>
        </div>
        <div class="rv-inspector__fact">
          <dt>{{ t('story.provenance.model') }}</dt>
          <dd class="rv-mono rv-inspector__model">
            {{ node.provenance?.model ?? t('story.provenance.notGenerated') }}
          </dd>
        </div>
        <div class="rv-inspector__fact">
          <dt>{{ t('story.provenance.cost') }}</dt>
          <dd class="rv-tabular">{{ formatNanoUsd(node.spentNanoUsd, localeStore.locale) }}</dd>
        </div>
        <div v-if="node.provenance" class="rv-inspector__fact">
          <dt>{{ t('story.provenance.at') }}</dt>
          <dd class="rv-tabular">
            {{ formatInstant(node.provenance.createdAt, localeStore.locale) }}
          </dd>
        </div>
      </dl>

      <p v-if="node.status === 'stale'" class="rv-inspector__stale">
        <PhWarningCircle :size="16" weight="fill" aria-hidden="true" />
        {{ t('story.status.staleHint') }}
      </p>

      <!-- ── reading ─────────────────────────────────────────────────────── -->
      <template v-if="mode === 'view'">
        <section v-if="node.plannedSummary" class="rv-inspector__block">
          <h3 class="rv-eyebrow">{{ t('story.tree.plannedSummary') }}</h3>
          <p class="rv-inspector__planned">{{ node.plannedSummary }}</p>
        </section>

        <section class="rv-inspector__block">
          <h3 class="rv-eyebrow">{{ t('story.tree.summary') }}</h3>
          <p class="rv-inspector__body">{{ node.summary }}</p>
        </section>

        <div class="rv-inspector__actions">
          <AppButton variant="primary" size="sm" @click="startEdit">
            <PhPencilSimple :size="14" aria-hidden="true" />
            {{ t('story.node.edit') }}
          </AppButton>
          <AppButton size="sm" :disabled="story.saving" @click="mode = 'regenerate'">
            <PhArrowCounterClockwise :size="14" aria-hidden="true" />
            {{ t('story.node.regenerate') }}
          </AppButton>
        </div>
      </template>

      <!-- ── editing ─────────────────────────────────────────────────────── -->
      <form v-else-if="mode === 'edit'" class="rv-inspector__form" @submit.prevent>
        <label class="rv-inspector__field">
          <span class="rv-inspector__label">{{ t('story.node.titleLabel') }}</span>
          <input v-model="draftTitle" class="rv-inspector__input" type="text" required />
        </label>

        <label class="rv-inspector__field">
          <span class="rv-inspector__label">{{ t('story.node.summaryLabel') }}</span>
          <textarea v-model="draftSummary" class="rv-inspector__textarea" rows="7" required />
        </label>

        <!--
          The impact, stated while the edit is still being typed rather than after it is
          submitted. This is the sentence RV-205 asks for, and it is why the primary
          button below changes its own words: with children underneath, saving is not
          the next step — deciding what happens to them is.
        -->
        <p class="rv-inspector__impact-line">
          <template v-if="impact.childCount === 0">{{ t('story.impact.none') }}</template>
          <template v-else>
            {{
              t('story.impact.affects', {
                count: formatNumber(impact.childCount, localeStore.locale),
              })
            }}
          </template>
        </p>

        <div class="rv-inspector__actions">
          <AppButton
            v-if="impact.childCount > 0"
            variant="primary"
            size="sm"
            :disabled="!changed || !valid"
            @click="review"
          >
            {{ t('story.node.review') }}
          </AppButton>
          <AppButton
            v-else
            variant="primary"
            size="sm"
            :disabled="!changed || !valid || story.saving"
            @click="commit('keep')"
          >
            {{ story.saving ? t('story.node.saving') : t('story.node.save') }}
          </AppButton>
          <AppButton variant="ghost" size="sm" @click="cancel">
            {{ t('story.node.cancel') }}
          </AppButton>
          <span v-if="!changed" class="rv-inspector__note">{{ t('story.node.unchanged') }}</span>
        </div>
      </form>

      <!-- ── the impact step ─────────────────────────────────────────────── -->
      <section
        v-else-if="mode === 'impact'"
        class="rv-inspector__impact"
        :aria-label="t('story.impact.heading')"
      >
        <h3 class="rv-inspector__subhead">{{ t('story.impact.heading') }}</h3>

        <ul class="rv-inspector__impact-facts">
          <li>
            {{
              t('story.impact.affects', {
                count: formatNumber(impact.childCount, localeStore.locale),
              })
            }}
          </li>
          <li>{{ t('story.impact.levels', { levels: affectedLevels }) }}</li>
          <li v-if="firstStaleStage">
            {{ t('story.impact.stages', { from: firstStaleStage }) }}
          </li>
        </ul>

        <fieldset class="rv-inspector__choice">
          <legend class="rv-inspector__label">{{ t('story.impact.choose') }}</legend>

          <label class="rv-inspector__option">
            <input v-model="disposition" type="radio" value="keep" name="rv-children" />
            <span>
              <span class="rv-inspector__option-name">{{ t('story.impact.keep') }}</span>
              <span class="rv-inspector__option-help">{{ t('story.impact.keepHint') }}</span>
              <span class="rv-inspector__option-cost">{{ t('story.impact.costNone') }}</span>
            </span>
          </label>

          <label class="rv-inspector__option">
            <input v-model="disposition" type="radio" value="re-expand" name="rv-children" />
            <span>
              <span class="rv-inspector__option-name">{{ t('story.impact.reexpand') }}</span>
              <span class="rv-inspector__option-help">{{ t('story.impact.reexpandHint') }}</span>
              <span class="rv-inspector__option-cost rv-tabular">
                {{
                  t('story.impact.costDelta', {
                    amount: formatNanoUsd(subtreeSpentNanoUsd, localeStore.locale),
                  })
                }}
              </span>
            </span>
          </label>
        </fieldset>

        <div class="rv-inspector__actions">
          <AppButton
            variant="primary"
            size="sm"
            :disabled="story.saving"
            @click="commit(disposition)"
          >
            {{
              disposition === 'keep'
                ? t('story.impact.confirmKeep')
                : t('story.impact.confirmReexpand')
            }}
          </AppButton>
          <AppButton variant="ghost" size="sm" @click="mode = 'edit'">
            {{ t('story.impact.back') }}
          </AppButton>
        </div>
      </section>

      <!-- ── regenerate one subtree ──────────────────────────────────────── -->
      <section v-else class="rv-inspector__impact" :aria-label="t('story.node.regenerate')">
        <h3 class="rv-inspector__subhead">{{ t('story.node.regenerate') }}</h3>
        <p class="rv-inspector__option-help">{{ t('story.node.regenerateHint') }}</p>
        <p class="rv-inspector__option-cost rv-tabular">
          {{
            t('story.node.regenerateEstimate', {
              amount: formatNanoUsd(subtreeSpentNanoUsd, localeStore.locale),
            })
          }}
        </p>
        <div class="rv-inspector__actions">
          <AppButton variant="primary" size="sm" :disabled="story.saving" @click="rebuild">
            {{ t('story.node.regenerateConfirm') }}
          </AppButton>
          <AppButton variant="ghost" size="sm" @click="cancel">
            {{ t('story.node.cancel') }}
          </AppButton>
        </div>
      </section>

      <!-- ── history ─────────────────────────────────────────────────────── -->
      <details class="rv-inspector__history">
        <summary class="rv-inspector__summary-line">
          {{ t('story.node.history') }}
          <AppBadge v-if="node.history.length > 0" tone="neutral">
            {{ formatNumber(node.history.length, localeStore.locale) }}
          </AppBadge>
        </summary>
        <p v-if="node.history.length === 0" class="rv-inspector__note">
          {{ t('story.node.historyEmpty') }}
        </p>
        <ol v-else class="rv-inspector__versions">
          <li v-for="version in node.history" :key="version.ordinal">
            <p class="rv-inspector__version-head">
              <span>{{
                t('story.node.historyEntry', {
                  ordinal: formatNumber(version.ordinal, localeStore.locale),
                })
              }}</span>
              <span class="rv-tabular rv-inspector__note">{{
                formatInstant(version.at, localeStore.locale)
              }}</span>
            </p>
            <p class="rv-inspector__version-title">{{ version.title }}</p>
            <p class="rv-inspector__note">{{ version.summary }}</p>
          </li>
        </ol>
      </details>
    </template>
  </aside>
</template>

<style scoped>
.rv-inspector {
  position: sticky;
  inset-block-start: var(--rv-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
  padding: var(--rv-space-5);
  max-block-size: calc(100vh - var(--rv-space-8));
  overflow-y: auto;
}

.rv-inspector__idle {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
}

.rv-inspector__head {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-inspector__title {
  font-size: var(--rv-text-lg);
}

.rv-inspector__saved {
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-success-soft);
  color: var(--rv-color-success);
  font-size: var(--rv-text-sm);
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-3);
}

.rv-inspector__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: var(--rv-space-3);
  margin: 0;
  padding-block: var(--rv-space-3);
  border-block: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-inspector__fact {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  min-inline-size: 0;
}

.rv-inspector__fact dt {
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-semibold);
  color: var(--rv-color-text-faint);
}

.rv-inspector__fact dd {
  margin: 0;
  font-size: var(--rv-text-sm);
  overflow-wrap: anywhere;
}

.rv-inspector__model {
  direction: ltr;
  unicode-bidi: isolate;
  text-align: start;
}

.rv-inspector__stale {
  display: flex;
  align-items: start;
  gap: var(--rv-space-2);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-warning-soft);
  color: var(--rv-color-warning);
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
  padding: var(--rv-space-3);
}

.rv-inspector__block {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

.rv-inspector__planned {
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-muted);
  border-inline-start: 2px solid var(--rv-color-accent-line);
  padding-inline-start: var(--rv-space-3);
}

.rv-inspector__body {
  line-height: var(--rv-leading-normal);
}

.rv-inspector__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-inspector__form,
.rv-inspector__impact {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.rv-inspector__field {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-inspector__label {
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-semibold);
  color: var(--rv-color-text-muted);
}

.rv-inspector__input,
.rv-inspector__textarea {
  inline-size: 100%;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
  text-align: start;
}

.rv-inspector__textarea {
  resize: vertical;
  min-block-size: 8rem;
}

.rv-inspector__impact-line {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface-sunken);
  padding: var(--rv-space-3);
}

.rv-inspector__subhead {
  font-size: var(--rv-text-md);
}

.rv-inspector__impact-facts {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

.rv-inspector__choice {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  padding: var(--rv-space-3);
  margin: 0;
}

.rv-inspector__option {
  display: flex;
  align-items: start;
  gap: var(--rv-space-3);
  cursor: pointer;
}

.rv-inspector__option input {
  /* 24px on its own, so the radio clears SC 2.5.8 even where the label wraps away. */
  inline-size: 1.5rem;
  block-size: 1.5rem;
  margin-block-start: 0.1rem;
  accent-color: var(--rv-color-accent);
  flex: none;
}

.rv-inspector__option > span {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-inspector__option-name {
  font-weight: var(--rv-weight-semibold);
  font-size: var(--rv-text-sm);
}

.rv-inspector__option-help {
  font-size: var(--rv-text-xs);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-muted);
}

.rv-inspector__option-cost {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-mark-strong);
  font-weight: var(--rv-weight-medium);
}

.rv-inspector__note {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
  line-height: var(--rv-leading-snug);
}

.rv-inspector__history {
  border-block-start: var(--rv-border-width) solid var(--rv-color-border);
  padding-block-start: var(--rv-space-3);
}

.rv-inspector__summary-line {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  cursor: pointer;
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
  min-block-size: 1.5rem;
}

.rv-inspector__versions {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  margin-block-start: var(--rv-space-3);
}

.rv-inspector__version-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
}

.rv-inspector__version-title {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
}

@media (max-width: 72rem) {
  .rv-inspector {
    position: static;
    max-block-size: none;
  }
}
</style>
