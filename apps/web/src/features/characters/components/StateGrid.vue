<script setup lang="ts">
import {
  PhCircleDashed,
  PhImageSquare,
  PhSealWarning,
  PhSparkle,
  PhWarningCircle,
} from '@phosphor-icons/vue';
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../../components/AppBadge.vue';
import AppButton from '../../../components/AppButton.vue';
import AppSkeleton from '../../../components/AppSkeleton.vue';
import ErrorNotice from '../../../components/ErrorNotice.vue';
import { formatNanoUsd, formatNumber, formatPercent } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';
import type { CharacterStateCell } from '../api/graph';
import { useCharactersStore } from '../characters.store';

/**
 * Roughly thirty cells, each with a prompt behind it, without becoming a wall of text.
 *
 * The grid shows the *image slot* — a tile, its label, its status — and the prompt is
 * one click away and edits in place. That is the whole answer to this screen's second
 * trap: thirty prompts laid out as thirty paragraphs is a document nobody reads, and a
 * prompt hidden behind a modal is a prompt nobody edits.
 *
 * Status is never carried by colour alone. Every tile has a word for its state and a
 * glyph beside it, and a cell below the identity floor is flagged in all three channels
 * at once, because "this render is not quite the same person" is the finding this grid
 * exists to surface and it is worth nothing if it reads as decoration.
 *
 * **Report:** the tiles are placeholders. There is no route that serves an asset blob —
 * `GET /api/assets/blobs/:hash` or equivalent — so a `ready` cell can show its content
 * hash and its identity score but not its picture.
 */

const { t } = useI18n();
const characters = useCharactersStore();
const localeStore = useLocaleStore();

const draft = ref('');
const confirming = ref<string | null>(null);
const SKELETON_CELLS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

const states = computed(() => characters.states);

const wardrobes = computed(() => {
  const cells = states.value?.cells ?? [];
  const seen = new Map<string, string>();
  for (const cell of cells) {
    if (!seen.has(cell.wardrobeSlug)) {
      seen.set(cell.wardrobeSlug, cell.stateKind === 'wardrobe' ? cell.label : cell.wardrobeSlug);
    }
  }
  return [...seen].map(([slug, label]) => ({ slug, label }));
});

function cellsOf(kind: CharacterStateCell['stateKind']): readonly CharacterStateCell[] {
  return (states.value?.cells ?? []).filter(
    (cell) => cell.stateKind === kind && cell.wardrobeSlug === characters.wardrobeSlug,
  );
}

const groups = computed(() => [
  { kind: 'wardrobe' as const, title: t('characters.states.wardrobe'), cells: cellsOf('wardrobe') },
  {
    kind: 'expression' as const,
    title: t('characters.states.expressions'),
    cells: cellsOf('expression'),
  },
  { kind: 'pose' as const, title: t('characters.states.poses'), cells: cellsOf('pose') },
]);

const total = computed(() => groups.value.reduce((sum, group) => sum + group.cells.length, 0));

const openCell = computed(
  () =>
    (states.value?.cells ?? []).find((cell) => cell.variantKey === characters.openCellKey) ?? null,
);

/** A cell scored below the floor is flagged; a cell with no score yet is not. */
function belowFloor(cell: CharacterStateCell): boolean {
  const floor = states.value?.identityFloor ?? 0;
  return cell.identityMatch !== undefined && cell.identityMatch < floor;
}

const STATUS_TONE = {
  ready: 'success',
  missing: 'neutral',
  generating: 'info',
  stale: 'warning',
  rejected: 'danger',
} as const;

const STATUS_GLYPH = {
  ready: PhImageSquare,
  missing: PhCircleDashed,
  generating: PhSparkle,
  stale: PhWarningCircle,
  rejected: PhSealWarning,
} as const;

const editor = useTemplateRef<HTMLElement>('editor');

watch(openCell, (cell) => {
  draft.value = cell?.prompt ?? '';
  confirming.value = null;
  if (cell === null) return;
  // The grid is thirty cells tall. Opening the last one and leaving its prompt below
  // the fold is "one click away" in the letter and nowhere near it in practice.
  // `nearest`, so a cell already on screen does not jump. The smooth travel is asked
  // for explicitly, so it has to be withdrawn explicitly: `scroll-behavior` in the
  // stylesheet does not override a behaviour passed to `scrollIntoView`.
  const calm = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  void nextTick(() => {
    editor.value?.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' });
  });
});

