<script setup lang="ts">
import MotifFrame from './MotifFrame.vue';

/**
 * The expression grid.
 *
 * A character in this studio is a set of drawn states — expressions, poses, wardrobe —
 * each generated once and reused for every episode that needs it. So the drawing is a
 * contact sheet of face plates with one cell selected, plus the motion signature that
 * distinguishes this character's walk from anyone else's: a rig curve, not a frame.
 */
</script>

<template>
  <MotifFrame>
    <!-- row one -->
    <g>
      <rect
        x="20"
        y="20"
        width="30"
        height="30"
        rx="4"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <circle cx="30" cy="33" r="2" class="rv-m-fill-ink" />
      <circle cx="40" cy="33" r="2" class="rv-m-fill-ink" />
      <path d="M30 41q5 4 10 0" class="rv-m-stroke rv-m-thin" />
    </g>
    <g>
      <rect
        x="56"
        y="20"
        width="30"
        height="30"
        rx="4"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <circle cx="66" cy="33" r="2" class="rv-m-fill-ink" />
      <circle cx="76" cy="33" r="2" class="rv-m-fill-ink" />
      <path d="M66 42h10" class="rv-m-stroke rv-m-thin" />
    </g>
    <g>
      <rect
        x="92"
        y="20"
        width="30"
        height="30"
        rx="4"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <path d="M99 31l6 3M115 31l-6 3" class="rv-m-stroke rv-m-thin" />
      <path d="M102 43q5-5 10 0" class="rv-m-stroke rv-m-thin" />
    </g>

    <!-- row two, with the chosen plate held in register -->
    <g>
      <rect
        x="20"
        y="56"
        width="30"
        height="30"
        rx="4"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <circle cx="30" cy="69" r="2.6" class="rv-m-fill-ink" />
      <circle cx="40" cy="69" r="2.6" class="rv-m-fill-ink" />
      <path d="M30 77q5 5 10 0" class="rv-m-stroke rv-m-thin" />
    </g>
    <g>
      <rect
        x="56"
        y="56"
        width="30"
        height="30"
        rx="4"
        class="rv-m-stroke rv-m-mark rv-m-fill-mark"
      />
      <circle cx="66" cy="69" r="2" class="rv-m-fill-ink" />
      <circle cx="76" cy="69" r="2" class="rv-m-fill-ink" />
      <path d="M65 78q6-6 12 0" class="rv-m-stroke rv-m-thin" />
      <path
        d="M52 60v-6h6M84 54h6v6M90 82v6h-6M58 88h-6v-6"
        class="rv-m-stroke rv-m-mark rv-m-thin"
      />
    </g>
    <g>
      <rect
        x="92"
        y="56"
        width="30"
        height="30"
        rx="4"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <path d="M99 68h6M109 68h6" class="rv-m-stroke rv-m-thin" />
      <circle cx="107" cy="78" r="3" class="rv-m-stroke rv-m-thin" />
    </g>

    <!-- pose strip -->
    <g>
      <rect
        x="20"
        y="94"
        width="102"
        height="16"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-sunken"
      />
      <path
        d="M30 106v-8M38 106v-6M46 106v-9M54 106v-5M62 106v-8M70 106v-7M78 106v-9M86 106v-6M94 106v-8M102 106v-5M110 106v-7"
        class="rv-m-stroke rv-m-thin rv-m-quiet"
      />
    </g>

    <!--
      The motion signature: how this character moves, held as a curve over rig
      parameters rather than as drawn frames. It is the one thing on this sheet that is
      never a picture.
    -->
    <g>
      <rect
        x="132"
        y="18"
        width="52"
        height="92"
        rx="4"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <path d="M142 30v70h34" class="rv-m-stroke rv-m-thin rv-m-line" />
      <path d="M142 96C152 96 154 44 176 36" class="rv-m-stroke rv-m-accent" />
      <circle cx="154" cy="66" r="2.6" class="rv-m-fill-accent" />
      <circle cx="176" cy="36" r="2.6" class="rv-m-fill-accent" />
    </g>
  </MotifFrame>
</template>
