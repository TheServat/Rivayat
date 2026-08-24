<script setup lang="ts">
import type { AnimationIR } from '@rv/contracts';
import { useResizeObserver } from '@vueuse/core';
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';

import { buildFrame, type PlayerFrame } from './player/frame';
import { paintFrame, type PainterChrome } from './player/painter';

/**
 * The preview.
 *
 * Everything about where a node lands is `buildFrame`, which is `evaluate(ir, t)` from
 * `@rv/anim-engine` plus the renderer's own scene-space convention. This component
 * measures a canvas, resolves the design tokens the canvas cannot inherit, and paints.
 * It computes no motion and interpolates nothing.
 *
 * `currentFrame` is exposed on purpose. The screen's central claim - the preview agrees
 * with the evaluator - is only an assertion if the thing being compared is a value, and
 * `player.spec.ts` compares this exact object against `evaluate` at sampled times.
 *
 * The canvas is labelled and the numbers beneath it are real content. A canvas is opaque
 * to assistive technology, so the frame, the time, the camera and the drawable count are
 * also rendered as text - the same information a sighted user reads, not a consolation.
 */
const props = defineProps<{ ir: AnimationIR; timeMs: number }>();

const { t } = useI18n();
const localeStore = useLocaleStore();

const canvas = useTemplateRef<HTMLCanvasElement>('canvasEl');
const host = useTemplateRef<HTMLElement>('hostEl');

/** Measured, not assumed: the fit is `contain`, so the aspect of the box changes the frame. */
const output = ref({ width: 640, height: 360 });
const hasContext = ref(true);

useResizeObserver(host, (entries) => {
  const entry = entries[0];
  if (entry === undefined) return;
  const box = entry.contentRect;
  if (box.width < 1 || box.height < 1) return;
  output.value = { width: Math.round(box.width), height: Math.round(box.height) };
});

const currentFrame = computed<PlayerFrame>(() =>
  buildFrame(props.ir, props.timeMs, { output: output.value }),
);

const frameCount = computed(() => Math.round(props.ir.durationMs / (1000 / props.ir.fps)));

/**
 * The tokens the canvas cannot inherit.
 *
 * A canvas has no CSS cascade inside it, so the alternative to reading the custom
 * properties off the host element is a hard-coded colour - in a codebase whose entire
 * colour system is two token layers deep, and whose dark theme redefines only the
 * second. A preview that stayed light-mode on a dark page would be the visible result.
 */
function resolveChrome(): PainterChrome {
  const fallback: PainterChrome = {
    letterbox: 'transparent',
    stageEdge: 'transparent',
    placeholder: 'transparent',
    placeholderInk: 'transparent',
    text: 'transparent',
    fontFamily: 'sans-serif',
  };
  const element = host.value;
  if (element == null || typeof globalThis.getComputedStyle !== 'function') return fallback;
  const style = globalThis.getComputedStyle(element);
  const read = (name: string, backstop: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === '' ? backstop : value;
  };
  return {
    letterbox: read('--rv-color-surface-sunken', fallback.letterbox),
    stageEdge: read('--rv-color-border-strong', fallback.stageEdge),
    placeholder: read('--rv-color-accent-soft', fallback.placeholder),
    placeholderInk: read('--rv-color-accent', fallback.placeholderInk),
    text: read('--rv-color-text', fallback.text),
    fontFamily: read('--rv-font-sans', fallback.fontFamily),
  };
}

function draw(): void {
  const element = canvas.value;
  if (element == null) return;
  // `getContext` returns null in jsdom and on a canvas the browser refused to back.
  // Guarded rather than asserted: this is exactly the class of thing that passes every
  // jsdom test and throws on the first real page load.
  const context = element.getContext('2d');
  if (context === null) {
    hasContext.value = false;
    return;
  }
  hasContext.value = true;
  const ratio = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1;
  const frame = currentFrame.value;
  element.width = Math.round(frame.output.width * ratio);
  element.height = Math.round(frame.output.height * ratio);
  paintFrame(context, frame, resolveChrome(), ratio);
}

onMounted(draw);
watch(currentFrame, draw, { flush: 'post' });
// The theme and the direction change the chrome without changing the frame, so a
// redraw is needed on both or a dark page keeps a light-mode preview painted on it.
watch(() => localeStore.direction, draw);

defineExpose({ currentFrame });
</script>

<template>
  <figure class="rv-player">
    <div ref="hostEl" class="rv-player__stage">
      <canvas
        ref="canvasEl"
        class="rv-player__canvas"
        role="img"
        :aria-label="t('timeline.stage.label')"
      />
    </div>
    <figcaption class="rv-player__caption">
      <p v-if="!hasContext" class="rv-player__warn" role="status">
        {{ t('timeline.stage.noCanvas') }}
      </p>
      <dl class="rv-player__facts">
        <div>
          <dt>{{ t('timeline.transport.time') }}</dt>
          <dd class="rv-tabular" data-testid="player-position">
            {{
              t('timeline.scrub.position', {
                frame: formatNumber(currentFrame.frame, localeStore.locale),
                total: formatNumber(frameCount, localeStore.locale),
                seconds: formatNumber(currentFrame.timeMs / 1000, localeStore.locale, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }),
              })
            }}
          </dd>
        </div>
        <div>
          <dt>{{ t('timeline.stage.camera') }}</dt>
          <dd class="rv-tabular">
            {{
              t('timeline.stage.zoom', {
                value: formatNumber(currentFrame.camera.zoom, localeStore.locale, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }),
              })
            }}
          </dd>
        </div>
        <div>
          <dt>{{ t('timeline.stage.scene') }}</dt>
          <dd class="rv-tabular">
            {{
              t('timeline.stage.sceneSpace', {
                width: formatNumber(ir.sceneSpace.width, localeStore.locale),
                height: formatNumber(ir.sceneSpace.height, localeStore.locale),
              })
            }}
          </dd>
        </div>
        <div>
          <dt>{{ t('timeline.tracks.node') }}</dt>
          <dd class="rv-tabular">
            {{
              t(
                'timeline.stage.nodes',
                { count: formatNumber(currentFrame.items.length, localeStore.locale) },
                currentFrame.items.length,
              )
            }}
          </dd>
        </div>
      </dl>
      <p class="rv-player__note">{{ t('timeline.stage.origin') }}</p>
    </figcaption>
  </figure>
</template>

<style scoped>
.rv-player {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  margin: 0;
}

.rv-player__stage {
  position: relative;
  inline-size: 100%;
  aspect-ratio: 16 / 9;
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-md);
  overflow: hidden;
  background-color: var(--rv-color-surface-sunken);
}

.rv-player__canvas {
  display: block;
  inline-size: 100%;
  block-size: 100%;
}

.rv-player__caption {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-player__facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-1) var(--rv-space-4);
  margin: 0;
  font-size: var(--rv-text-xs);
}

.rv-player__facts > div {
  display: flex;
  gap: var(--rv-space-1);
}

.rv-player__facts dt {
  color: var(--rv-color-text-faint);
}

.rv-player__facts dd {
  margin: 0;
  color: var(--rv-color-text-muted);
}

.rv-player__note,
.rv-player__warn {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
}

.rv-player__warn {
  color: var(--rv-color-warning);
}
</style>
