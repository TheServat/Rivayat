<script setup lang="ts">
import type { Asset, AssetVersion, AssetVersionId } from '@rv/contracts';
import { PhStackPlus, PhX } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../components/AppBadge.vue';
import AppButton from '../../components/AppButton.vue';
import type { AssetProduceReport } from '../../api/schemas/assets';
import { formatInstant, formatNanoUsd, formatNumber, formatPercent } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';

import ProduceTrail from './ProduceTrail.vue';
import { REPRESENTATION_KEYS, representationOf } from './representation';

/**
 * One asset, opened: its versions, parts, rig, clips, variants and provenance.
 *
 * The panel is dumb. Everything it shows is a projection of the `Asset` the API
 * returned plus the produce report for the selected version, and the only thing it
 * emits is intent - select a version, regenerate, close. That is deliberate: a panel
 * that fetched would have to know which of its five sections is still loading, and the
 * five states would multiply into thirty-two.
 *
 * The version list is the evidence for the second non-negotiable, so it is a list and
 * not a dropdown. A dropdown shows one version and implies the others were replaced; a
 * list shows four ordinals stacked with only one of them marked current, which is what
 * "appended, never overwritten" looks like.
 */
const props = defineProps<{
  asset: Asset;
  version: AssetVersion | null;
  report: AssetProduceReport | null;
}>();

defineEmits<{ close: []; selectVersion: [versionId: AssetVersionId]; regenerate: [] }>();

const { t } = useI18n();
const localeStore = useLocaleStore();

const STATUS_KEYS: Readonly<Record<AssetVersion['status'], string>> = {
  generating: 'assets.status.generating',
  matting: 'assets.status.matting',
  rigging: 'assets.status.rigging',
  ready: 'assets.status.ready',
  rejected: 'assets.status.rejected',
  failed: 'assets.status.failed',
};

const STATUS_TONES: Readonly<
  Record<AssetVersion['status'], 'neutral' | 'info' | 'success' | 'warning' | 'danger'>
> = {
  generating: 'info',
  matting: 'info',
  rigging: 'info',
  ready: 'success',
  rejected: 'warning',
  failed: 'danger',
};

/** Newest first: the current version is the one somebody came to look at. */
const versions = computed(() =>
  [...props.asset.versions].toSorted((a, b) => b.ordinal - a.ordinal),
);

const parts = computed(() =>
  [...(props.version?.parts ?? [])].toSorted((a, b) => a.zOrder - b.zOrder),
);

const scoreRows = computed(() => {
  const scores = props.version?.scores;
  if (scores === undefined) return [];
  const rows: { key: string; value: number }[] = [
    { key: 'assets.scores.styleMatch', value: scores.styleMatch },
    { key: 'assets.scores.alphaCleanliness', value: scores.alphaCleanliness },
    { key: 'assets.scores.silhouetteReadability', value: scores.silhouetteReadability },
    { key: 'assets.scores.partCompleteness', value: scores.partCompleteness },
    { key: 'assets.scores.overall', value: scores.overall },
  ];
  return scores.identityMatch === undefined
    ? rows
    : [...rows, { key: 'assets.scores.identityMatch', value: scores.identityMatch }];
});

/**
 * A coverage a human should look at.
 *
 * `Part.alphaCoverage` is documented as a quality signal: a wing covering 2 % of its box
 * is almost certainly a matting failure. The threshold is a hint here, not a gate - the
 * gate is in the engine - so it is marked rather than hidden.
 */
const LOW_COVERAGE = 0.05;

const representation = computed(() => representationOf(props.version ?? undefined));

function boneParentName(parentId: string | null): string | null {
  if (parentId === null) return null;
  return props.version?.rig?.bones.find((bone) => bone.id === parentId)?.name ?? parentId;
}
</script>

