import type { ProjectId } from '@rv/contracts';
import { defineStore } from 'pinia';
import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useStudioApi } from '../api/client';
import { ApiError, isApiError } from '../api/errors';
import type { ProjectSummary } from '../api/schemas/pending-contracts';
import type { NewProjectDraft } from '../api/schemas/projects';

export type ProjectsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProjectsStore {
  readonly status: Ref<ProjectsStatus>;
  readonly error: Ref<ApiError | null>;
  readonly projects: Ref<readonly ProjectSummary[]>;
  readonly isEmpty: ComputedRef<boolean>;
  readonly totalSpentNanoUsd: ComputedRef<number>;
  readonly creating: Ref<boolean>;
  readonly createError: Ref<ApiError | null>;
  /** The id of the project this session just made, so the list can point at its row. */
  readonly createdId: Ref<ProjectId | null>;
  load: () => Promise<void>;
  create: (draft: NewProjectDraft) => Promise<boolean>;
}

/**
 * The project list.
 *
 * The store fetches and holds; it does not transform for display. Formatting money and
 * dates depends on the active locale, which is a rendering concern the view owns - a
 * store that pre-formatted them would have to be reloaded to switch language.
 */
export const useProjectsStore = defineStore('projects', (): ProjectsStore => {
  const status = ref<ProjectsStatus>('idle');
  const error = ref<ApiError | null>(null);
  const projects = ref<readonly ProjectSummary[]>([]);
  const creating = ref(false);
  const createError = ref<ApiError | null>(null);
  const createdId = ref<ProjectId | null>(null);

  const isEmpty = computed(() => status.value === 'ready' && projects.value.length === 0);
  const totalSpentNanoUsd = computed(() =>
    projects.value.reduce((sum, project) => sum + project.spentNanoUsd, 0),
  );

  async function load(): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const list = await useStudioApi().listProjects();
      projects.value = list.projects;
      status.value = 'ready';
    } catch (caught) {
      status.value = 'error';
      error.value = isApiError(caught)
        ? caught
        : new ApiError({
            failure: 'network',
            code: 'projects-load-failed',
            message: 'the project list could not be loaded',
            cause: caught,
          });
    }
  }

  /**
   * Starts a project, then re-reads the list.
   *
   * Re-read rather than push the created aggregate onto the array, because a row is a
   * *read model* the server joins from four places - episodes, runs, the style bible and
   * the project - and a row assembled on the client would be the studio guessing at
   * three of them. It guesses right today, when everything is zero, and wrong the first
   * time a project is created with anything attached to it.
   *
   * Returns whether it worked, so the form knows whether to close. The form keeps its
   * contents on failure: losing a typed paragraph to a 500 is the single most enraging
   * thing this interface could do.
   */
  async function create(draft: NewProjectDraft): Promise<boolean> {
    creating.value = true;
    createError.value = null;
    try {
      const created = await useStudioApi().createProject(draft);
      createdId.value = created.id;
      await load();
      return true;
    } catch (caught) {
      createError.value = isApiError(caught)
        ? caught
        : new ApiError({
            failure: 'network',
            code: 'project-create-failed',
            message: 'the project could not be created',
            cause: caught,
          });
      return false;
    } finally {
      creating.value = false;
    }
  }

  return {
    status,
    error,
    projects,
    isEmpty,
    totalSpentNanoUsd,
    creating,
    createError,
    createdId,
    load,
    create,
  };
});
