<script setup lang="ts">
import { PhFlask } from '@phosphor-icons/vue';
import { onBeforeUnmount, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterView, useRouter } from 'vue-router';

import { useStudioApi } from '../api/client';
import AppBadge from '../components/AppBadge.vue';
import RegistrationMark from '../components/RegistrationMark.vue';

import AppNav from './AppNav.vue';
import LocaleSwitcher from './LocaleSwitcher.vue';
import ThemeSwitcher from './ThemeSwitcher.vue';
import { installRouteViewTransition } from './useRouteViewTransition';

const { t } = useI18n();

/**
 * The badge is not decoration.
 *
 * A studio served from recorded fixtures looks exactly like one talking to a live API,
 * and that is the single most expensive confusion this app can cause - a settings
 * change that appears to save and did not. So the transport announces itself whenever
 * it is not `http`.
 */
const transportKind = useStudioApi().transport.kind;

/**
 * The page-load sequence is CSS, not JavaScript.
 *
 * `rv-enter-*` classes carry one-shot animations that run when the element is first
 * painted and never again, which is exactly the behaviour wanted: the shell mounts once
 * per page load, so the choreography plays once per page load with no state to reset
 * and nothing to tear down. The order — mark, header, rail, sections, content — is the
 * reading order, so the motion is teaching the layout rather than ornamenting it.
 *
 * The only JavaScript here is the view-transition bridge, which cannot be expressed in
 * a stylesheet.
 */
const router = useRouter();
let stopViewTransition: (() => void) | undefined;

onMounted(() => {
  stopViewTransition = installRouteViewTransition(router);
});

onBeforeUnmount(() => {
  stopViewTransition?.();
});
</script>

<template>
  <div class="rv-shell">
    <a class="rv-skip-link" href="#rv-main">{{ t('shell.skipToContent') }}</a>

    <header class="rv-shell__top rv-enter-header">
      <div class="rv-shell__brand">
        <!--
          The signature.

          Three plates — lapis, saffron, ink — arrive out of register and converge,
          once, on load; hovering the wordmark lifts them apart again. It is the
          operation this software performs, drawn: separately-made layers brought into
          alignment.
        -->
        <RegistrationMark class="rv-shell__mark" animated />
        <span class="rv-shell__names">
          <span class="rv-shell__name">{{ t('app.name') }}</span>
          <span class="rv-shell__tagline">{{ t('app.tagline') }}</span>
        </span>
      </div>

      <div class="rv-shell__tools" role="group" :aria-label="t('shell.toolbar')">
        <AppBadge
          v-if="transportKind !== 'http'"
          tone="warning"
          :title="t('shell.transportFixtureHint')"
          data-testid="transport-badge"
        >
          <template #icon>
            <PhFlask :size="13" weight="fill" aria-hidden="true" />
          </template>
          {{ t('shell.transportFixture') }}
        </AppBadge>
        <ThemeSwitcher />
        <LocaleSwitcher />
      </div>
    </header>

    <div class="rv-shell__body">
      <aside class="rv-shell__side">
        <span class="rv-shell__rail rv-enter-rail" aria-hidden="true" />
        <AppNav />
      </aside>

      <main
        id="rv-main"
        class="rv-shell__main rv-enter-content"
        :aria-label="t('shell.mainContent')"
      >
        <div class="rv-shell__page">
          <RouterView v-slot="{ Component, route }">
            <!--
              `out-in`, so two headings are never on screen at once, and the entrance
              moves rather than fades: the incoming screen arrives a few pixels
              off-register and is pushed home. Where the browser has the View
              Transitions API, `useRouteViewTransition` takes over and these classes are
              switched off — see `motion.css`.
            -->
            <Transition name="rv-route" mode="out-in">
              <component :is="Component" :key="route.path" />
            </Transition>
          </RouterView>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.rv-shell {
  display: flex;
  flex-direction: column;
  min-block-size: 100%;
}

.rv-shell__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--rv-space-4);
  min-block-size: var(--rv-topbar-height);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-5);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
  background-color: var(--rv-color-surface);
}

.rv-shell__brand {
  display: flex;
  align-items: center;
  gap: var(--rv-space-3);
  min-inline-size: 0;
}