<template>
  <aside class="rv-detail rv-sheet" aria-labelledby="rv-detail-heading">
    <header class="rv-detail__head">
      <div class="rv-detail__identity">
        <p class="rv-eyebrow">{{ t('assets.detail.heading') }}</p>
        <h2 id="rv-detail-heading" class="rv-detail__title">{{ asset.label }}</h2>
        <p class="rv-detail__key rv-mono" dir="ltr">{{ asset.semanticKey }}</p>
        <p class="rv-detail__description">{{ asset.description }}</p>
      </div>
      <AppButton
        size="sm"
        variant="ghost"
        :aria-label="t('assets.detail.close')"
        @click="$emit('close')"
      >
        <PhX :size="16" aria-hidden="true" />
      </AppButton>
    </header>

    <section class="rv-detail__section" aria-labelledby="rv-detail-repr">
      <h3 id="rv-detail-repr" class="rv-detail__section-title">
        {{ t('assets.representation.heading') }}
      </h3>
      <p class="rv-detail__badges">
        <AppBadge tone="accent">{{ t(REPRESENTATION_KEYS[representation.kind]) }}</AppBadge>
        <AppBadge tone="neutral">{{ t('assets.representation.derived') }}</AppBadge>
      </p>
      <p class="rv-detail__hint">{{ t('assets.representation.hint') }}</p>
    </section>

    <!-- The four components of the dedup key, as data rather than as one opaque hash. -->
    <section class="rv-detail__section" aria-labelledby="rv-detail-key">
      <h3 id="rv-detail-key" class="rv-detail__section-title">{{ t('assets.key.heading') }}</h3>
      <p class="rv-detail__hint">{{ t('assets.key.hint') }}</p>
      <dl class="rv-detail__pairs">
        <div>
          <dt>{{ t('assets.key.semanticKey') }}</dt>
          <dd class="rv-mono" dir="ltr">{{ asset.semanticKey }}</dd>
        </div>
        <div>
          <dt>{{ t('assets.key.styleChecksum') }}</dt>
          <dd class="rv-mono" dir="ltr">{{ version?.styleChecksum ?? '' }}</dd>
        </div>
        <div>
          <dt>{{ t('assets.detail.archetype') }}</dt>
          <dd class="rv-mono" dir="ltr">{{ asset.archetype }}</dd>
        </div>
      </dl>
    </section>

    <section class="rv-detail__section" aria-labelledby="rv-detail-versions">
      <h3 id="rv-detail-versions" class="rv-detail__section-title">
        {{ t('assets.versions.heading') }}
      </h3>
      <p class="rv-detail__hint">{{ t('assets.versions.hint') }}</p>
      <ol class="rv-detail__versions">
        <li v-for="entry in versions" :key="entry.id">
          <button
            type="button"
            class="rv-detail__version"
            :data-selected="entry.id === version?.id"
            :aria-current="entry.id === version?.id ? 'true' : undefined"
            @click="$emit('selectVersion', entry.id)"
          >
            <span class="rv-detail__version-line">
              <span class="rv-detail__version-name">
                {{
                  t('assets.versions.ordinal', {
                    ordinal: formatNumber(entry.ordinal, localeStore.locale),
                  })
                }}
              </span>
              <AppBadge :tone="STATUS_TONES[entry.status]">{{
                t(STATUS_KEYS[entry.status])
              }}</AppBadge>
              <AppBadge v-if="entry.id === asset.currentVersionId" tone="accent">
                {{ t('assets.versions.current') }}
              </AppBadge>
            </span>
            <span class="rv-detail__version-meta rv-tabular">
              {{ formatInstant(entry.provenance.createdAt, localeStore.locale) }}
              &middot;
              {{
                t('assets.versions.cost', {
                  amount: formatNanoUsd(entry.provenance.costNanoUsd, localeStore.locale),
                })
              }}
            </span>
          </button>
        </li>
      </ol>
      <AppButton variant="danger" size="sm" @click="$emit('regenerate')">
        <PhStackPlus :size="14" weight="bold" aria-hidden="true" />
        {{ t('assets.regenerate.open') }}
      </AppButton>
    </section>

    <section v-if="report" class="rv-detail__section">
      <ProduceTrail :report="report" />
    </section>

    <section class="rv-detail__section" aria-labelledby="rv-detail-parts">
      <h3 id="rv-detail-parts" class="rv-detail__section-title">{{ t('assets.parts.heading') }}</h3>
      <p class="rv-detail__hint">{{ t('assets.parts.hint') }}</p>
      <p v-if="parts.length === 0" class="rv-detail__hint">{{ t('assets.parts.none') }}</p>
      <table v-else class="rv-detail__table">
        <thead>
          <tr>
            <th scope="col">{{ t('assets.parts.zOrder') }}</th>
            <th scope="col">{{ t('assets.parts.name') }}</th>
            <th scope="col">{{ t('assets.parts.role') }}</th>
            <th scope="col">{{ t('assets.parts.coverage') }}</th>
            <th scope="col">{{ t('assets.parts.deformable') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="part in parts" :key="part.id">
            <td class="rv-tabular">{{ formatNumber(part.zOrder, localeStore.locale) }}</td>
            <th scope="row" class="rv-mono" dir="ltr">{{ part.name }}</th>
            <td class="rv-mono" dir="ltr">{{ part.role }}</td>
            <td class="rv-tabular">
              {{ formatPercent(part.alphaCoverage, localeStore.locale) }}
              <AppBadge v-if="part.alphaCoverage < LOW_COVERAGE" tone="warning">
                {{ t('assets.parts.lowCoverage') }}
              </AppBadge>
            </td>
            <td>{{ part.deformable ? t('common.yes') : t('common.no') }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="rv-detail__section" aria-labelledby="rv-detail-rig">
      <h3 id="rv-detail-rig" class="rv-detail__section-title">{{ t('assets.rig.heading') }}</h3>
      <p v-if="!version?.rig" class="rv-detail__hint">{{ t('assets.rig.none') }}</p>
      <template v-else>
        <p class="rv-detail__hint rv-mono" dir="ltr">
          {{ t('assets.rig.template') }}: {{ version.rig.templateId }}
        </p>
        <ul class="rv-detail__bones">
          <li v-for="bone in version.rig.bones" :key="bone.id" class="rv-detail__bone">
            <span class="rv-mono" dir="ltr">{{ bone.name }}</span>
            <span class="rv-detail__bone-meta">
              {{
                bone.parentId === null
                  ? t('assets.rig.root')
                  : t('assets.rig.childOf', { parent: boneParentName(bone.parentId) ?? '' })
              }}
              &middot;
              {{
                t('assets.rig.binds', {
                  count: formatNumber(bone.partIds.length, localeStore.locale),
                })
              }}
            </span>
          </li>
        </ul>
      </template>
    </section>

    <section class="rv-detail__section" aria-labelledby="rv-detail-clips">
      <h3 id="rv-detail-clips" class="rv-detail__section-title">{{ t('assets.clips.heading') }}</h3>
      <p class="rv-detail__hint">{{ t('assets.clips.hint') }}</p>
      <p v-if="(version?.clips.length ?? 0) === 0" class="rv-detail__hint">
        {{ t('assets.clips.none') }}
      </p>
      <ul v-else class="rv-detail__chips">
        <li v-for="clip in version?.clips ?? []" :key="clip.id" class="rv-detail__chip">
          <span class="rv-mono" dir="ltr">{{ clip.name }}</span>
          <span class="rv-detail__chip-meta rv-tabular">
            {{
              t('assets.clips.seconds', {
                value: formatNumber(clip.durationMs / 1000, localeStore.locale, {
                  maximumFractionDigits: 1,
                }),
              })
            }}
          </span>
          <AppBadge :tone="clip.bakedSheetId === undefined ? 'neutral' : 'success'">
            {{
              clip.bakedSheetId === undefined ? t('assets.clips.notBaked') : t('assets.clips.baked')
            }}
          </AppBadge>
        </li>
      </ul>
    </section>

    <section class="rv-detail__section" aria-labelledby="rv-detail-variants">
      <h3 id="rv-detail-variants" class="rv-detail__section-title">
        {{ t('assets.variants.heading') }}
      </h3>
      <p class="rv-detail__hint">{{ t('assets.variants.hint') }}</p>
      <p v-if="(version?.variants.length ?? 0) === 0" class="rv-detail__hint">
        {{ t('assets.variants.none') }}
      </p>
      <ul v-else class="rv-detail__chips">
        <li v-for="variant in version?.variants ?? []" :key="variant.id" class="rv-detail__chip">
          <span>{{ variant.label }}</span>
          <span class="rv-detail__chip-meta rv-mono" dir="ltr">
            {{
              t('assets.variants.replaces', {
                parts: Object.keys(variant.replacedParts).join(', '),
              })
            }}
          </span>
        </li>
      </ul>
    </section>

    <section
      v-if="scoreRows.length > 0"
      class="rv-detail__section"
      aria-labelledby="rv-detail-scores"
    >
      <h3 id="rv-detail-scores" class="rv-detail__section-title">
        {{ t('assets.scores.heading') }}
      </h3>
      <dl class="rv-detail__pairs">
        <div v-for="row in scoreRows" :key="row.key">
          <dt>{{ t(row.key) }}</dt>
          <dd class="rv-tabular">{{ formatPercent(row.value, localeStore.locale) }}</dd>
        </div>
      </dl>
    </section>

    <section v-if="version" class="rv-detail__section" aria-labelledby="rv-detail-prov">
      <h3 id="rv-detail-prov" class="rv-detail__section-title">
        {{ t('assets.detail.provenance') }}
      </h3>
      <dl class="rv-detail__pairs">
        <div>
          <dt>{{ t('assets.detail.source') }}</dt>
          <dd class="rv-mono" dir="ltr">{{ version.provenance.source }}</dd>
        </div>
        <div v-if="version.provenance.model">
          <dt>{{ t('assets.detail.model') }}</dt>
          <dd class="rv-mono" dir="ltr">{{ version.provenance.model }}</dd>
        </div>
        <div v-if="version.provenance.seed !== undefined">
          <dt>{{ t('assets.detail.seed') }}</dt>
          <dd class="rv-tabular">
            {{ formatNumber(version.provenance.seed, localeStore.locale) }}
          </dd>
        </div>
        <div>
          <dt>{{ t('assets.detail.created') }}</dt>
          <dd class="rv-tabular">
            {{ formatInstant(version.provenance.createdAt, localeStore.locale) }}
          </dd>
        </div>
        <div>
          <dt>{{ t('assets.detail.cost') }}</dt>
          <dd class="rv-tabular">
            {{ formatNanoUsd(version.provenance.costNanoUsd, localeStore.locale) }}
          </dd>
        </div>
      </dl>
    </section>
  </aside>
</template>

<style scoped>
.rv-detail {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
  padding: var(--rv-space-4);
  min-inline-size: 0;
}

.rv-detail__head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--rv-space-3);
}

.rv-detail__identity {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  min-inline-size: 0;
}

.rv-detail__title {
  font-size: var(--rv-text-xl);
}

.rv-detail__key {
  color: var(--rv-color-accent);
  overflow-wrap: anywhere;
}

.rv-detail__description {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
}

.rv-detail__section {
  display: flex;
  flex-direction: column;
  align-items: start;
  gap: var(--rv-space-2);
  padding-block-start: var(--rv-space-4);
  border-block-start: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-detail__section:first-of-type {
  border-block-start: none;
  padding-block-start: 0;
}

.rv-detail__section-title {
  font-size: var(--rv-text-md);
  font-weight: var(--rv-weight-semibold);
}

.rv-detail__hint {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  line-height: var(--rv-leading-snug);
  overflow-wrap: anywhere;
}

.rv-detail__badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-2);
}

