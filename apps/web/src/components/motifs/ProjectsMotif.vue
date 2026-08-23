<script setup lang="ts">
import MotifFrame from './MotifFrame.vue';

/**
 * An empty peg bar.
 *
 * Every animation desk starts the same way: a bar with pegs on it and nothing punched
 * onto them. The dashed outline is where the first sheet goes, and the single line
 * inside it is the one-line idea a project actually begins with — that is the whole
 * ask on this screen, so the drawing shows exactly that much and no invented data.
 */
</script>

<template>
  <MotifFrame>
    <!-- the sheet that is not there yet -->
    <g>
      <rect x="46" y="22" width="108" height="70" rx="4" class="rv-m-stroke rv-m-dash rv-m-line" />
    </g>

    <!-- the registration target it will be punched onto -->
    <g>
      <circle cx="100" cy="48" r="10" class="rv-m-stroke rv-m-mark" />
      <path d="M100 32v32M84 48h32" class="rv-m-stroke rv-m-mark rv-m-thin" />
    </g>

    <!-- the one line an idea starts as -->
    <g>
      <path d="M68 74h64" class="rv-m-stroke rv-m-line" />
      <path d="M68 82h38" class="rv-m-stroke rv-m-line rv-m-thin rv-m-quiet" />
    </g>

    <!-- the peg bar, waiting -->
    <g>
      <rect
        x="30"
        y="100"
        width="140"
        height="14"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-fill-sunken"
      />
      <rect x="64" y="94" width="10" height="6" rx="1.5" class="rv-m-fill-gold" />
      <rect x="95" y="92" width="10" height="8" rx="1.5" class="rv-m-fill-gold" />
      <rect x="126" y="94" width="10" height="6" rx="1.5" class="rv-m-fill-gold" />
    </g>
  </MotifFrame>
</template>
