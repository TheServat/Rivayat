<script setup lang="ts">
import MotifFrame from './MotifFrame.vue';

/**
 * The two clocks.
 *
 * Rivayat's memory is bi-temporal: story time is when a thing happened to the
 * characters, authoring time is when the studio decided it. They run independently —
 * episode nine can reveal what episode two secretly meant — which is why the drawing
 * has two tracks pointing opposite ways and one playhead crossing both. Everything
 * above the playhead is asserted; the dashed span behind it is the earlier scene a
 * later episode reached back and reinterpreted.
 *
 * The keyframe diamonds sit in pairs, on 2s. That is not decoration either: the
 * animation engine evaluates rig parameters at twelve distinct poses a second.
 */
</script>

<template>
  <MotifFrame>
    <!-- story time, running forward -->
    <g>
      <path d="M18 46h158" class="rv-m-stroke rv-m-line" />
      <path d="M170 41l6 5-6 5" class="rv-m-stroke rv-m-line" />
      <path d="M18 34v12" class="rv-m-stroke rv-m-thin rv-m-quiet" />
    </g>
    <g>
      <path
        d="M32 46l5-5 5 5-5 5zM46 46l5-5 5 5-5 5zM76 46l5-5 5 5-5 5zM90 46l5-5 5 5-5 5zM134 46l5-5 5 5-5 5zM148 46l5-5 5 5-5 5z"
        class="rv-m-fill-ink rv-m-quiet"
      />
    </g>

    <!-- the span a later episode reinterpreted -->
    <g>
      <path d="M32 58h58" class="rv-m-stroke rv-m-dash rv-m-mark rv-m-thin" />
      <path d="M32 54v8M90 54v8" class="rv-m-stroke rv-m-mark rv-m-thin" />
    </g>

    <!-- authoring time, running the other way -->
    <g>
      <path d="M18 90h158" class="rv-m-stroke rv-m-line" />
      <path d="M24 85l-6 5 6 5" class="rv-m-stroke rv-m-line" />
    </g>
    <g>
      <path
        d="M58 90l5-5 5 5-5 5zM72 90l5-5 5 5-5 5zM106 90l5-5 5 5-5 5zM120 90l5-5 5 5-5 5z"
        class="rv-m-fill-accent"
      />
      <path d="M148 90l5-5 5 5-5 5z" class="rv-m-fill-gold" />
    </g>

    <!-- the playhead, crossing both clocks at once -->
    <g>
      <path d="M112 22v88" class="rv-m-stroke rv-m-mark rv-m-bold" />
      <path d="M107 22h10l-5 7z" class="rv-m-fill-gold" />
    </g>

    <!-- behaviour parameters, evaluated rather than drawn -->
    <g>
      <path d="M18 116h158" class="rv-m-stroke rv-m-thin rv-m-quiet" />
      <path
        d="M18 112v8M32 112v8M46 112v8M60 112v8M74 112v8M88 112v8M102 112v8M116 112v8M130 112v8M144 112v8M158 112v8M172 112v8"
        class="rv-m-stroke rv-m-thin rv-m-quiet"
      />
    </g>
  </MotifFrame>
</template>
