import { createRouter, createWebHistory, type RouteRecordRaw, type Router } from 'vue-router';

import PlaceholderView from '../features/placeholder/PlaceholderView.vue';
import type { PlaceholderTopic } from '../features/placeholder/topics';
import ProjectsView from '../features/projects/ProjectsView.vue';
import SettingsView from '../features/settings/SettingsView.vue';

/**
 * Every nav entry's message key, so the shell renders the menu from this list rather
 * than from a second, hand-maintained one.
 */
export const NAV_KEYS = {
  projects: 'nav.projects',
  'style-lab': 'nav.styleLab',
  story: 'nav.story',
  characters: 'nav.characters',
  assets: 'nav.assets',
  timeline: 'nav.timeline',
  render: 'nav.render',
  settings: 'nav.settings',
} as const;

export type NavName = keyof typeof NAV_KEYS;

/** `true` for the two screens that are actually built. Rendered as a badge in the nav. */
export const IMPLEMENTED: Readonly<Record<NavName, boolean>> = {
  projects: true,
  'style-lab': false,
  story: false,
  characters: false,
  assets: false,
  timeline: false,
  render: false,
  settings: true,
};

/**
 * Static props for a placeholder route.
 *
 * A function rather than an object literal so `exactOptionalPropertyTypes` sees a
 * definite value: `RouteRecordRaw['props']` includes `undefined`, and a helper typed
 * as that makes every route record optional-props and therefore unassignable.
 */
function placeholder(
  topic: PlaceholderTopic,
  stories: readonly string[],
): () => Record<string, unknown> {
  return () => ({ topic, stories });
}

export const routes: readonly RouteRecordRaw[] = [
  { path: '/', redirect: '/projects' },
  { path: '/projects', name: 'projects', component: ProjectsView },
  {
    path: '/style-lab',
    name: 'style-lab',
    component: PlaceholderView,
    props: placeholder('styleLab', ['RV-204']),
  },
  {
    path: '/story',
    name: 'story',
    component: PlaceholderView,
    props: placeholder('story', ['RV-205']),
  },
  {
    path: '/characters',
    name: 'characters',
    component: PlaceholderView,
    props: placeholder('characters', ['RV-206', 'RV-207']),
  },
  {
    path: '/assets',
    name: 'assets',
    component: PlaceholderView,
    props: placeholder('assets', ['RV-208', 'RV-209', 'RV-210']),
  },
  {
    path: '/timeline',
    name: 'timeline',
    component: PlaceholderView,
    props: placeholder('timeline', ['RV-211', 'RV-212']),
  },
  {
    path: '/render',
    name: 'render',
    component: PlaceholderView,
    props: placeholder('render', ['RV-213', 'RV-214', 'RV-215']),
  },
  { path: '/settings', name: 'settings', component: SettingsView },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../features/placeholder/NotFoundView.vue'),
  },
];

export function createStudioRouter(): Router {
  return createRouter({ history: createWebHistory(), routes: [...routes] });
}
