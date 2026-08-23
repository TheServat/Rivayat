<script setup lang="ts">
import { computed } from 'vue';

/**
 * A placeholder shaped like the thing that is coming.
 *
 * Sized by the caller, in the caller's units, because a skeleton whose proportions do
 * not match the real content is worse than no skeleton: the layout jumps when the data
 * lands and the reader loses the line they were on. The screens that use this measure
 * their own rows and pass those numbers in.
 *
 * The sweep steps at twelve per second rather than gliding — the house rule is that
 * machine-driven motion is held on 2s (`motion.css`). It is a travelling band and not
 * a pulse on purpose: a large area changing brightness twelve times a second is a
 * photosensitivity hazard, and a band crossing a shape is not.
 */
const props = withDefaults(
  defineProps<{
    /** Any CSS length or percentage. Maps to `inline-size`, so it mirrors in RTL. */
    inlineSize?: string;
    blockSize?: string;
    shape?: 'line' | 'block' | 'disc';
  }>(),
  { inlineSize: '100%', blockSize: '1rem', shape: 'line' },
);

const style = computed(() => ({
  'inline-size': props.inlineSize,
  'block-size': props.blockSize,
}));
</script>

<template>
  <span class="rv-skeleton" :class="`rv-skeleton--${shape}`" :style="style" aria-hidden="true" />
</template>

<style scoped>
.rv-skeleton {
  display: block;
  position: relative;
  overflow: hidden;
  background-color: var(--rv-color-skeleton);
}

.rv-skeleton--line {
  border-radius: var(--rv-radius-pill);
}

.rv-skeleton--block {
  border-radius: var(--rv-radius-md);
}

.rv-skeleton--disc {
  border-radius: 50%;
}

.rv-skeleton::after {
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  inline-size: 45%;
  /* Symmetric, so the gradient itself has no direction to get wrong; the travel is
     mirrored by `--rv-flip` in the keyframe. */
  background-image: linear-gradient(
    90deg,
    transparent,
    var(--rv-color-skeleton-sheen),
    transparent
  );
  animation: rv-sweep 1s var(--rv-step-2s-long) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .rv-skeleton::after {
    /* No travel, and no strobe either: the shape simply sits there, which still says
       "content is on its way" because it is shaped like the content. */
    display: none;
  }
}
</style>
