import { createRouter, createWebHistory, type RouteRecordRaw, type Router } from 'vue-router';

import AssetsView from '../features/assets/AssetsView.vue';
import CharactersView from '../features/characters/CharactersView.vue';
import ProjectsView from '../features/projects/ProjectsView.vue';
import RenderView from '../features/render/RenderView.vue';
import SettingsView from '../features/settings/SettingsView.vue';
import StoryView from '../features/story/StoryView.vue';
import StyleLabView from '../features/style-lab/StyleLabView.vue';
import TimelineView from '../features/timeline/TimelineView.vue';

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

/**
 * Which sections are built. Rendered as a badge in the nav.
 *
 * All eight, as of the six screens landing. Kept as a map rather than deleted because
 * the nav reads it, and because a ninth section will start life as `false`.
 */
export const IMPLEMENTED: Readonly<Record<NavName, boolean>> = {
  projects: true,
  'style-lab': true,
  story: true,
  characters: true,
  assets: true,
  timeline: true,
  render: true,
  settings: true,
};

export const routes: readonly RouteRecordRaw[] = [
  { path: '/', redirect: '/projects' },
  { path: '/projects', name: 'projects', component: ProjectsView },
  { path: '/style-lab', name: 'style-lab', component: StyleLabView },
  { path: '/story', name: 'story', component: StoryView },
  { path: '/characters', name: 'characters', component: CharactersView },
  { path: '/assets', name: 'assets', component: AssetsView },
  { path: '/timeline', name: 'timeline', component: TimelineView },
  { path: '/render', name: 'render', component: RenderView },
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
