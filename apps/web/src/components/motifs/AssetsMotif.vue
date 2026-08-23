<script setup lang="ts">
import MotifFrame from './MotifFrame.vue';

/**
 * One asset, exploded into the parts it is actually stored as.
 *
 * The registry does not hold pictures, it holds transparent parts with a z-order and a
 * rig that moves them, keyed so the same part is never generated twice. So the drawing
 * is a paper-cutout bird pulled apart along its z axis — wing, body, head, beak — with
 * the dedup key underneath as a row of cells, because that key is what makes the
 * second request for this asset cost nothing.
 */
</script>

<template>
  <MotifFrame>
    <!-- z-order guides -->
    <g>
      <path
        d="M34 96l24-14M74 84l24-14M114 72l24-14"
        class="rv-m-stroke rv-m-dash rv-m-thin rv-m-quiet"
      />
    </g>

    <!-- z0 — wing, furthest back -->
    <g>
      <path
        d="M18 104l30-18 26 14-30 18z"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-sunken"
      />
      <path d="M28 100l16-9 12 6-16 9z" class="rv-m-fill-soft" />
    </g>

    <!-- z1 — body -->
    <g>
      <path
        d="M58 92l30-18 26 14-30 18z"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-sunken"
      />
      <path d="M68 88q8-10 18-4t-4 12-14-8z" class="rv-m-fill-accent" />
    </g>

    <!-- z2 — head -->
    <g>
      <path
        d="M98 80l30-18 26 14-30 18z"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-sunken"
      />
      <circle cx="124" cy="76" r="8" class="rv-m-fill-accent" />
      <circle cx="127" cy="74" r="1.6" class="rv-m-fill-surface" />
    </g>

    <!-- z3 — beak, in front -->
    <g>
      <path d="M138 68l30-18 26 14-30 18z" class="rv-m-stroke rv-m-mark rv-m-thin rv-m-fill-mark" />
      <path d="M156 64l14 4-12 6z" class="rv-m-fill-gold" />
    </g>

    <!-- the dedup key: semanticKey + styleChecksum + variantKey + specHash -->
    <g>
      <rect
        x="18"
        y="16"
        width="120"
        height="12"
        rx="2"
        class="rv-m-stroke rv-m-line rv-m-thin rv-m-fill-surface"
      />
      <path
        d="M26 20v4M32 19v6M38 21v2M44 19v6M50 20v4M56 19v6M62 21v2M68 19v6M74 20v4M80 19v6M86 21v2M92 19v6M98 20v4M104 19v6M110 21v2M116 19v6M122 20v4M128 19v6"
        class="rv-m-stroke rv-m-thin rv-m-quiet"
      />
      <circle cx="150" cy="22" r="6" class="rv-m-stroke rv-m-mark rv-m-thin" />
      <path d="M147 22l2.4 2.6L154 19" class="rv-m-stroke rv-m-mark" />
    </g>
  </MotifFrame>
</template>
