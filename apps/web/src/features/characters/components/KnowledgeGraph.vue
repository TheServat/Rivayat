<script setup lang="ts">
import type { AudienceVisibility, EntityId, RelationGroup } from '@rv/contracts';
import { RELATION_GROUP_NAMES, AUDIENCE_VISIBILITIES, relationGroupOf } from '@rv/contracts';
import { PhLockSimple } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../../components/AppBadge.vue';
import { formatNumber } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';
import { EPISTEMIC_STANDINGS } from '../api/epistemic';
import { useCharactersStore } from '../characters.store';

import StandingChip from './StandingChip.vue';
import StandpointControl from './StandpointControl.vue';
import { STANDING_DASH, STANDING_MESSAGE_KEY, STANDING_WIDTH } from './standing-pattern';

/**
 * The relations around one entity, at one standpoint.
 *
 * **Not a force-directed layout.** A spring simulation over a whole series produces a
 * hairball that answers no question and lands in a different place every time it is
 * opened. This is an ego network: the selected entity in the middle, its one-hop
 * neighbours on a ring, ordered by relation family and then by name, so the same graph
 * at the same standpoint always draws identically and a node does not jump across the
 * diagram because an unrelated edge appeared.
 *
 * **The nodes are real buttons, not SVG.** Focus rings, tab order, accessible names and
 * a 24px target all come free from the platform, and a graph that can only be driven
 * with a mouse fails WCAG 2.2 outright. The SVG underneath draws the *edges* only and
 * is hidden from assistive technology; the list below the diagram carries every fact
 * the diagram does, in reading order, and is not a fallback — it is the primary channel
 * for anyone who is not looking at a picture.
 *
 * **Direction.** Node positions are logical percentages, so `inset-inline-start` mirrors
 * the ring for free in Persian. The edge layer is the one thing that cannot mirror
 * itself, so it is flipped as a whole under `[dir='rtl']` — the same single-transform
 * trick the studio's illustrations use, and the reason there is no second set of
 * coordinates anywhere in this file.
 */

const { t } = useI18n();
const characters = useCharactersStore();
const localeStore = useLocaleStore();

/** Two radii, not one: the stage is wider than it is tall, and a circle would clip. */
const RING_RX = 36;
const RING_RY = 32;

interface PlacedNode {
  readonly key: string;
  readonly id: EntityId;
  readonly name: string;
  readonly typeLabel: string;
  readonly fact: string;
  readonly standing: (typeof EPISTEMIC_STANDINGS)[number] | null;
  readonly objectOfSecret: boolean;
  readonly secret: boolean;
  readonly x: number;
  readonly y: number;
  readonly dash: string;
  readonly width: number;
  readonly label: string;
}

const placed = computed<readonly PlacedNode[]>(() => {
  const list = characters.neighbours;
  return list.map((neighbour, index) => {
    const angle = ((-90 + (360 / Math.max(list.length, 1)) * index) * Math.PI) / 180;
    const typeLabel = t(`characters.graph.types.${neighbour.relation.type}`);
    const standingLabel =
      neighbour.standing === null
        ? ''
        : t(`characters.graph.epistemic.${STANDING_MESSAGE_KEY[neighbour.standing]}`);
    return {
      key: neighbour.relation.id,
      id: neighbour.entity.id,
      name: neighbour.entity.canonicalName,
      typeLabel,
      fact: neighbour.relation.fact,
      standing: neighbour.standing,
      objectOfSecret: neighbour.objectOfSecret,
      secret: neighbour.relation.visibility === 'secret',
      x: 50 + RING_RX * Math.cos(angle),
      y: 50 + RING_RY * Math.sin(angle),
      dash: neighbour.standing === null ? '0' : STANDING_DASH[neighbour.standing],
      width: neighbour.standing === null ? 1.6 : STANDING_WIDTH[neighbour.standing],
      // The accessible name opens with the visible label, so SC 2.5.3 holds, and then
      // adds what the picture is saying and cannot be read out. The secret-object note
      // is part of it because that is the edge a sighted reader misreads too.
      label: [
        neighbour.entity.canonicalName,
        typeLabel,
        standingLabel,
        neighbour.objectOfSecret ? t('characters.graph.epistemic.objectOfSecret') : '',
        neighbour.relation.fact,
      ]
        .filter((part) => part.length > 0)
        .join(' — '),
    };
  });
});

/**
 * Every relation at this standpoint, in story order, with its standing resolved.
 *
 * Sorted by `validFrom` rather than by id, which makes this list the derived *timeline*
 * of RV-072 as well as the accessible twin of the diagram: the series chronology at the
 * chosen authoring revision, read top to bottom.
 */