function toggle(cell: CharacterStateCell): void {
  characters.openCell(cell.variantKey);
}

async function save(cell: CharacterStateCell): Promise<void> {
  await characters.saveCellPrompt(cell.variantKey, draft.value.trim());
}

/**
 * Ask for the cast, then watch for it.
 *
 * The seed is fixed rather than random because `Math.random` is banned in this codebase
 * for exactly the reason it would be wrong here: a run nobody can repeat is a run nobody
 * can debug. A person who wants a different cast changes the seed, which is a decision
 * they can see rather than one the machine made for them.
 */
const CAST_SEED = 7;

async function build(): Promise<void> {
  if (!(await characters.buildCast(CAST_SEED))) return;
  // The stage calls a model per character, so this is minutes rather than seconds.
  const timer = window.setInterval(() => {
    void characters.awaitCast().then((finished) => {
      if (finished) window.clearInterval(timer);
    });
  }, 4000);
}

async function generate(cell: CharacterStateCell): Promise<void> {
  const ok = await characters.generateCell(cell.variantKey);
  if (ok) confirming.value = null;
}
</script>

<template>
  <section class="rv-grid" :aria-label="t('characters.states.heading')">
    <header class="rv-grid__head">
      <div>
        <h2 class="rv-grid__title">{{ t('characters.states.heading') }}</h2>
        <p class="rv-grid__hint">{{ t('characters.states.hint') }}</p>
      </div>
      <p v-if="total > 0" class="rv-grid__count rv-tabular">
        {{
          t('characters.states.count', { count: formatNumber(total, localeStore.locale) }, total)
        }}
      </p>
    </header>

    <ErrorNotice
      v-if="characters.statesStatus === 'error' && characters.statesError"
      :error="characters.statesError"
      @retry="characters.selectedId && characters.select(characters.selectedId)"
    />

    <template v-else-if="characters.statesStatus === 'loading'">
      <p class="rv-visually-hidden" role="status">{{ t('characters.loading.sheet') }}</p>
      <ul class="rv-grid__cells" aria-hidden="true">
        <li v-for="index in SKELETON_CELLS" :key="index" class="rv-grid__ghost">
          <AppSkeleton inline-size="100%" block-size="7rem" shape="block" />
          <AppSkeleton inline-size="70%" block-size="0.75rem" />
        </li>
      </ul>
    </template>

    <div v-else-if="total === 0" class="rv-grid__empty">
      <p>{{ t('characters.states.empty') }}</p>
      <!-- An empty state is an invitation, not a report. This is the only control in the
           studio that can ask the pipeline for anything, and it belongs here because here
           is where a person finds out they need it. -->
      <p class="rv-grid__hint">{{ t('characters.states.buildHint') }}</p>
      <AppButton
        variant="primary"
        size="sm"
        :disabled="characters.castRunId !== null"
        @click="build"
      >
        {{
          characters.castRunId === null
            ? t('characters.states.build')
            : t('characters.states.building')
        }}
      </AppButton>
    </div>

    <template v-else>
      <!-- ── which outfit ────────────────────────────────────────────────── -->
      <div
        v-if="wardrobes.length > 1"
        class="rv-grid__wardrobes"
        role="radiogroup"
        :aria-label="t('characters.states.wardrobe')"
      >
        <label v-for="outfit in wardrobes" :key="outfit.slug" class="rv-grid__wardrobe">
          <input
            type="radio"
            name="rv-wardrobe"
            :value="outfit.slug"
            :checked="characters.wardrobeSlug === outfit.slug"
            @change="characters.chooseWardrobe(outfit.slug)"
          />
          <span>{{ outfit.label }}</span>
        </label>
      </div>

      <section v-for="group in groups" :key="group.kind" class="rv-grid__group">
        <h3 class="rv-eyebrow">{{ group.title }}</h3>
        <ul v-if="group.cells.length > 0" class="rv-grid__cells">
          <li v-for="cell in group.cells" :key="cell.variantKey">
            <button
              type="button"
              class="rv-grid__cell"
              :data-status="cell.status"
              :aria-expanded="characters.openCellKey === cell.variantKey"
              :aria-controls="`rv-prompt-${cell.variantKey}`"
              :aria-label="t('characters.states.open', { label: cell.label })"
              @click="toggle(cell)"
            >
              <!--
                The picture, or the absence of one, at the size the picture will be. No
                blob route exists yet, so a generated cell shows its content hash where
                its render will go rather than a stock placeholder pretending to be art.
              -->
              <span class="rv-grid__tile" :data-status="cell.status">
                <component
                  :is="STATUS_GLYPH[cell.status]"
                  :size="22"
                  weight="duotone"
                  aria-hidden="true"
                />
                <span v-if="cell.imageHash" class="rv-mono rv-grid__hash">{{
                  cell.imageHash
                }}</span>
              </span>

              <span class="rv-grid__label">{{ cell.label }}</span>

              <span class="rv-grid__chips">
                <AppBadge :tone="STATUS_TONE[cell.status]">
                  <template #icon>
                    <component
                      :is="STATUS_GLYPH[cell.status]"
                      :size="11"
                      weight="fill"
                      aria-hidden="true"
                    />
                  </template>
                  {{ t(`characters.states.status.${cell.status}`) }}
                </AppBadge>

                <AppBadge v-if="belowFloor(cell)" tone="danger">
                  <template #icon>
                    <PhSealWarning :size="11" weight="fill" aria-hidden="true" />
                  </template>
                  {{ t('characters.states.identityFloor') }}
                </AppBadge>
                <span
                  v-else-if="cell.identityMatch !== undefined"
                  class="rv-grid__score rv-tabular"
                >
                  {{ t('characters.states.identity') }}
                  {{ formatPercent(cell.identityMatch, localeStore.locale) }}
                </span>
              </span>
            </button>
          </li>
        </ul>
        <p v-else class="rv-grid__empty">{{ t('characters.states.empty') }}</p>
      </section>

      <!-- ── the prompt, one click away and edited in place ──────────────── -->
      <section
        v-if="openCell"
        :id="`rv-prompt-${openCell.variantKey}`"
        ref="editor"
        class="rv-grid__editor"
        :aria-label="t('characters.states.promptLabel')"
      >
        <header class="rv-grid__editor-head">
          <h3 class="rv-grid__editor-title">{{ openCell.label }}</h3>
          <AppButton variant="ghost" size="sm" @click="characters.openCell(null)">
            {{ t('characters.states.close') }}
          </AppButton>
        </header>

        <p class="rv-grid__keys rv-mono">
          {{ t('characters.states.semanticKey') }}: {{ openCell.semanticKey }} ·
          {{ t('characters.states.variantKey') }}: {{ openCell.variantKey }}
        </p>

        <label class="rv-grid__field">
          <span class="rv-grid__field-label">{{ t('characters.states.promptLabel') }}</span>
          <textarea v-model="draft" class="rv-grid__textarea" rows="8" />
          <span class="rv-grid__field-hint">{{ t('characters.states.promptHint') }}</span>
        </label>

        <p v-if="openCell.status === 'stale'" class="rv-grid__stale">
          <PhWarningCircle :size="15" weight="fill" aria-hidden="true" />
          {{ t('characters.states.staleHint') }}
        </p>

        <div class="rv-grid__actions">
          <AppButton
            variant="primary"
            size="sm"
            :disabled="draft.trim() === openCell.prompt || characters.cellBusy !== null"
            @click="save(openCell)"
          >
            {{
              characters.cellBusy === openCell.variantKey
                ? t('characters.states.saving')
                : t('characters.states.save')
            }}
          </AppButton>

          <!--
            Cost before commitment. The estimate is shown, and the button that spends
            money is the second one, not the first.
          -->
          <AppButton
            v-if="confirming !== openCell.variantKey"
            size="sm"
            @click="confirming = openCell.variantKey"
          >
            {{ t('characters.states.generate') }}
          </AppButton>
          <template v-else>
            <AppButton
              variant="primary"
              size="sm"
              :disabled="characters.cellBusy !== null"
              @click="generate(openCell)"
            >
              {{ t('characters.states.confirm') }}
            </AppButton>
            <AppButton variant="ghost" size="sm" @click="confirming = null">
              {{ t('characters.states.cancelGenerate') }}
            </AppButton>
          </template>
        </div>

        <div v-if="confirming === openCell.variantKey" class="rv-grid__estimate">
          <p class="rv-eyebrow">{{ t('characters.states.estimateHeading') }}</p>
          <p class="rv-tabular">
            {{
              openCell.estimateNanoUsd === 0
                ? t('characters.states.estimateFree')
                : t('characters.states.estimate', {
                    amount: formatNanoUsd(openCell.estimateNanoUsd, localeStore.locale),
                  })
            }}
          </p>
          <p v-if="states?.imageModel" class="rv-grid__field-hint rv-mono">
            {{ t('characters.states.estimateModel', { model: states.imageModel }) }}
          </p>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.rv-grid {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
}

