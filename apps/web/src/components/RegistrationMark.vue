<script setup lang="ts">
/**
 * The registration mark — the studio's signature.
 *
 * A print made from more than one plate has to be *registered*: the plates are aligned
 * against a target printed outside the image so that the lapis lands exactly on top of
 * the ink. That is also, exactly, what this product does — assets are drawn once,
 * separately, and composed into one frame — so the mark is not a logo borrowed from
 * somewhere, it is the operation the software performs.
 *
 * Three plates converge on load, and again on hover of the brand. Everywhere else the
 * mark is already registered and holds still: a section that is *selected*, a screen
 * that is empty, a page that does not exist (that one never registers, which is the
 * point). `busy` turns it into the loading indicator by rotating the outer plate on
 * 2s — twelve positions a second, the cadence of the animation the studio produces.
 */
withDefaults(
  defineProps<{
    /** Plays the converge sequence once, on mount. Off for a mark used as a bullet. */
    animated?: boolean;
    /** Holds the plates apart. The 404 uses it: nothing here lines up. */
    misregistered?: boolean;
    /** Steps the outer plate round at 12 fps while the studio is working. */
    busy?: boolean;
  }>(),
  { animated: false, misregistered: false, busy: false },
);
</script>

<template>
  <svg
    class="rv-mark"
    :class="{
      'rv-mark--animated': animated,
      'rv-mark--off': misregistered,
      'rv-mark--busy': busy,
    }"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <g class="rv-mark__plate rv-mark__plate--outer">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 0.5v3M12 20.5v3M0.5 12h3M20.5 12h3" />
    </g>
    <g class="rv-mark__plate rv-mark__plate--inner">
      <circle cx="12" cy="12" r="4.25" />
    </g>
    <g class="rv-mark__plate rv-mark__plate--ink">
      <path d="M12 4.5v15M4.5 12h15" />
      <circle cx="12" cy="12" r="1.35" />
    </g>
  </svg>
</template>

<style scoped>
.rv-mark {
  inline-size: 1em;
  block-size: 1em;
  overflow: visible;
}

.rv-mark__plate {
  fill: none;
  stroke-width: 1.25;
  stroke-linecap: round;
  /* `fill-box` so the plates rotate about the glyph's centre rather than the origin of
     the user-space coordinate system, which for an inline SVG is the page. */
  transform-box: fill-box;
  transform-origin: center;
  transition: transform var(--rv-duration-normal) var(--rv-ease-register);
}

.rv-mark__plate--outer {
  stroke: var(--rv-color-accent);
}

.rv-mark__plate--inner {
  stroke: var(--rv-color-mark);
}

.rv-mark__plate--ink {
  stroke: currentcolor;
  fill: none;
}

.rv-mark__plate--ink circle {
  fill: currentcolor;
  stroke: none;
}

/* The converge. Each plate arrives from its own offset, so for the first third of a
   second the mark is genuinely a mis-registered print and then it is not. */
.rv-mark--animated .rv-mark__plate--outer {
  animation: rv-plate-a var(--rv-duration-deliberate) var(--rv-ease-register) backwards;
}

.rv-mark--animated .rv-mark__plate--inner {
  animation: rv-plate-b var(--rv-duration-deliberate) var(--rv-ease-register) 40ms backwards;
}

.rv-mark--animated .rv-mark__plate--ink {
  animation: rv-plate-ink var(--rv-duration-slow) var(--rv-ease-decelerate) 120ms backwards;
}

/* Held apart on purpose. */
.rv-mark--off .rv-mark__plate--outer {
  transform: translate(-7%, -6%) rotate(-5deg);
}

.rv-mark--off .rv-mark__plate--inner {
  transform: translate(7%, 5%) rotate(4deg);
}

/* Busy: the outer plate steps round twelve times a second. Machine-driven, so it
   steps rather than glides — see `motion.css`. */
.rv-mark--busy .rv-mark__plate--outer {
  animation: rv-tick 1s var(--rv-step-2s-long) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .rv-mark--busy .rv-mark__plate--outer {
    animation: none;
  }

  /* Still a state change, just not a moving one: the busy mark dims instead. */
  .rv-mark--busy {
    opacity: 0.6;
  }
}
</style>
