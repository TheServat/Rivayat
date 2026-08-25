<script setup lang="ts">
/**
 * A picture, addressed by the hash of its own bytes.
 *
 * Every image the pipeline makes is stored content-addressed, and until now the studio
 * could only show the hash. A table of alpha coverages tells you a part exists; it does
 * not tell you the splitter cut a doorway out of a photograph instead of a lamp, which is
 * a real defect this project has already shipped once and caught only by eye.
 *
 * ## Why the checkerboard is not decoration
 *
 * Every one of these is a cutout with an alpha channel, and a matte failure looks like
 * success against a solid background - a part that "removed nothing" is a full opaque
 * rectangle, and on a dark panel that reads as a picture. The checkerboard makes
 * transparency visible, so a failed cutout looks failed.
 *
 * ## Loading and failure are both states, not absences
 *
 * A blob can be missing: the registry row survives a workspace that was cleaned, and the
 * store answers 404. That is worth saying rather than leaving a broken-image glyph, since
 * the two causes - never generated, versus generated and lost - need different actions.
 */

import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = withDefaults(
  defineProps<{
    /** The content address. `null` when the version never recorded one. */
    hash: string | null;
    alt: string;
    /** Rendered size. The intrinsic image is whatever the pipeline made. */
    size?: 'thumb' | 'plate';
  }>(),
  { size: 'thumb' },
);

const { t } = useI18n();
const failed = ref(false);
const loaded = ref(false);

/**
 * Relative, so the same build works behind any origin - the transport's own rule. The
 * route answers `immutable` with a year, so a scrubbed timeline pays for a part once.
 */
const src = computed(() => (props.hash === null ? null : `/api/blobs/${props.hash}`));
</script>

<template>
  <figure :class="['rv-blob', `rv-blob--${size}`]">
    <div v-if="src === null" class="rv-blob__absent">{{ t('assets.image.none') }}</div>
    <div v-else-if="failed" class="rv-blob__absent">{{ t('assets.image.missing') }}</div>
    <img
      v-else
      :src="src"
      :alt="alt"
      loading="lazy"
      decoding="async"
      :class="{ 'rv-blob__img': true, 'is-loaded': loaded }"
      @load="loaded = true"
      @error="failed = true"
    />
  </figure>
</template>

<style scoped>
.rv-blob {
  margin: 0;
  border: 1px solid var(--rv-color-border);
  border-radius: var(--rv-radius-sm);
  overflow: hidden;
  display: grid;
  place-items: center;
  /* Transparency has to be visible or a matte failure reads as a picture. */
  background-color: var(--rv-color-surface-sunken);
  background-image:
    linear-gradient(45deg, var(--rv-color-border) 25%, transparent 25%),
    linear-gradient(-45deg, var(--rv-color-border) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--rv-color-border) 75%),
    linear-gradient(-45deg, transparent 75%, var(--rv-color-border) 75%);
  background-size: 12px 12px;
  background-position:
    0 0,
    0 6px,
    6px -6px,
    -6px 0;
}

.rv-blob--thumb {
  inline-size: 4rem;
  block-size: 4rem;
}

.rv-blob--plate {
  inline-size: 100%;
  aspect-ratio: 4 / 3;
}

.rv-blob__img {
  inline-size: 100%;
  block-size: 100%;
  object-fit: contain;
  /* Fades in on load rather than appearing mid-decode, which reads as a flicker on a
     grid of parts that all resolve at slightly different times. */
  opacity: 0;
  transition: opacity var(--rv-duration-fast) var(--rv-ease-out);
}

.rv-blob__img.is-loaded {
  opacity: 1;
}

.rv-blob__absent {
  padding: var(--rv-space-2);
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .rv-blob__img {
    transition: none;
    opacity: 1;
  }
}
</style>
