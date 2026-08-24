<script setup lang="ts">
import type { FormatProfile, ShotReframe, Size } from '@rv/contracts';
import { computed, useId } from 'vue';

import {
  compositionRectInTarget,
  containedSize,
  exclusionsPx,
  focusPointPx,
  safeAreaPx,
} from '../format-geometry';

/**
 * One delivery format, drawn at its own pixel grid.
 *
 * **The safe zone is the entire reason to preview.** A preview showing the raw crop
 * shows something the audience will never see: TikTok's own interface covers close to
 * half the frame, and a composition that reads perfectly in the editor can put the
 * speaker's face behind the follow button. So this draws three things over the frame -
 * the platform's chrome, the region guaranteed clear of it, and (once a plan exists)
 * where the composition and its focus target actually land.
 *
 * ## Why SVG rather than positioned elements
 *
 * A delivered frame does **not** mirror in Persian. TikTok's action rail is on the
 * right of the phone for a Tehran viewer exactly as it is for a London one, so an
 * overlay laid out with `inset-inline-start` would flip the platform's chrome in the
 * one locale this studio is used in - and be wrong in a way that looks deliberate.
 * SVG coordinates are unaffected by `direction`, which makes them the only correct
 * coordinate system for a picture of a screen. The surrounding card mirrors; the
 * picture inside it does not, and that is the intended behaviour rather than an
 * oversight.
 *
 * ## Why the viewBox is the format's real resolution
 *
 * `0 0 1080 1920`, not `0 0 100 100`. Every rectangle drawn here is then literally the
 * number the platform states - the safe area is `x=90 y=260 w=900 h=1400`, which is
 * research 7's "900x1400 centred inside 1080x1920" and is checkable against the source
 * by reading the DOM. `vector-effect="non-scaling-stroke"` keeps a hairline a hairline
 * whether the viewBox is 1080 or 3840 wide.
 */
const props = withDefaults(
  defineProps<{
    profile: FormatProfile;
    /** The solver's answer for one shot, when there is one. Draws the crop and focus. */
    plan?: ShotReframe | null;
    /** Composition-space size the plan was solved against. Required with `plan`. */
    composition?: Size | null;
    /** Edge of the square every frame is contained in, in rem. Keeps ratios comparable. */
    box?: number;
  }>(),
  { plan: null, composition: null, box: 11 },
);

const patternId = useId();

const frame = computed(() => props.profile.size);

/**
 * Every frame is contained in the same square, so a 16:9 card and a 9:16 card differ
 * by exactly the ratio the platform states and by nothing else. Scaling them to a
 * common *height* instead would make the three vertical formats slivers beside the
 * landscape ones, which is the layout that makes seven previews unreadable.
 */
const rendered = computed(() =>
  containedSize(frame.value, { width: props.box, height: props.box }),
);

const safe = computed(() => safeAreaPx(props.profile));
const zones = computed(() => exclusionsPx(props.profile));

/** A safe area that is the whole frame needs no second outline on the frame's edge. */
const safeIsWholeFrame = computed(
  () => safe.value.width >= frame.value.width && safe.value.height >= frame.value.height,
);

const compositionRect = computed(() => {
  const plan = props.plan;
  const composition = props.composition;
  if (plan === null || composition === null) return null;
  return compositionRectInTarget(plan.strategy, plan.sourceCrop, composition, frame.value);
});

const focus = computed(() =>
  props.plan === null ? null : focusPointPx(props.plan.focusPoint, frame.value),
);

/** Crosshair arms sized to the frame rather than to a constant, so 4K is not a speck. */
const crosshair = computed(() =>
  Math.round(Math.min(frame.value.width, frame.value.height) * 0.06),
);

/**
 * The hatch pitch, in frame pixels rather than in a constant. **Do not hard-code this.**
 *
 * It was `24`, and 24 was wrong in a way only a browser could show. The viewBox here is
 * the format's real resolution, so a 24-unit tile inside `0 0 1080 1920` rendered 99px
 * wide comes out about 2px across, carrying a rule a quarter of a pixel thick. At 4K it
 * is a third of that again. The zones were painted, correctly, in a texture nobody
 * could see.
 *
 * What makes it worth a paragraph is how it survived the tests. Every component
 * assertion passed: three `<rect>` elements existed, at `x=918 y=0 w=162 h=1920`,
 * exactly where TikTok's action rail belongs. The geometry was right. The *artefact*
 * was blank - and the artefact is the entire product of this screen, because the one
 * thing it exists to tell you is that TikTok covers 45% of your frame. A screenshot
 * found it in four seconds; the suite would never have.
 *
 * That is the same defect shape as a bird rendering with a hole in it out of a file
 * that was bit-perfect, schema-valid and green. **A test that asserts on the
 * description of a picture is not testing the picture.** If you change anything about
 * how these zones are painted, look at `workspace/demo/render-formats-en-light.png`
 * afterwards, or add an assertion on measured layout in `e2e-live/render-check.mjs`
 * where the browser is real. Reading the DOM back is not enough and never was.
 *
 * Deriving the pitch from the frame keeps the ruling the same apparent size at 1080 and
 * at 3840, which is the property that was wanted all along.
 */
