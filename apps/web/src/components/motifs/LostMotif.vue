<script setup lang="ts">
import MotifFrame from './MotifFrame.vue';

/**
 * The one drawing that never comes into register.
 *
 * Everywhere else in the studio the plates converge; on the page that does not exist
 * they sit apart over the empty target they were supposed to land on. It says
 * "misprint" before the heading does, and it is the only place the signature motion is
 * deliberately withheld.
 */
</script>

<template>
  <MotifFrame>
    <!-- where the plates should have landed -->
    <g>
      <circle cx="100" cy="66" r="26" class="rv-m-stroke rv-m-dash rv-m-line rv-m-thin" />
      <path d="M100 30v72M64 66h72" class="rv-m-stroke rv-m-dash rv-m-line rv-m-thin" />
    </g>

    <!-- the lapis plate, short of the mark -->
    <g>
      <circle cx="70" cy="50" r="19" class="rv-m-stroke rv-m-accent" />
      <path d="M70 26v48M46 50h48" class="rv-m-stroke rv-m-accent rv-m-thin" />
    </g>

    <!-- the saffron plate, past it -->
    <g>
      <circle cx="132" cy="82" r="19" class="rv-m-stroke rv-m-mark" />
      <path d="M132 58v48M108 82h48" class="rv-m-stroke rv-m-mark rv-m-thin" />
    </g>

    <!-- the ink plate, turned -->
    <g>
      <circle cx="104" cy="72" r="13" class="rv-m-stroke" />
      <path d="M95 63l18 18M113 63l-18 18" class="rv-m-stroke rv-m-thin" />
    </g>
  </MotifFrame>
</template>
