import { defineStore } from 'pinia';
import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useStudioApi } from '../api/client';
import { ApiError, isApiError } from '../api/errors';
import type { ProjectSummary } from '../api/schemas/pending-contracts';

export type ProjectsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProjectsStore {
  readonly status: Ref<ProjectsStatus>;
  readonly error: Ref<ApiError | null>;
  readonly projects: Ref<readonly ProjectSummary[]>;
  readonly isEmpty: ComputedRef<boolean>;
  readonly totalSpentNanoUsd: ComputedRef<number>;
  load: () => Promise<void>;
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

  return { status, error, projects, isEmpty, totalSpentNanoUsd, load };
});