const hatch = computed(() => {
  const pitch = frame.value.width / 14;
  return { pitch, stroke: pitch / 2.6 };
});
</script>

<template>
  <!--
    Decorative: every fact this picture carries is also written next to it as text.
    A screen reader announcing "diagram" and then the same six numbers would read the
    card twice, and the numbers are the part that can actually be acted on.
  -->
  <svg
    class="rv-frame"
    :class="{ 'rv-frame--violation': plan !== null && plan.safeAreaViolation }"
    :viewBox="`0 0 ${frame.width} ${frame.height}`"
    :style="{ inlineSize: `${rendered.width}rem`, blockSize: `${rendered.height}rem` }"
    preserveAspectRatio="xMidYMid meet"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <!--
        The chrome is hatched, not tinted. A flat wash reads as "part of the picture";
        diagonal ruling reads as "struck out", which is what a region the platform
        covers actually is. It is also the second channel the colour cannot be: about
        one man in twelve cannot separate the gold of the safe area from a warm grey.
      -->
      <pattern
        :id="`rv-hatch-${patternId}`"
        :width="hatch.pitch"
        :height="hatch.pitch"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <!-- Mass first, then texture. The wash alone reads as part of the picture and
             the ruling alone disappears at card size; together the zone reads as
             struck out, which is what a region the platform covers actually is. -->
        <rect class="rv-frame__wash" x="0" y="0" :width="hatch.pitch" :height="hatch.pitch" />
        <line
          class="rv-frame__hatch"
          x1="0"
          y1="0"
          x2="0"
          :y2="hatch.pitch"
          :stroke-width="hatch.stroke"
        />
      </pattern>
      <clipPath :id="`rv-clip-${patternId}`">
        <rect x="0" y="0" :width="frame.width" :height="frame.height" />
      </clipPath>
    </defs>

    <rect class="rv-frame__ground" x="0" y="0" :width="frame.width" :height="frame.height" />

    <g v-if="compositionRect" :clip-path="`url(#rv-clip-${patternId})`">
      <rect
        class="rv-frame__composition"
        :x="compositionRect.x"
        :y="compositionRect.y"
        :width="compositionRect.width"
        :height="compositionRect.height"
        vector-effect="non-scaling-stroke"
      />
    </g>

    <g :clip-path="`url(#rv-clip-${patternId})`">
      <rect
        v-for="zone in zones"
        :key="zone.name"
        class="rv-frame__chrome"
        :x="zone.rect.x"
        :y="zone.rect.y"
        :width="zone.rect.width"
        :height="zone.rect.height"
        :fill="`url(#rv-hatch-${patternId})`"
      />
    </g>

    <rect
      v-if="!safeIsWholeFrame"
      class="rv-frame__safe"
      :x="safe.x"
      :y="safe.y"
      :width="safe.width"
      :height="safe.height"
      vector-effect="non-scaling-stroke"
    />

    <!-- Where the shot's focus target lands. A registration cross, not a dot: the
         studio's whole visual language is plates brought into register, and this is
         the one place the metaphor is literally true. -->
    <g v-if="focus" class="rv-frame__focus">
      <circle
        :cx="focus.x"
        :cy="focus.y"
        :r="crosshair * 0.55"
        vector-effect="non-scaling-stroke"
      />
      <path
        :d="`M${focus.x - crosshair} ${focus.y}h${crosshair * 2}M${focus.x} ${focus.y - crosshair}v${crosshair * 2}`"
        vector-effect="non-scaling-stroke"
      />
    </g>

    <rect
      class="rv-frame__edge"
      x="0"
      y="0"
      :width="frame.width"
      :height="frame.height"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>

<style scoped>
.rv-frame {
  display: block;
  margin-inline: auto;
  overflow: visible;
}

.rv-frame__ground {
  fill: var(--rv-color-surface-sunken);
}

.rv-frame__edge {
  fill: none;
  stroke: var(--rv-color-border-strong);
  stroke-width: 1;
}

.rv-frame__composition {
  fill: var(--rv-color-accent-soft);
  stroke: var(--rv-color-accent);
  stroke-width: 1;
}

.rv-frame__chrome {
  stroke: none;
}

.rv-frame__wash {
  fill: var(--rv-color-text-faint);
  opacity: 0.16;
}

.rv-frame__hatch {
  stroke: var(--rv-color-text-faint);
  opacity: 0.55;
}

.rv-frame__safe {
  fill: none;
  stroke: var(--rv-color-mark);
  stroke-width: 1.5;
  stroke-dasharray: 5 4;
}

.rv-frame__focus circle {
  fill: none;
  stroke: var(--rv-color-accent);
  stroke-width: 1.5;
}

.rv-frame__focus path {
  stroke: var(--rv-color-accent);
  stroke-width: 1.5;
}

/* A focus the solver could not hold is drawn in the danger ink as well as flagged in
   words beside the card. Colour is never the only signal, but it is the fastest one. */
.rv-frame--violation .rv-frame__focus circle,
.rv-frame--violation .rv-frame__focus path {
  stroke: var(--rv-color-danger);
}

.rv-frame--violation .rv-frame__safe {
  stroke: var(--rv-color-danger);
}
</style>