.rv-grid__head {
  display: flex;
  flex-wrap: wrap;
  align-items: start;
  justify-content: space-between;
  gap: var(--rv-space-3);
}

.rv-grid__title {
  font-size: var(--rv-text-lg);
}

.rv-grid__hint {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  max-inline-size: 44rem;
}

.rv-grid__count {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
}

.rv-grid__wardrobes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-2);
}

.rv-grid__wardrobe {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-2);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-pill);
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-3);
  font-size: var(--rv-text-sm);
  min-block-size: 2rem;
  cursor: pointer;
}

.rv-grid__wardrobe input {
  accent-color: var(--rv-color-accent);
  inline-size: 1rem;
  block-size: 1rem;
}

.rv-grid__wardrobe:has(input:checked) {
  background-color: var(--rv-color-accent-soft);
  border-color: var(--rv-color-accent);
}

.rv-grid__group {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

.rv-grid__cells {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
  gap: var(--rv-space-3);
}

.rv-grid__cell {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  inline-size: 100%;
  text-align: start;
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  color: inherit;
  padding: var(--rv-space-2);
  cursor: pointer;
  transition: border-color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-grid__cell:hover,
.rv-grid__cell[aria-expanded='true'] {
  border-color: var(--rv-color-accent);
}

/* The image slot. Fixed aspect, so the grid does not reflow when a render lands. */
.rv-grid__tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--rv-space-1);
  aspect-ratio: 3 / 4;
  border-radius: var(--rv-radius-sm);
  background-color: var(--rv-color-surface-sunken);
  color: var(--rv-color-text-faint);
  overflow: hidden;
  padding: var(--rv-space-2);
}

