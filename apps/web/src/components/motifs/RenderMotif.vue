<script setup lang="ts">
import MotifFrame from './MotifFrame.vue';

/**
 * One composition, three deliveries.
 *
 * Nothing is re-cut per platform: the same composition is framed for landscape,
 * vertical and square, and the only thing that changes is which safe area the
 * important part has to stay inside. The drawing is those three frames with the safe
 * area dashed inside the master, and the cost meter that has to be approved before any
 * of them is rendered — because a bill you discovered is a different experience from
 * an estimate you agreed to.
 */
</script>

<template>
  <MotifFrame>
    <!-- the master: 16:9 -->
    <g>
      <rect
        x="16"
        y="30"
        width="112"
        height="63"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-fill-surface"
      />
      <rect
        x="26"
        y="38"
        width="92"
        height="47"
        rx="2"
        class="rv-m-stroke rv-m-dash rv-m-mark rv-m-thin"
      />
    </g>

    <!-- what is in it -->
    <g>
      <circle cx="58" cy="62" r="12" class="rv-m-fill-accent" />
      <path d="M78 76l16-20 14 20z" class="rv-m-fill-soft" />
      <path d="M30 82h84" class="rv-m-stroke rv-m-thin rv-m-quiet" />
    </g>

    <!-- 9:16 -->
    <g>
      <rect
        x="140"
        y="18"
        width="32"
        height="57"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <circle cx="156" cy="42" r="7" class="rv-m-fill-accent" />
      <path d="M144 24h24M144 68h24" class="rv-m-stroke rv-m-dash rv-m-mark rv-m-thin" />
    </g>

    <!-- 1:1 -->
    <g>
      <rect
        x="140"
        y="83"
        width="32"
        height="32"
        rx="3"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <circle cx="156" cy="99" r="7" class="rv-m-fill-accent" />
    </g>

    <!-- the estimate, shown before anything is spent -->
    <g>
      <rect
        x="16"
        y="102"
        width="112"
        height="13"
        rx="6.5"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-sunken"
      />
      <rect x="16" y="102" width="66" height="13" rx="6.5" class="rv-m-fill-gold" />
      <path d="M96 96v25" class="rv-m-stroke rv-m-mark rv-m-thin rv-m-dash" />
    </g>
  </MotifFrame>
</template>
