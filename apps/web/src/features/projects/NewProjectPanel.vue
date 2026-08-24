<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';

import { NewProjectDraft } from '../../api/schemas/projects';
import AppButton from '../../components/AppButton.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import { useProjectsStore } from '../../stores/projects.store';

/**
 * The form that turns a one-line idea into a project.
 *
 * A panel rather than a modal, deliberately. A modal needs a focus trap, a scroll lock
 * and an escape hatch and buys nothing here: nothing is destructive and nothing behind
 * it must be protected. It is also the honest shape for the empty state, where this form
 * *is* the screen rather than something covering it.
 *
 * Two fields. `Project` also carries a spending ceiling and it is not here: the machine
 * layer supplies a working default, the settings screen edits it at project scope, and
 * an invitation with three fields is a form. What a person arrives with is a name and an
 * idea.
 *
 * The panel owns the form and not its own visibility - the view does, because two
 * different triggers open it (the header and the empty state) and focus has to return to
 * whichever one was used.
 */
const emit = defineEmits<{ close: []; created: [name: string] }>();

const { t } = useI18n();
const projects = useProjectsStore();

const name = ref('');
const idea = ref('');
/** Which fields the person has finished with. Errors show on blur, never per keystroke. */
const touched = ref<ReadonlySet<'name' | 'idea'>>(new Set());

const nameField = useTemplateRef<HTMLInputElement>('nameField');

onMounted(() => {
  nameField.value?.focus();
});

/**
 * Validated against the schema the request is sent with.
 *
 * `NewProjectDraft` is composed from `Label` and `Prose`, which is where the bounds come
 * from, so the field refuses exactly what the server refuses rather than what this
 * component guesses the server refuses.
 */
function fieldError(field: 'name' | 'idea'): string {
  const value = field === 'name' ? name.value : idea.value;
  const schema = field === 'name' ? NewProjectDraft.shape.name : NewProjectDraft.shape.description;
  if (schema.safeParse(value).success) return '';
  if (value.trim().length === 0) {
    return field === 'name' ? t('projects.new.nameRequired') : t('projects.new.ideaRequired');
  }
  return t('projects.new.tooLong');
}

const nameError = computed(() => (touched.value.has('name') ? fieldError('name') : ''));
const ideaError = computed(() => (touched.value.has('idea') ? fieldError('idea') : ''));
const valid = computed(() => fieldError('name') === '' && fieldError('idea') === '');

/**
 * A field the server itself named as the reason it refused.
 *
 * The error envelope carries `issues[].path`, and `description` is the schema's word for
 * what the interface calls "the idea" - so the mapping happens here, once, rather than
 * the label being renamed to match the wire.
 */
function serverRejected(field: 'name' | 'idea'): boolean {
  const path = field === 'name' ? 'name' : 'description';
  return projects.createError?.issues.some((issue) => issue.path === path) ?? false;
}

function touch(field: 'name' | 'idea'): void {
  touched.value = new Set([...touched.value, field]);
}

async function submit(): Promise<void> {
  touch('name');
  touch('idea');
  if (!valid.value || projects.creating) return;

  const created = await projects.create(
    NewProjectDraft.parse({ name: name.value, description: idea.value }),
  );
  // Nothing is cleared on failure. Losing a typed paragraph to a 500 is the single most
  // enraging thing an interface can do, and it is also the moment a retry is most likely
  // to work.
  if (!created) return;

  emit('created', name.value.trim());
  name.value = '';
  idea.value = '';
  touched.value = new Set();
}
</script>

<template>
  <section
    id="rv-new-project-panel"
    class="rv-newproject rv-sheet"
    :aria-label="t('projects.new.title')"
    @keydown.esc="emit('close')"
  >
    <h2 class="rv-newproject__title">{{ t('projects.new.title') }}</h2>
    <p class="rv-newproject__intro">{{ t('projects.new.intro') }}</p>

    <form class="rv-newproject__form" novalidate @submit.prevent="submit()">
      <div class="rv-newproject__field">
        <label class="rv-newproject__label" for="rv-new-project-name">
          {{ t('projects.new.nameLabel') }}
        </label>
        <input
          id="rv-new-project-name"
          ref="nameField"
          v-model="name"
          class="rv-newproject__input"
          type="text"
          :maxlength="120"
          autocomplete="off"
          :aria-invalid="nameError !== '' || serverRejected('name')"
          aria-describedby="rv-new-project-name-hint"
          @blur="touch('name')"
        />
        <p id="rv-new-project-name-hint" class="rv-newproject__hint">
          {{ nameError === '' ? t('projects.new.nameHint') : nameError }}
        </p>
      </div>

      <div class="rv-newproject__field">
        <label class="rv-newproject__label" for="rv-new-project-idea">
          {{ t('projects.new.ideaLabel') }}
        </label>
        <textarea
          id="rv-new-project-idea"
          v-model="idea"
          class="rv-newproject__input rv-newproject__input--area"
          rows="3"
          :placeholder="t('projects.new.ideaPlaceholder')"
          :aria-invalid="ideaError !== '' || serverRejected('idea')"
          aria-describedby="rv-new-project-idea-hint"
          @blur="touch('idea')"
        ></textarea>
        <p id="rv-new-project-idea-hint" class="rv-newproject__hint">
          {{ ideaError === '' ? t('projects.new.ideaHint') : ideaError }}
        </p>
      </div>

      <ErrorNotice v-if="projects.createError" :error="projects.createError" @retry="submit()" />

      <div class="rv-newproject__actions">
        <AppButton type="submit" variant="primary" :disabled="projects.creating">
          {{ projects.creating ? t('projects.new.submitting') : t('projects.new.submit') }}
        </AppButton>
        <AppButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</AppButton>
      </div>
    </form>
  </section>
</template>

<style scoped>
.rv-newproject {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  padding: var(--rv-space-5);
  animation: rv-rise-in var(--rv-duration-normal) var(--rv-ease-decelerate) backwards;
}

.rv-newproject__title {
  font-size: var(--rv-text-lg);
}

.rv-newproject__intro {
  color: var(--rv-color-text-muted);
  max-inline-size: 44rem;
}

.rv-newproject__form {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
  max-inline-size: 40rem;
}

.rv-newproject__field {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-newproject__label {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-semibold);
}

/* The 3:1 boundary WCAG 2.2 asks of a control comes from `border-strong`, which is
   measured against every surface in `tokens.spec.ts` rather than eyeballed. */
.rv-newproject__input {
  min-block-size: 2.5rem;
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  background-color: var(--rv-color-surface-raised);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  color: var(--rv-color-text);
}

.rv-newproject__input--area {
  min-block-size: 5rem;
  resize: vertical;
  line-height: var(--rv-leading-snug);
}

.rv-newproject__input[aria-invalid='true'] {
  border-color: var(--rv-color-danger);
}

.rv-newproject__hint {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

/*
 * The hint slot carries the error, so the message sits with the field that caused it
 * rather than in a summary at the top. Colour is never the only signal: the sentence
 * itself changes, and `aria-invalid` carries the state to assistive technology.
 */
.rv-newproject__input[aria-invalid='true'] + .rv-newproject__hint {
  color: var(--rv-color-danger);
  font-weight: var(--rv-weight-medium);
}

.rv-newproject__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--rv-space-2);
}
</style>