.rv-grid__tile[data-status='missing'] {
  border: 1px dashed var(--rv-color-border-strong);
  background-color: transparent;
}

.rv-grid__tile[data-status='rejected'] {
  background-color: var(--rv-color-danger-soft);
  color: var(--rv-color-danger);
}

.rv-grid__tile[data-status='stale'] {
  background-color: var(--rv-color-warning-soft);
  color: var(--rv-color-warning);
}

.rv-grid__hash {
  font-size: var(--rv-text-2xs);
  direction: ltr;
  unicode-bidi: isolate;
  overflow-wrap: anywhere;
  text-align: center;
}

.rv-grid__label {
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-medium);
  line-height: var(--rv-leading-snug);
}

.rv-grid__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-1);
}

.rv-grid__score {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
}

.rv-grid__empty {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

.rv-grid__ghost {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

/* ── the editor ───────────────────────────────────────────────────────────── */

.rv-grid__editor {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-accent);
  border-radius: var(--rv-radius-lg);
  background-color: var(--rv-color-surface);
  padding: var(--rv-space-4);
  animation: rv-rise-in var(--rv-duration-normal) var(--rv-ease-decelerate) backwards;
}

.rv-grid__editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--rv-space-3);
}

.rv-grid__editor-title {
  font-size: var(--rv-text-md);
}

.rv-grid__keys {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
  overflow-wrap: anywhere;
}

.rv-grid__field {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-grid__field-label {
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-semibold);
  color: var(--rv-color-text-muted);
}

.rv-grid__field-hint {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
}

.rv-grid__textarea {
  inline-size: 100%;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
  text-align: start;
  resize: vertical;
  min-block-size: 9rem;
}

.rv-grid__stale {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-warning-soft);
  color: var(--rv-color-warning);
  font-size: var(--rv-text-sm);
  padding: var(--rv-space-2) var(--rv-space-3);
}

.rv-grid__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-2);
}

.rv-grid__estimate {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-mark-soft);
  color: var(--rv-color-mark-strong);
  padding: var(--rv-space-3);
  font-size: var(--rv-text-sm);
}
</style>
