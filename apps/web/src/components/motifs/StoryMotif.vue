<script setup lang="ts">
import MotifFrame from './MotifFrame.vue';

/**
 * The series tree, with one subtree lifted out.
 *
 * Story is the only screen where the shape of the data *is* the interface: series →
 * season → episode → act → sequence → scene → beat. The drawing shows the spine, the
 * beats hanging off it, one act carrying a stack of earlier versions behind it, and the
 * one subtree currently being regenerated held in lapis — because regenerating a
 * subtree without touching its siblings is the thing this screen exists to do.
 */
</script>

<template>
  <MotifFrame>
    <!-- the spine -->
    <g>
      <path d="M26 26v78" class="rv-m-stroke rv-m-line" />
      <rect x="20" y="18" width="12" height="12" rx="2" class="rv-m-stroke rv-m-fill-ink" />
    </g>

    <!-- act one, with its version stack behind it -->
    <g>
      <path d="M26 44h34" class="rv-m-stroke rv-m-line" />
      <rect
        x="64"
        y="34"
        width="26"
        height="18"
        rx="2"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-quiet"
      />
      <rect
        x="61"
        y="37"
        width="26"
        height="18"
        rx="2"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-quiet"
      />
      <rect x="58" y="40" width="26" height="18" rx="2" class="rv-m-stroke rv-m-fill-surface" />
    </g>

    <!-- its beats -->
    <g>
      <path d="M84 49h18M102 49v-8h14M102 49v8h14" class="rv-m-stroke rv-m-thin rv-m-line" />
      <rect x="116" y="37" width="9" height="9" rx="1.5" class="rv-m-fill-ink rv-m-quiet" />
      <rect x="116" y="52" width="9" height="9" rx="1.5" class="rv-m-fill-ink rv-m-quiet" />
    </g>

    <!-- act two: the subtree being rewritten -->
    <g>
      <path d="M26 82h32" class="rv-m-stroke rv-m-accent" />
      <rect
        x="58"
        y="73"
        width="26"
        height="18"
        rx="2"
        class="rv-m-stroke rv-m-accent rv-m-fill-soft"
      />
      <path d="M84 82h18M102 82v-8h14M102 82v8h14" class="rv-m-stroke rv-m-thin rv-m-accent" />
      <rect x="116" y="70" width="9" height="9" rx="1.5" class="rv-m-fill-accent" />
      <rect x="116" y="85" width="9" height="9" rx="1.5" class="rv-m-fill-accent" />
    </g>

    <!-- the beat that a later episode reinterpreted: marked, not moved -->
    <g>
      <circle cx="152" cy="42" r="7" class="rv-m-stroke rv-m-mark" />
      <path d="M152 33v18M143 42h18" class="rv-m-stroke rv-m-mark rv-m-thin" />
      <path d="M129 42h14" class="rv-m-stroke rv-m-mark rv-m-dash rv-m-thin" />
    </g>

    <!-- authoring time runs down the margin, separate from story order -->
    <g>
      <path d="M176 22v88" class="rv-m-stroke rv-m-dash rv-m-thin rv-m-quiet" />
      <path d="M172 34h8M172 58h8M172 78h8M172 100h8" class="rv-m-stroke rv-m-thin rv-m-quiet" />
    </g>
  </MotifFrame>
</template>