const timeline = computed(() =>
  [...characters.visibleRelations]
    .toSorted((left, right) => {
      const byTime = (left.validFrom?.ordinal ?? 0) - (right.validFrom?.ordinal ?? 0);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    })
    .map((relation) => ({
      relation,
      standing: characters.standingFor(relation),
      objectOfSecret: characters.objectOfSecretFor(relation),
    })),
);

const counts = computed(() => characters.standingCounts);

const countLine = computed(() =>
  EPISTEMIC_STANDINGS.filter((standing) => counts.value[standing] > 0)
    .map(
      (standing) =>
        `${t(`characters.graph.epistemic.${STANDING_MESSAGE_KEY[standing]}`)}: ${formatNumber(
          counts.value[standing],
          localeStore.locale,
        )}`,
    )
    .join(' · '),
);

function nameOf(id: string): string {
  return characters.entityById(id)?.canonicalName ?? id;
}

function onGroup(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  characters.groupFilter = value === '' ? null : (value as RelationGroup);
}

function onVisibility(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  characters.visibilityFilter = value === '' ? null : (value as AudienceVisibility);
}
</script>

<template>
  <section class="rv-graph" :aria-label="t('characters.graph.heading')">
    <header class="rv-graph__head">
      <h2 class="rv-graph__title">{{ t('characters.graph.heading') }}</h2>
      <p class="rv-graph__hint">{{ t('characters.graph.hint') }}</p>
    </header>

    <StandpointControl />

    <!-- ── the key ────────────────────────────────────────────────────────── -->
    <section
      v-if="!characters.isNarrator"
      class="rv-graph__legend"
      :aria-label="t('characters.graph.legend')"
    >
      <h3 class="rv-eyebrow">{{ t('characters.graph.epistemic.heading') }}</h3>
      <ul class="rv-graph__legend-list">
        <li v-for="standing in EPISTEMIC_STANDINGS" :key="standing">
          <StandingChip :standing="standing" explain size="md" />
        </li>
      </ul>
    </section>

    <!-- ── filters, which are filters and are labelled as such ────────────── -->
    <div class="rv-graph__filters" role="group" :aria-label="t('characters.graph.filter.heading')">
      <label class="rv-graph__filter">
        <span class="rv-graph__filter-label">{{ t('characters.graph.filter.group') }}</span>
        <select class="rv-graph__select" :value="characters.groupFilter ?? ''" @change="onGroup">
          <option value="">{{ t('characters.graph.filter.allGroups') }}</option>
          <option v-for="group in RELATION_GROUP_NAMES" :key="group" :value="group">
            {{ t(`characters.graph.groups.${group}`) }}
          </option>
        </select>
      </label>

      <label class="rv-graph__filter">
        <span class="rv-graph__filter-label">{{ t('characters.graph.filter.visibility') }}</span>
        <select
          class="rv-graph__select"
          :value="characters.visibilityFilter ?? ''"
          @change="onVisibility"
        >
          <option value="">{{ t('characters.graph.filter.allVisibilities') }}</option>
          <option v-for="value in AUDIENCE_VISIBILITIES" :key="value" :value="value">
            {{ t(`characters.graph.visibility.${value}`) }}
          </option>
        </select>
      </label>
    </div>

    <!-- ── the diagram ───────────────────────────────────────────────────── -->
    <div
      v-if="characters.focus"
      class="rv-graph__stage"
      role="group"
      :aria-label="t('characters.graph.diagramLabel', { name: characters.focus.canonicalName })"
    >
      <svg
        class="rv-graph__edges"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <g class="rv-graph__edge-group">
          <line
            v-for="node in placed"
            :key="node.key"
            class="rv-graph__edge"
            :data-standing="node.standing ?? 'plain'"
            x1="50"
            y1="50"
            :x2="node.x"
            :y2="node.y"
            :stroke-dasharray="node.dash"
            :stroke-width="node.width"
            vector-effect="non-scaling-stroke"
          />
        </g>
      </svg>

      <p class="rv-graph__centre">
        <span class="rv-eyebrow">{{ t('characters.graph.focus') }}</span>
        <span class="rv-graph__centre-name">{{ characters.focus.canonicalName }}</span>
      </p>

      <button
        v-for="node in placed"
        :key="node.key"
        type="button"
        class="rv-graph__node"
        :data-standing="node.standing ?? 'plain'"
        :aria-label="node.label"
        :style="{ insetInlineStart: `${String(node.x)}%`, insetBlockStart: `${String(node.y)}%` }"
        @click="characters.focusOn(node.id)"
      >
        <span class="rv-graph__node-head">
          <PhLockSimple
            v-if="node.secret"
            :size="11"
            weight="fill"
            aria-hidden="true"
            class="rv-graph__secret"
          />
          <span class="rv-graph__node-name">{{ node.name }}</span>
        </span>
        <span class="rv-graph__node-type">{{ node.typeLabel }}</span>
        <StandingChip v-if="node.standing" :standing="node.standing" />
        <!--
          The canonical misreading, named on the node itself. The edge touches the
          viewer, so an eye skimming the ring expects it to be something they hold; it
          is the one fact in the graph that is kept from precisely this person.
        -->
        <span v-if="node.objectOfSecret" class="rv-graph__object">{{
          t('characters.graph.epistemic.objectOfSecret')
        }}</span>
      </button>
    </div>

    <p v-if="placed.length === 0" class="rv-graph__empty">
      {{ t('characters.graph.noRelations') }}
    </p>

    <p class="rv-graph__note">{{ t('characters.graph.keyboardHint') }}</p>

    <!--
      Counts, announced. The graph redraws itself when the standpoint moves and nothing
      about that is navigable, so the one line that says what changed is a live region.
    -->
    <p v-if="!characters.isNarrator && countLine" class="rv-graph__counts" role="status">
      {{ countLine }}
    </p>

    <!-- ── the same thing, in words ──────────────────────────────────────── -->
    <section class="rv-graph__list" :aria-label="t('characters.graph.relations.heading')">
      <h3 class="rv-eyebrow">{{ t('characters.graph.relations.heading') }}</h3>
      <p class="rv-graph__note">{{ t('characters.graph.relations.hint') }}</p>

      <p v-if="timeline.length === 0" class="rv-graph__empty">
        {{ t('characters.graph.relations.empty') }}
      </p>

      <ul v-else class="rv-graph__relations">
        <li v-for="row in timeline" :key="row.relation.id" class="rv-graph__relation">
          <p class="rv-graph__fact">{{ row.relation.fact }}</p>
          <p class="rv-graph__sentence">
            <span class="rv-graph__party">{{ nameOf(row.relation.from) }}</span>
            <span class="rv-graph__verb">{{
              t(`characters.graph.types.${row.relation.type}`)
            }}</span>
            <span class="rv-graph__party">{{ nameOf(row.relation.to) }}</span>
          </p>
          <p class="rv-graph__chips">
            <StandingChip v-if="row.standing !== null" :standing="row.standing" />
            <AppBadge tone="neutral">
              {{ t(`characters.graph.groups.${relationGroupOf(row.relation.type)}`) }}
            </AppBadge>
            <AppBadge :tone="row.relation.visibility === 'secret' ? 'warning' : 'neutral'">
              <template #icon>
                <PhLockSimple
                  v-if="row.relation.visibility === 'secret'"
                  :size="11"
                  weight="fill"
                  aria-hidden="true"
                />
              </template>
              {{ t(`characters.graph.visibility.${row.relation.visibility}`) }}
            </AppBadge>
            <span class="rv-graph__span rv-tabular">
              {{ t('characters.graph.relations.since') }}
              {{
                row.relation.validFrom
                  ? formatNumber(row.relation.validFrom.ordinal, localeStore.locale)
                  : t('characters.graph.relations.open')
              }}
              —
              {{ t('characters.graph.relations.until') }}
              {{
                row.relation.validUntil
                  ? formatNumber(row.relation.validUntil.ordinal, localeStore.locale)
                  : t('characters.graph.relations.open')
              }}
            </span>
            <span class="rv-graph__span rv-tabular">
              {{ t('characters.graph.relations.strength') }}
              {{ formatNumber(row.relation.strength, localeStore.locale) }}
            </span>
          </p>
          <p v-if="row.objectOfSecret" class="rv-graph__object-note">
            {{ t('characters.graph.epistemic.objectOfSecretHint') }}
          </p>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.rv-graph {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
}

