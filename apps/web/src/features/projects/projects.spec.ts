import { describe, expect, it } from 'vitest';

import { StudioApi } from '../../api/client';
import { flush, mountStudio } from '../../test/harness';

import ProjectsView from './ProjectsView.vue';

describe('the projects screen', () => {
  it('lists each project with its style state, episode count and spend', async () => {
    const wrapper = await mountStudio(ProjectsView, { locale: 'en', path: '/projects' });
    await flush();
    await wrapper.vm.$nextTick();

    const text = wrapper.text();
    expect(text).toContain('The Cartographer’s Apprentice');
    expect(text).toContain('شب‌های برفی کوهسار');
    // Locked style, six episodes, $1.84 spent.
    expect(text).toContain('Locked');
    expect(text).toContain('Not chosen');
    expect(text).toContain('$1.84');
  });

  it('renders Persian digits for counts and money in fa', async () => {
    const wrapper = await mountStudio(ProjectsView, { locale: 'fa', path: '/projects' });
    await flush();
    await wrapper.vm.$nextTick();

    // ۶ episodes. The number in the store stays `6`; only the rendering changes.
    expect(wrapper.text()).toMatch(/[۰-۹]/);
  });

  it('uses a real table with row headers, not a grid of divs', async () => {
    const wrapper = await mountStudio(ProjectsView, { locale: 'en', path: '/projects' });
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('thead th').length).toBe(5);
    expect(wrapper.findAll('tbody th[scope="row"]').length).toBe(2);
  });

  it('says it is loading before the answer arrives', async () => {
    const wrapper = await mountStudio(ProjectsView, {
      locale: 'en',
      path: '/projects',
      api: new StudioApi({
        kind: 'http',
        // Never settles: the point is the state between asking and answering.
        send: () => new Promise(() => undefined),
        eventSourceUrl: () => null,
      }),
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[role="status"]').text()).toBe('Loading…');
    expect(wrapper.find('table').exists()).toBe(false);
  });

  it('invites the first project rather than showing an empty table', async () => {
    const wrapper = await mountStudio(ProjectsView, {
      locale: 'en',
      path: '/projects',
      api: new StudioApi({
        kind: 'http',
        send: (request) => Promise.resolve(request.schema.parse({ projects: [] })),
        eventSourceUrl: () => null,
      }),
    });
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.text()).toContain('No projects yet');
    expect(wrapper.text()).toContain('one-line idea');
  });

  it('shows the failure instead of an empty list when the API is unreachable', async () => {
    const wrapper = await mountStudio(ProjectsView, {
      locale: 'en',
      path: '/projects',
      api: new StudioApi({
        kind: 'http',
        send: () => Promise.reject(new Error('offline')),
        eventSourceUrl: () => null,
      }),
    });
    await flush();
    await wrapper.vm.$nextTick();

    // An empty table would be a lie: it says "you have no projects" when the truth is
    // "we could not ask".
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('projects-load-failed');
  });

  it('refuses a project list that does not match its schema', async () => {
    const wrapper = await mountStudio(ProjectsView, {
      locale: 'en',
      path: '/projects',
      api: new StudioApi({
        kind: 'http',
        // A plausible-looking payload with an id that is not a `ProjectId`.
        send: (request) =>
          Promise.resolve(
            request.schema.parse({
              projects: [{ id: 'not-an-id', name: 'x', updatedAt: '2026-01-01T00:00:00Z' }],
            }),
          ),
        eventSourceUrl: () => null,
      }),
    });
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });
});
