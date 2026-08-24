<script setup lang="ts">
import type { MotionStyle, Palette } from '@rv/contracts';
import { computed } from 'vue';

import { frameSeek, motionPresentation, paletteColour } from './motion-preview';

/**
 * A style, moving.
 *
 * Four things happen in this little stage and each one is read off the preset: a figure
 * travels and comes back at the style's own cadence and easing, a frond sways at the
 * style's ambient wind rate, the ground layer parallaxes by the style's camera strength,
 * and the whole drawing boils if the style boils. Colour comes from the preset's own
 * palette, so the card is simultaneously the colour answer and the motion answer.
 *
 * ## Playing and stepping are the same animation
 *
 * `playing: false` does not swap in a second, hand-computed set of poses. It pauses this
 * animation and seeks it with a negative `animation-delay`, so the browser evaluates the
 * same keyframes through the same timing function it would have used to play them.
 * Stepping to frame `k` and playing to frame `k` therefore cannot disagree - which is
 * the same property the timeline player is held to, arrived at by not writing a second
 * evaluator rather than by keeping two in step.
 */
const props = withDefaults(
  defineProps<{
    motion: MotionStyle;
    palette: Palette;
    /** False under reduced motion, or when the reader has asked to step. */
    playing?: boolean;
    /** Which of `PREVIEW_FRAMES` to park on while stepped. */
    frame?: number;
  }>(),
  { playing: true, frame: 0 },
);

const presentation = computed(() => motionPresentation(props.motion));

const style = computed(() => ({
  ...presentation.value.vars,
  '--sl-seek': frameSeek(presentation.value.cycleSeconds, props.frame),
}));

const ink = computed(() => paletteColour(props.palette, 'shadow', 3));
const ground = computed(() => paletteColour(props.palette, 'background', 4));
const primary = computed(() => paletteColour(props.palette, 'primary', 0));
const secondary = computed(() => paletteColour(props.palette, 'secondary', 1));
const accent = computed(() => paletteColour(props.palette, 'accent', 2));
</script>

<template>
  <svg
    class="sl-film"
    :class="[
      `sl-film--hold-${presentation.hold}`,
      { 'sl-film--stepped': !playing, 'sl-film--boils': motion.boil.enabled },
    ]"
    :style="style"
    viewBox="0 0 132 76"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="0" y="0" width="132" height="76" :fill="ground" />

    <!-- The far layer. Parallax strength is what decides how far it lags the figure. -->
    <g class="sl-film__far">
      <path d="M-14 62 L24 34 L58 62 Z" :fill="secondary" opacity="0.35" />
      <path d="M46 62 L82 38 L118 62 Z" :fill="secondary" opacity="0.22" />
    </g>

    <rect x="0" y="60" width="132" height="16" :fill="ink" opacity="0.16" />

    <!-- Ambient life: the frond sways whether or not anything else is happening. -->
    <g class="sl-film__frond">
      <path d="M112 62 V44" :stroke="ink" stroke-width="2" stroke-linecap="round" fill="none" />
      <path d="M112 46 q10 -6 13 -14 q-11 1 -13 14z" :fill="accent" />
      <path d="M112 50 q-10 -5 -12 -13 q10 1 12 13z" :fill="accent" opacity="0.7" />
    </g>

    <g class="sl-film__boil">
      <g class="sl-film__stage">
        <!-- The subject. A cut shape, because every medium here starts as one. -->
        <g class="sl-film__figure">
          <path d="M58 60 L52 40 L74 40 L68 60 Z" :fill="primary" />
          <circle cx="63" cy="32" r="9" :fill="primary" />
          <circle class="sl-film__eye" cx="66" cy="31" r="1.8" :fill="ink" />
          <path d="M52 40 L74 40" :stroke="ink" stroke-width="1.2" opacity="0.35" />
        </g>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.sl-film {
  display: block;
  inline-size: 100%;
  block-size: auto;
  border-radius: var(--rv-radius-sm);
}

/*
 * The travel.
 *
 * The turn is at 50%, so the timing function is applied to each half separately - which
 * is what makes a hinge-and-hold curve read as a hinge and a hold rather than as a slow
 * lap. Amplitudes come from the preset through the custom properties; the shape of the
 * move is the same for every style so that what differs on screen is what differs in the
 * profile.
 */
@keyframes sl-travel {
  0% {
    transform: translate3d(calc(var(--sl-travel) * -1 * var(--rv-flip)), 0, 0)
      rotate(calc(var(--sl-lean) * -1 * var(--rv-flip))) scaleY(var(--sl-squash));
  }

  50% {
    transform: translate3d(calc(var(--sl-travel) * var(--rv-flip)), calc(var(--sl-arc) * -1), 0)
      rotate(calc(var(--sl-lean) * var(--rv-flip))) scaleY(var(--sl-stretch));
  }

  100% {
    transform: translate3d(calc(var(--sl-travel) * -1 * var(--rv-flip)), 0, 0)
      rotate(calc(var(--sl-lean) * -1 * var(--rv-flip))) scaleY(var(--sl-squash));
  }
}

/*
 * The same move, with a pose held in the middle of it.
 *
 * Keyframe offsets cannot be a custom property, so hold is three sets rather than a
 * number - see `holdBucketFor` in `motion-preview.ts` for why it is worth the
 * duplication. A woodblock print at 0.95 makes its move in a sixth of the loop and
 * spends the rest standing still, which is what a stack of carved plates can physically
 * do; painterly at 0.25 never stops.
 */
