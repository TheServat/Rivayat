<script setup lang="ts">
/**
 * The field every studio illustration is drawn on.
 *
 * Nothing but the registration brackets and the build group. It exists so the eight
 * drawings cannot drift apart in size, corner treatment or entrance timing, and so a
 * ninth one is a single file rather than a copy of an existing drawing with the
 * middle replaced.
 *
 * `aria-hidden`: these are atmosphere, not information. Every screen that uses one
 * states the same thing in words directly beneath it, and a screen reader that
 * announced "diagram of a probe sheet" would be reading the decoration twice.
 */
</script>

<template>
  <svg class="rv-motif" viewBox="0 0 200 132" aria-hidden="true" focusable="false">
    <g class="rv-motif__reg">
      <path d="M3 15V3h12M185 3h12v12M197 117v12h-12M15 129H3v-12" />
    </g>
    <g class="rv-motif__build">
      <slot />
    </g>
  </svg>
</template>