.rv-shell__mark {
  font-size: 1.75rem;
  color: var(--rv-color-text);
}

/*
 * The flourish, made repeatable.
 *
 * Re-running the load animation on hover does not work — the browser will not restart
 * an animation whose name and parameters have not changed — and duplicating the
 * keyframes under a second name to force it would be a lie in the stylesheet. So hover
 * does the *opposite*: it pulls the plates out of register, and leaving pushes them
 * back. Same idea, one transition each, replayable forever, and the interaction now
 * means something — you are lifting the plates off the pegs.
 */
.rv-shell__brand:hover .rv-shell__mark :deep(.rv-mark__plate--outer) {
  transform: translate(-7%, -6%) rotate(-5deg);
}

.rv-shell__brand:hover .rv-shell__mark :deep(.rv-mark__plate--inner) {
  transform: translate(7%, 5%) rotate(4deg);
}

.rv-shell__names {
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
}

.rv-shell__name {
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-black);
  line-height: var(--rv-leading-tight);
}

.rv-shell__tagline {
  font-size: var(--rv-text-xs);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-faint);
}

.rv-shell__tools {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-shell__body {
  display: flex;
  flex: 1;
  min-block-size: 0;
}

/*
 * `border-inline-end` on the sidebar. In `rtl` the sidebar is on the right and its
 * divider on its left; in `ltr` both flip. Flexbox order plus a logical border is the
 * entire mechanism - there is no mirrored stylesheet.
 */
.rv-shell__side {
  position: relative;
  inline-size: var(--rv-sidebar-width);
  flex-shrink: 0;
  border-inline-end: var(--rv-border-width) solid var(--rv-color-border);
  background-color: var(--rv-color-surface);
}

/* A saffron hairline down the outer edge of the sidebar, drawn on load. It is the
   trim of the peg bar, and the only place the accent touches the chrome. */
.rv-shell__rail {
  position: absolute;
  inset-block: 0;
  inset-inline-end: -1px;
  inline-size: 2px;
  background-color: var(--rv-color-mark);
  opacity: 0.55;
}

.rv-shell__main {
  flex: 1;
  min-inline-size: 0;
  padding-block: var(--rv-space-6);
  padding-inline: var(--rv-space-6);
  overflow-y: auto;
}

.rv-shell__page {
  max-inline-size: var(--rv-content-max);
}

/*
 * Where the browser supports it, the content region is its own snapshot during a route
 * change, so it can be moved independently of the chrome around it. Everything else
 * stays in the default `root` snapshot and cross-fades — which is invisible, because
 * nothing else changed.
 */
@supports (view-transition-name: none) {
  .rv-shell__main {
    view-transition-name: rv-main;
  }
}

/*
 * Narrow: the sidebar lies down above the content.
 *
 * `column` on the body rather than a drawer behind a hamburger. Eight sections fit in a
 * scrolling strip, and a strip costs no taps — a drawer costs one tap per navigation
 * plus the memory of where the sections went.
 */
@media (max-width: 63.99rem) {
  .rv-shell__top {
    padding-inline: var(--rv-space-4);
  }

  .rv-shell__body {
    flex-direction: column;
  }

  .rv-shell__side {
    inline-size: 100%;
    border-inline-end: none;
    border-block-end: var(--rv-border-width) solid var(--rv-color-border);
  }

  .rv-shell__rail {
    inset-block: auto 0;
    inset-inline: 0;
    inline-size: auto;
    block-size: 2px;
  }

  .rv-shell__main {
    padding-block: var(--rv-space-5);
    padding-inline: var(--rv-space-4);
  }
}

/*
 * Below ~480px the three display controls and the wordmark cannot share a line without
 * the wordmark being crushed to its glyph — which is the one thing in the header that
 * must never be crushed. So the header wraps: the studio's name keeps its row and the
 * controls take the next one.
 */
@media (max-width: 30rem) {
  .rv-shell__top {
    flex-wrap: wrap;
    padding-block: var(--rv-space-3);
  }

  .rv-shell__tools {
    flex-wrap: wrap;
  }

  .rv-shell__tagline {
    display: none;
  }
}
</style>
