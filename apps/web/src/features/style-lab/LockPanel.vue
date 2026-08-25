<script setup lang="ts">
import { PhLockSimple, PhWarningDiamond } from '@phosphor-icons/vue';
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../components/AppBadge.vue';
import AppButton from '../../components/AppButton.vue';
import { formatInstant } from '../../i18n/format';
import { localised } from '../../i18n/localised';
import { useLocaleStore } from '../../stores/locale.store';
import { useProjectsStore } from '../../stores/projects.store';
import { useStyleLabStore } from '../../stores/style-lab.store';

/**
 * The one confirmation on this screen, and the reason the rest of it has none.
 *
 * Locking freezes the checksum, and every asset dedup key downstream is derived from it -
 * so changing style afterwards forks the asset library rather than reusing any of it.
 * That is irreversible in the sense that matters, and it is the only thing here that is.
 * Confirming anything reversible as well would train the reader to click through this
 * one, which is precisely what must not happen.
 *
 * The confirmation states the consequence rather than asking "are you sure": a person who
 * did not know what locking does is not helped by being asked twice.
 */
const { t } = useI18n();
const lab = useStyleLabStore();
const localeStore = useLocaleStore();
const projects = useProjectsStore();

/**
 * The project this lock will be recorded on.
 *
 * Named on the button rather than left implicit. Locking is the one irreversible action
 * here and it now writes to a project - so "which one" stopped being a detail the moment
 * the studio held more than one.
 */
const projectName = computed(
  () => projects.projects.find((entry) => entry.id === lab.projectId)?.name ?? null,
);

/**
 * A style that is frozen but that the project does not point at yet.
 *
 * A real state rather than a defensive one: locking is two calls, and the second can fail
 * on its own. Saying "locked" and stopping would leave a project that reads "no style
 * chosen" beside a panel that reads "locked", with nothing on screen explaining the
 * disagreement or offering to fix it.
 */
const detached = computed(() => lab.isLocked && lab.projectId !== null && lab.attaching !== 'done');

const CONFIRM_ID = 'rv-style-lock-confirm';
const TRIGGER_ID = 'rv-style-lock-trigger';

const asking = ref(false);

const styleName = computed(() =>
  lab.selected === null ? '' : localised(lab.selected.name, localeStore.locale),
);

/**
 * The fingerprint, shortened.
 *
 * Sixty-four hex characters is not something a person reads; twelve is something they can
 * compare against a run log. It is displayed `dir="ltr"` because a hex string has no
 * business being reordered by the bidi algorithm inside a Persian paragraph.
 */
const shortChecksum = computed(() => lab.bible?.checksum.slice(0, 12) ?? '');

async function ask(): Promise<void> {
  asking.value = true;
  await nextTick();
  document.getElementById(`${CONFIRM_ID}-yes`)?.focus();
}

async function dismiss(): Promise<void> {
  asking.value = false;
  await nextTick();
  document.getElementById(TRIGGER_ID)?.focus();
}

async function confirm(): Promise<void> {
  await lab.lock();
  await dismiss();
}
</script>