.rv-detail__pairs {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: var(--rv-space-1) var(--rv-space-3);
  inline-size: 100%;
  margin: 0;
  font-size: var(--rv-text-sm);
}

.rv-detail__pairs > div {
  display: contents;
}

.rv-detail__pairs dt {
  color: var(--rv-color-text-muted);
  white-space: nowrap;
}

.rv-detail__pairs dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.rv-detail__versions {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  inline-size: 100%;
}

.rv-detail__version {
  display: flex;
  flex-direction: column;
  align-items: start;
  gap: var(--rv-space-1);
  inline-size: 100%;
  padding: var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  cursor: pointer;
  text-align: start;
  transition: border-color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-detail__version:hover {
  border-color: var(--rv-color-accent);
}

/* The selected version carries a filled edge on its leading side — a marker that
   mirrors with the document rather than a left border that would end up on the wrong
   side in Persian. */
.rv-detail__version[data-selected='true'] {
  border-color: var(--rv-color-accent);
  border-inline-start-width: 3px;
  background-color: var(--rv-color-accent-soft);
}

.rv-detail__version-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-detail__version-name {
  font-weight: var(--rv-weight-semibold);
}

.rv-detail__version-meta {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-detail__table {
  inline-size: 100%;
  border-collapse: collapse;
  font-size: var(--rv-text-sm);
}

.rv-detail__table :is(th, td) {
  text-align: start;
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-2);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
  font-weight: var(--rv-weight-regular);
}

.rv-detail__table thead th {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  font-weight: var(--rv-weight-semibold);
  white-space: nowrap;
}

.rv-detail__bones,
.rv-detail__chips {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  inline-size: 100%;
}

.rv-detail__chips {
  flex-direction: row;
  flex-wrap: wrap;
  gap: var(--rv-space-2);
}

.rv-detail__bone,
.rv-detail__chip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-2);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-sm);
  background-color: var(--rv-color-surface-sunken);
  font-size: var(--rv-text-sm);
}

.rv-detail__bone-meta,
.rv-detail__chip-meta {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}
</style>