.rv-graph__head {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-graph__title {
  font-size: var(--rv-text-lg);
}

.rv-graph__hint,
.rv-graph__note {
  font-size: var(--rv-text-xs);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-muted);
  max-inline-size: 48rem;
}

.rv-graph__legend {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  padding: var(--rv-space-3);
  background-color: var(--rv-color-surface-sunken);
}

.rv-graph__legend-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: var(--rv-space-2);
}

.rv-graph__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-4);
}

.rv-graph__filter {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-graph__filter-label {
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-semibold);
  color: var(--rv-color-text-muted);
}

.rv-graph__select {
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-2);
  font-size: var(--rv-text-sm);
  min-block-size: 2rem;
}

/* ── the stage ────────────────────────────────────────────────────────────── */

.rv-graph__stage {
  position: relative;
  inline-size: 100%;
  block-size: 30rem;
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-lg);
  background-color: var(--rv-color-surface);
  overflow: hidden;
}

.rv-graph__edges {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
}

/*
 * The one thing on this screen that cannot mirror itself.
 *
 * Node positions are logical percentages and flip for free; an SVG coordinate system
 * does not know about writing direction, so the edge layer is mirrored as a whole. It
 * carries no text, so there is nothing to un-mirror afterwards.
 */
:root[dir='rtl'] .rv-graph__edge-group {
  transform-box: view-box;
  transform-origin: center;
  transform: scaleX(-1);
}

