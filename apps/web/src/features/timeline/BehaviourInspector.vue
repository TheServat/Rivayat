<script setup lang="ts">
import type { AnimationIR, Behaviour } from '@rv/contracts';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../components/AppBadge.vue';
import { formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';

import type { SetBehaviourParamOp } from './ir-ops';

/**
 * Procedural motion, parameterised.
 *
 * This is the other source of motion the IR already carries, and it is the reason the
 * track lanes have to say where their values come from: a forest of forty swaying trees
 * is forty `wind` behaviours with different seeds, not forty hand-animated tracks.
 *
 * Each numeric parameter is a range input, because the interesting question about
 * `gustiness` is "more or less", not "what number". Every change is one
 * `setBehaviourParam` op with a declared inverse, so the preview updates on the drag and
 * undo takes it back - RV-211's "reflected in the preview and saved as a
 * `setBehaviourParam` op", minus the saving, which has no endpoint yet.
 *
 * `seed` is displayed and not editable. It is what makes the motion reproducible, and
 * an input that quietly re-rolls a render's determinism does not belong on a slider.
 */
const props = defineProps<{ ir: AnimationIR; selectedId: string | null }>();

const emit = defineEmits<{ select: [id: string]; change: [op: SetBehaviourParamOp] }>();

const { t } = useI18n();
const localeStore = useLocaleStore();

/**
 * The editable numeric parameters of each behaviour kind, with their real ranges.
 *
 * Ranges copied from the Zod schemas in `contracts/src/anim/ir.ts` - `hz` is `.min(0)
 * .max(8)` on wind and `.max(2)` on breathe - so a slider cannot produce a document
 * that fails to parse. A generic "0 to 1 for everything" control would let a user set a
 * flap rate of 0.4 Hz and wonder why the bird stopped.
 */
const PARAMS: Readonly<
  Record<Behaviour['kind'], readonly { name: string; min: number; max: number; step: number }[]>
> = {
  wind: [
    { name: 'hz', min: 0, max: 8, step: 0.05 },
    { name: 'amplitude', min: 0, max: 1, step: 0.01 },
    { name: 'gustiness', min: 0, max: 1, step: 0.01 },
    { name: 'direction', min: -180, max: 180, step: 1 },
    { name: 'tipBias', min: 0, max: 1, step: 0.01 },
  ],
  breathe: [
    { name: 'hz', min: 0, max: 2, step: 0.01 },
    { name: 'amplitude', min: 0, max: 1, step: 0.01 },
  ],
  blink: [{ name: 'intervalMs', min: 500, max: 12_000, step: 100 }],
  sway: [
    { name: 'hz', min: 0, max: 8, step: 0.05 },
    { name: 'amplitudeDeg', min: 0, max: 90, step: 0.5 },
  ],
  'walk-cycle': [
    { name: 'stepsPerSecond', min: 0.1, max: 8, step: 0.1 },
    { name: 'bounce', min: 0, max: 1, step: 0.01 },
  ],
  flap: [
    { name: 'hz', min: 0.1, max: 20, step: 0.1 },
    { name: 'amplitudeDeg', min: 0, max: 180, step: 1 },
    { name: 'downstrokeBias', min: 0, max: 1, step: 0.01 },
  ],
  orbit: [{ name: 'periodMs', min: 200, max: 20_000, step: 100 }],
  parallax: [{ name: 'strength', min: 0, max: 1, step: 0.01 }],
  boil: [
    { name: 'amplitude', min: 0, max: 1, step: 0.01 },
    { name: 'hz', min: 0, max: 24, step: 0.5 },
  ],
  spring: [
    { name: 'stiffness', min: 0, max: 1, step: 0.01 },
    { name: 'damping', min: 0, max: 1, step: 0.01 },
  ],
  'look-at': [
    { name: 'maxAngleDeg', min: 0, max: 180, step: 1 },
    { name: 'responsiveness', min: 0, max: 1, step: 0.01 },
  ],
  'follow-path': [],
  'lip-sync': [{ name: 'intensity', min: 0, max: 1, step: 0.01 }],
};

const selected = computed(
  () => props.ir.behaviours.find((behaviour) => behaviour.id === props.selectedId) ?? null,
);

const params = computed(() => {
  const behaviour = selected.value;
  if (behaviour === null) return [];
  const record = behaviour as unknown as Record<string, unknown>;
  return PARAMS[behaviour.kind]
    .filter((param) => typeof record[param.name] === 'number')
    .map((param) => ({ ...param, value: Number(record[param.name]) }));
});

function nodeNameOf(behaviour: Behaviour): string {
  return props.ir.nodes.find((node) => node.id === behaviour.nodeId)?.name ?? behaviour.nodeId;
}

function change(param: string, raw: string | number): void {
  const behaviour = selected.value;
  if (behaviour === null) return;
  const value = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  emit('change', { kind: 'setBehaviourParam', behaviourId: behaviour.id, param, value });
}

function toggleEnabled(event: Event): void {
  const behaviour = selected.value;
  if (behaviour === null) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  emit('change', {
    kind: 'setBehaviourParam',
    behaviourId: behaviour.id,
    param: 'enabled',
    value: target.checked,
  });
}
</script>

<template>
  <section class="rv-behaviours" aria-labelledby="rv-behaviours-heading">
    <h2 id="rv-behaviours-heading" class="rv-behaviours__title">
      {{ t('timeline.behaviour.heading') }}
    </h2>

    <p v-if="ir.behaviours.length === 0" class="rv-behaviours__hint">
      {{ t('timeline.behaviour.none') }}
    </p>

    <template v-else>
      <ul class="rv-behaviours__list">
        <li v-for="behaviour in ir.behaviours" :key="behaviour.id">
          <button
            type="button"
            class="rv-behaviours__item"
            :data-selected="behaviour.id === selectedId"
            :aria-pressed="behaviour.id === selectedId"
            @click="emit('select', behaviour.id)"
          >
            <span class="rv-behaviours__kind">
              {{ t(`timeline.behaviourKind.${behaviour.kind}`) }}
            </span>
            <span class="rv-behaviours__on">
              {{ t('timeline.behaviour.onNode', { node: nodeNameOf(behaviour) }) }}
            </span>
            <AppBadge v-if="!behaviour.enabled" tone="neutral">{{ t('common.off') }}</AppBadge>
          </button>
        </li>
      </ul>

      <div v-if="selected" class="rv-behaviours__params">
        <label class="rv-behaviours__toggle">
          <input type="checkbox" :checked="selected.enabled" @change="toggleEnabled" />
          <span>{{ t('timeline.behaviour.enabled') }}</span>
        </label>

        <p class="rv-behaviours__seed rv-mono" dir="ltr">
          {{ t('timeline.behaviour.seed') }}: {{ selected.seed }}
        </p>

        <label v-for="param in params" :key="param.name" class="rv-behaviours__param">
          <span class="rv-behaviours__param-name">
            {{ t('timeline.behaviour.param', { name: param.name }) }}
          </span>
          <input
            type="range"
            class="rv-behaviours__range"
            :min="param.min"
            :max="param.max"
            :step="param.step"
            :value="param.value"
            :disabled="!selected.enabled"
            @input="change(param.name, ($event.target as HTMLInputElement).value)"
          />
          <!--
            The number is displayed in the reader's own numerals and never parsed back:
            the range input carries the canonical Latin-digit value, and this is a
            rendering of it.
          -->
          <output class="rv-behaviours__value rv-tabular">
            {{
              formatNumber(param.value, localeStore.locale, {
                maximumFractionDigits: 2,
              })
            }}
          </output>
        </label>
      </div>
    </template>
  </section>
</template>

<style scoped>
.rv-behaviours {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.rv-behaviours__title {
  font-size: var(--rv-text-lg);
}

.rv-behaviours__hint {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

.rv-behaviours__list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-2);
}

.rv-behaviours__item {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  min-block-size: 2.25rem;
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  cursor: pointer;
  font-size: var(--rv-text-sm);
  text-align: start;
}

.rv-behaviours__item[data-selected='true'] {
  border-color: var(--rv-color-accent);
  background-color: var(--rv-color-accent-soft);
  font-weight: var(--rv-weight-semibold);
}

.rv-behaviours__kind {
  color: var(--rv-color-text);
}

.rv-behaviours__on {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-xs);
}

.rv-behaviours__params {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  padding: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface-sunken);
}

.rv-behaviours__toggle {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  min-block-size: 1.5rem;
  font-size: var(--rv-text-sm);
  cursor: pointer;
}

.rv-behaviours__toggle input {
  inline-size: 1rem;
  block-size: 1rem;
  accent-color: var(--rv-color-accent);
}

.rv-behaviours__seed {
  color: var(--rv-color-text-faint);
}

.rv-behaviours__param {
  display: grid;
  grid-template-columns: minmax(6rem, 10rem) minmax(0, 1fr) 4rem;
  align-items: center;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-xs);
}

.rv-behaviours__param-name {
  color: var(--rv-color-text-muted);
}

.rv-behaviours__range {
  inline-size: 100%;
  min-block-size: 1.5rem;
  accent-color: var(--rv-color-accent);
}

.rv-behaviours__value {
  text-align: end;
  color: var(--rv-color-text);
}
</style>
