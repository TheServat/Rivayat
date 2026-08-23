<script setup lang="ts">
import MotifFrame from './MotifFrame.vue';

/**
 * The probe sheet.
 *
 * Style Lab's job is to choose a medium before a single asset exists, so the drawing is
 * the thing it produces: one swatch per medium, each rendered *in* that medium rather
 * than labelled with its name — cut paper as offset flats, ink-comic as hatching,
 * watercolour as wet overlaps, woodblock as carve marks, felt as a stitched edge, clay
 * as a blob with a highlight. The last cell is locked, in saffron, because locking the
 * style bible is the one irreversible act on this screen.
 */
</script>

<template>
  <MotifFrame>
    <!-- paper-cutout: flats, offset, no shading -->
    <g>
      <rect
        x="16"
        y="24"
        width="36"
        height="38"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <path d="M22 54l6-19 11 5-4 16z" class="rv-m-fill-soft" />
      <path d="M28 52l7-15 10 6-4 12z" class="rv-m-fill-mark" />
      <path d="M35 50l5-10 6 5-2 7z" class="rv-m-fill-ink rv-m-quiet" />
    </g>

    <!-- ink-comic: one weighted contour over a hatch -->
    <g>
      <rect
        x="60"
        y="24"
        width="36"
        height="38"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <path
        d="M66 52l9-15M71 55l9-15M76 57l9-15M81 58l8-14"
        class="rv-m-stroke rv-m-thin rv-m-quiet"
      />
      <path d="M66 40q11-11 24-3" class="rv-m-stroke rv-m-bold" />
    </g>

    <!-- watercolour: wet edges, pigment pooling where they overlap -->
    <g class="rv-m-quiet">
      <rect
        x="104"
        y="24"
        width="36"
        height="38"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <circle cx="117" cy="46" r="9" class="rv-m-fill-soft" />
      <circle cx="128" cy="49" r="8" class="rv-m-fill-mark" />
      <circle cx="124" cy="38" r="6.5" class="rv-m-fill-accent rv-m-quiet" />
    </g>

    <!-- gouache: opaque, matte, hard-edged -->
    <g>
      <rect
        x="148"
        y="24"
        width="36"
        height="38"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <rect x="154" y="34" width="14" height="20" rx="1" class="rv-m-fill-soft" />
      <rect x="164" y="40" width="14" height="14" rx="1" class="rv-m-fill-gold" />
    </g>

    <!-- woodblock: the grain of the cut -->
    <g>
      <rect
        x="16"
        y="70"
        width="36"
        height="38"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <rect x="22" y="76" width="24" height="5" class="rv-m-fill-ink rv-m-quiet" />
      <path d="M22 87h22M22 92h14M22 97h24M22 102h11" class="rv-m-stroke rv-m-line" />
    </g>

    <!-- felt-craft: a stitched edge -->
    <g>
      <rect
        x="60"
        y="70"
        width="36"
        height="38"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <path d="M68 91q0-11 10-11t10 11-10 13-10-13z" class="rv-m-stroke rv-m-dash rv-m-fill-mark" />
    </g>

    <!-- claymation: one form, one highlight -->
    <g>
      <rect
        x="104"
        y="70"
        width="36"
        height="38"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <ellipse cx="122" cy="92" rx="13" ry="11" class="rv-m-fill-soft" />
      <ellipse cx="117" cy="87" rx="4" ry="2.6" class="rv-m-fill-surface" />
    </g>

    <!-- the locked choice -->
    <g>
      <rect
        x="148"
        y="70"
        width="36"
        height="38"
        rx="3"
        class="rv-m-stroke rv-m-mark rv-m-fill-mark"
      />
      <circle cx="166" cy="89" r="7" class="rv-m-stroke rv-m-mark" />
      <path d="M166 76v26M153 89h26" class="rv-m-stroke rv-m-mark" />
    </g>
  </MotifFrame>
</template>