@keyframes sl-travel-hold {
  0%,
  10% {
    transform: translate3d(calc(var(--sl-travel) * -1 * var(--rv-flip)), 0, 0)
      rotate(calc(var(--sl-lean) * -1 * var(--rv-flip))) scaleY(var(--sl-squash));
  }

  36%,
  60% {
    transform: translate3d(calc(var(--sl-travel) * var(--rv-flip)), calc(var(--sl-arc) * -1), 0)
      rotate(calc(var(--sl-lean) * var(--rv-flip))) scaleY(var(--sl-stretch));
  }

  86%,
  100% {
    transform: translate3d(calc(var(--sl-travel) * -1 * var(--rv-flip)), 0, 0)
      rotate(calc(var(--sl-lean) * -1 * var(--rv-flip))) scaleY(var(--sl-squash));
  }
}

@keyframes sl-travel-long {
  0%,
  6% {
    transform: translate3d(calc(var(--sl-travel) * -1 * var(--rv-flip)), 0, 0)
      rotate(calc(var(--sl-lean) * -1 * var(--rv-flip))) scaleY(var(--sl-squash));
  }

  22%,
  56% {
    transform: translate3d(calc(var(--sl-travel) * var(--rv-flip)), calc(var(--sl-arc) * -1), 0)
      rotate(calc(var(--sl-lean) * var(--rv-flip))) scaleY(var(--sl-stretch));
  }

  72%,
  100% {
    transform: translate3d(calc(var(--sl-travel) * -1 * var(--rv-flip)), 0, 0)
      rotate(calc(var(--sl-lean) * -1 * var(--rv-flip))) scaleY(var(--sl-squash));
  }
}

@keyframes sl-parallax {
  0%,
  100% {
    transform: translate3d(calc(var(--sl-parallax) * var(--rv-flip)), 0, 0);
  }

  50% {
    transform: translate3d(calc(var(--sl-parallax) * -1 * var(--rv-flip)), 0, 0);
  }
}

/* The camera holds with the shot, so the far layer uses the same plateaus. */
@keyframes sl-parallax-hold {
  0%,
  10% {
    transform: translate3d(calc(var(--sl-parallax) * var(--rv-flip)), 0, 0);
  }

  36%,
  60% {
    transform: translate3d(calc(var(--sl-parallax) * -1 * var(--rv-flip)), 0, 0);
  }

  86%,
  100% {
    transform: translate3d(calc(var(--sl-parallax) * var(--rv-flip)), 0, 0);
  }
}

@keyframes sl-parallax-long {
  0%,
  6% {
    transform: translate3d(calc(var(--sl-parallax) * var(--rv-flip)), 0, 0);
  }

  22%,
  56% {
    transform: translate3d(calc(var(--sl-parallax) * -1 * var(--rv-flip)), 0, 0);
  }

  72%,
  100% {
    transform: translate3d(calc(var(--sl-parallax) * var(--rv-flip)), 0, 0);
  }
}

/* Three positions, snapped: a boil is a redrawn line, not a wobbling one. */
@keyframes sl-boil {
  0% {
    transform: translate3d(0, 0, 0);
  }

  33% {
    transform: translate3d(var(--sl-boil), calc(var(--sl-boil) * -1), 0);
  }

  66% {
    transform: translate3d(calc(var(--sl-boil) * -1), var(--sl-boil), 0);
  }
}

@keyframes sl-sway {
  0%,
  100% {
    transform: rotate(calc(var(--sl-sway) * -1));
  }

  50% {
    transform: rotate(var(--sl-sway));
  }
}

@keyframes sl-blink {
  0%,
  94%,
  100% {
    opacity: 1;
  }

  96%,
  98% {
    opacity: 0;
  }
}

.sl-film__stage {
  transform-box: fill-box;
  transform-origin: bottom center;
  animation: sl-travel var(--sl-cycle) var(--sl-timing) infinite;
}

.sl-film__far {
  transform-box: fill-box;
  transform-origin: center;
  animation: sl-parallax var(--sl-cycle) var(--sl-timing) infinite;
}

.sl-film--hold-some .sl-film__stage {
  animation-name: sl-travel-hold;
}

.sl-film--hold-some .sl-film__far {
  animation-name: sl-parallax-hold;
}

.sl-film--hold-long .sl-film__stage {
  animation-name: sl-travel-long;
}

.sl-film--hold-long .sl-film__far {
  animation-name: sl-parallax-long;
}

.sl-film__frond {
  transform-box: fill-box;
  transform-origin: bottom center;
  animation: sl-sway var(--sl-sway-cycle) var(--rv-ease-in-out) infinite;
}

.sl-film__eye {
  animation: sl-blink var(--sl-blink-cycle) linear infinite;
}

.sl-film--boils .sl-film__boil {
  transform-box: fill-box;
  transform-origin: center;
  animation: sl-boil var(--sl-boil-cycle) steps(1, jump-none) infinite;
}

/*
 * Stepped: paused, and seeked.
 *
 * The `!important` here is deliberate and is the narrow exception to the blanket
 * reduced-motion rule in `motion.css`. That rule collapses every duration to 1ms to stop
 * things moving; this block restores the duration on an animation that is *paused*, so
 * nothing moves either way - the duration only has to survive because a negative delay
 * measured in seconds is meaningless against a 1ms timeline, and without it a reader who
 * asked for less motion would get a card with no information in it at all instead of one
 * they can step through. Higher specificity than `*`, so it wins.
 */
.sl-film--stepped :is(.sl-film__stage, .sl-film__far) {
  animation-duration: var(--sl-cycle) !important;
  animation-iteration-count: infinite !important;
  animation-delay: var(--sl-seek) !important;
  animation-play-state: paused !important;
}

.sl-film--stepped :is(.sl-film__frond, .sl-film__eye, .sl-film__boil) {
  animation: none !important;
}
</style>