.rv-graph__edge {
  stroke: var(--rv-color-border-strong);
  stroke-linecap: round;
}

.rv-graph__edge[data-standing='knows'],
.rv-graph__edge[data-standing='witnessed'],
.rv-graph__edge[data-standing='told'] {
  stroke: var(--rv-color-success);
}

.rv-graph__edge[data-standing='believes-falsely'] {
  stroke: var(--rv-color-danger);
}

.rv-graph__edge[data-standing='suspects'] {
  stroke: var(--rv-color-info);
}

.rv-graph__edge[data-standing='blind'] {
  stroke: var(--rv-color-text-faint);
}

.rv-graph__edge[data-standing='plain'] {
  stroke: var(--rv-color-accent);
}

.rv-graph__centre,
.rv-graph__node {
  position: absolute;
  inset-inline-start: 50%;
  inset-block-start: 50%;
  /*
   * Centre the box on its point. The horizontal half has to follow the writing
   * direction, because `inset-inline-start` anchors the trailing edge in `rtl` and a
   * fixed `-50%` would push the node a full width off its own line.
   */
  transform: translate(calc(var(--rv-flip) * -50%), -50%);
  inline-size: 9rem;
  text-align: center;
}

.rv-graph__centre {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--rv-space-1);
  border: 2px solid var(--rv-color-mark);
  border-radius: var(--rv-radius-lg);
  background-color: var(--rv-color-mark-soft);
  color: var(--rv-color-text);
  padding: var(--rv-space-3) var(--rv-space-2);
}

.rv-graph__centre-name {
  font-weight: var(--rv-weight-bold);
  line-height: var(--rv-leading-snug);
}

.rv-graph__node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--rv-space-1);
  /* Well past the 24x24 floor, and it needs to be: the label is three lines. */
  min-block-size: 3.5rem;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface-raised);
  color: inherit;
  padding: var(--rv-space-2);
  cursor: pointer;
  box-shadow: var(--rv-shadow-sm);
  transition:
    border-color var(--rv-duration-instant) var(--rv-ease-standard),
    box-shadow var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-graph__node:hover {
  border-color: var(--rv-color-accent);
  box-shadow: var(--rv-shadow-md);
}

/* The border repeats the edge's pattern, so a node carries its standing too. */
.rv-graph__node[data-standing='believes-falsely'] {
  border-style: dashed;
  border-color: var(--rv-color-danger);
}

.rv-graph__node[data-standing='blind'] {
  border-style: dotted;
  border-color: var(--rv-color-border-strong);
  background-color: var(--rv-color-surface-sunken);
}

.rv-graph__node[data-standing='suspects'] {
  border-color: var(--rv-color-info);
}

.rv-graph__node[data-standing='knows'],
.rv-graph__node[data-standing='witnessed'],
.rv-graph__node[data-standing='told'] {
  border-color: var(--rv-color-success);
}

.rv-graph__node-head {
  display: flex;
  align-items: center;
  gap: var(--rv-space-1);
}

.rv-graph__secret {
  color: var(--rv-color-mark-strong);
}

.rv-graph__node-name {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-semibold);
  line-height: var(--rv-leading-tight);
}

.rv-graph__node-type {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-muted);
  line-height: var(--rv-leading-tight);
}

.rv-graph__object {
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-semibold);
  line-height: var(--rv-leading-tight);
  color: var(--rv-color-mark-strong);
  background-color: var(--rv-color-mark-soft);
  border-radius: var(--rv-radius-sm);
  padding-block: 0.0625rem;
  padding-inline: var(--rv-space-1);
}

.rv-graph__object-note {
  font-size: var(--rv-text-2xs);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-mark-strong);
  background-color: var(--rv-color-mark-soft);
  border-radius: var(--rv-radius-sm);
  padding: var(--rv-space-2);
}

.rv-graph__empty {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

.rv-graph__counts {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

/* ── the list ─────────────────────────────────────────────────────────────── */

.rv-graph__list {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

.rv-graph__relations {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

.rv-graph__relation {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding: var(--rv-space-3);
}

.rv-graph__fact {
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
}

.rv-graph__sentence {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-xs);
}

.rv-graph__party {
  font-weight: var(--rv-weight-semibold);
}

.rv-graph__verb {
  color: var(--rv-color-accent);
}

.rv-graph__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-graph__span {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
}

@media (max-width: 48rem) {
  .rv-graph__stage {
    block-size: 26rem;
  }

  .rv-graph__centre,
  .rv-graph__node {
    inline-size: 7rem;
  }
}
</style>