<template>
  <section class="sl-lock" :aria-label="t('styleLab.lock.heading')">
    <header class="sl-lock__head">
      <h2 class="sl-lock__title">{{ t('styleLab.lock.heading') }}</h2>
      <p class="sl-lock__hint">{{ t('styleLab.lock.hint') }}</p>
    </header>

    <!--
      The checksum, on the screen that decides it. Three states and never a blank: not
      made yet, made but still moving, frozen.
    -->
    <p class="sl-lock__checksum">
      <span class="rv-eyebrow">{{ t('styleLab.checksum.label') }}</span>
      <span v-if="lab.bible === null" class="sl-lock__checksum-none">
        {{ t('styleLab.checksum.none') }}
      </span>
      <template v-else>
        <code class="sl-lock__hash rv-mono" dir="ltr">{{ shortChecksum }}</code>
        <AppBadge v-if="lab.isLocked" tone="success">
          <template #icon>
            <PhLockSimple :size="13" weight="fill" aria-hidden="true" />
          </template>
          {{ t('styleLab.state.locked') }}
        </AppBadge>
        <span v-else class="sl-lock__checksum-none">{{ t('styleLab.checksum.pending') }}</span>
      </template>
    </p>
    <p class="sl-lock__hint">{{ t('styleLab.checksum.hint') }}</p>

    <div v-if="lab.isLocked && lab.bible" class="sl-lock__done" role="status">
      <PhLockSimple :size="18" weight="fill" aria-hidden="true" />
      <span>{{ t('styleLab.lock.locked') }}</span>
      <span class="sl-lock__when">
        {{
          t('styleLab.lock.lockedAt', {
            when: formatInstant(lab.bible.lockedAt ?? '', localeStore.locale),
          })
        }}
      </span>
      <span v-if="projectName !== null" class="sl-lock__when">
        {{ t('styleLab.lock.forProject', { project: projectName }) }}
      </span>

      <!--
        Locked, but the project does not point at it. Offered as an action rather than
        reported as an error: the fix is one idempotent call and the person is already
        here. Inside this branch because `detached` cannot be true unless the style is
        locked - and a sibling `v-if` between a `v-if` and its `v-else` detaches them.
      -->
      <template v-if="detached">
        <span class="sl-lock__when">{{ t('styleLab.lock.detached') }}</span>
        <AppButton variant="primary" :disabled="lab.attaching === 'busy'" @click="lab.attach()">
          {{ lab.attaching === 'busy' ? t('styleLab.lock.attaching') : t('styleLab.lock.attach') }}
        </AppButton>
      </template>
    </div>

    <template v-else>
      <div class="sl-lock__actions">
        <AppButton
          :id="TRIGGER_ID"
          variant="primary"
          :disabled="lab.bible === null || lab.locking === 'busy'"
          :aria-expanded="asking"
          :aria-controls="CONFIRM_ID"
          @click="asking ? dismiss() : ask()"
        >
          <PhLockSimple :size="15" weight="fill" aria-hidden="true" />
          {{ lab.locking === 'busy' ? t('styleLab.lock.locking') : t('styleLab.lock.action') }}
        </AppButton>
        <p v-if="projectName !== null" class="sl-lock__hint">
          {{ t('styleLab.lock.forProject', { project: projectName }) }}
        </p>
        <p v-else class="sl-lock__hint">{{ t('styleLab.lock.noProject') }}</p>
        <p v-if="lab.bible === null" class="sl-lock__hint">{{ t('styleLab.lock.needsStyle') }}</p>
      </div>

      <div
        v-if="asking"
        :id="CONFIRM_ID"
        class="sl-lock__confirm"
        role="alertdialog"
        aria-modal="false"
        :aria-labelledby="`${CONFIRM_ID}-title`"
        :aria-describedby="`${CONFIRM_ID}-body`"
        @keydown.esc="dismiss()"
      >
        <p :id="`${CONFIRM_ID}-title`" class="sl-lock__confirm-title">
          <PhWarningDiamond :size="18" weight="fill" aria-hidden="true" />
          {{ t('styleLab.lock.confirmTitle') }}
        </p>
        <p :id="`${CONFIRM_ID}-body`" class="sl-lock__confirm-body">
          {{ t('styleLab.lock.confirmBody') }}
        </p>
        <p class="sl-lock__confirm-name">
          {{ t('styleLab.lock.confirmName', { name: styleName }) }}
        </p>
        <div class="sl-lock__actions">
          <AppButton
            :id="`${CONFIRM_ID}-yes`"
            variant="primary"
            :disabled="lab.locking === 'busy'"
            @click="confirm()"
          >
            {{ t('styleLab.lock.confirm') }}
          </AppButton>
          <AppButton variant="ghost" @click="dismiss()">{{ t('common.cancel') }}</AppButton>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.sl-lock {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.sl-lock__head {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.sl-lock__title {
  font-size: var(--rv-text-lg);
}

.sl-lock__hint {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
  max-inline-size: 44rem;
}

.sl-lock__checksum {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2) var(--rv-space-3);
}

.sl-lock__hash {
  padding-block: 0.125rem;
  padding-inline: var(--rv-space-2);
  border-radius: var(--rv-radius-sm);
  background-color: var(--rv-color-surface-sunken);
  border: var(--rv-border-width) solid var(--rv-color-border);
  unicode-bidi: isolate;
}

.sl-lock__checksum-none {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-faint);
}

.sl-lock__done {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2) var(--rv-space-3);
  padding: var(--rv-space-3);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-success-soft);
  border: var(--rv-border-width) solid var(--rv-color-success);
  color: var(--rv-color-success);
  font-weight: var(--rv-weight-semibold);
}

.sl-lock__when {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-regular);
}

/*
 * The confirmation, inline.
 *
 * `role="alertdialog"` with `aria-modal="false"`: it is announced the moment it appears
 * and focus moves to the affirmative button, but nothing behind it is hidden, because
 * hiding the probe sheet is the last thing to do to someone deciding whether to lock the
 * style that produced it.
 */
.sl-lock__confirm {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  padding: var(--rv-space-4);
  border-radius: var(--rv-radius-lg);
  background-color: var(--rv-color-warning-soft);
  border: var(--rv-border-width) solid var(--rv-color-warning);
  animation: rv-rise-in var(--rv-duration-normal) var(--rv-ease-decelerate) backwards;
}

.sl-lock__confirm-title {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  font-weight: var(--rv-weight-bold);
  color: var(--rv-color-warning);
}

.sl-lock__confirm-body {
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
  max-inline-size: 44rem;
}

.sl-lock__confirm-name {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-semibold);
}

.sl-lock__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-3);
}
</style>
