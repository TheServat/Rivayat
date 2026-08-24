import { describe, expect, it } from 'vitest';

import { StudioApi } from '../../api/client';
import { FixtureTransport } from '../../api/fixtures/fixture-transport';
import { flush, mountStudio } from '../../test/harness';

import ProjectsView from './ProjectsView.vue';

/** A transport that answers `GET /projects` with nothing and accepts creation normally. */
function emptyThenReal(): StudioApi {
  const fixtures = new FixtureTransport();
  let listed = 0;
  return new StudioApi({
    kind: 'http',
    send: (request) => {
      if (request.method === 'GET' && request.path === '/projects' && listed === 0) {
        listed += 1;
        return Promise.resolve(request.schema.parse({ projects: [] }));
      }
      return fixtures.send(request);
    },
    eventSourceUrl: () => null,
  });
}

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

    // Announced, not merely drawn: the skeleton is `aria-hidden`, so without a live
    // region a screen-reader user is told nothing at all while the request is open.
    const announced = wrapper.findAll('[role="status"]').map((node) => node.text());
    expect(announced).toContain('Loading…');
    expect(wrapper.find('table').exists()).toBe(false);
    // A skeleton shaped like the table, so nothing jumps when the rows land.
    expect(wrapper.findAll('.rv-projects__skeleton-row').length).toBeGreaterThan(0);
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

/**
 * The finding that blocked the review: there was no way to start a project.
 *
 * These assert the *capability*, not the markup - a control that opens a form, a form
 * that reaches the API, and a list that afterwards contains what was typed. Gutting the
 * view would fail every one of them.
 */
describe('starting a project', () => {
  it('offers the action from the empty state and from the populated one', async () => {
    const empty = await mountStudio(ProjectsView, {
      locale: 'en',
      path: '/projects',
      api: new StudioApi({
        kind: 'http',
        send: (request) => Promise.resolve(request.schema.parse({ projects: [] })),
        eventSourceUrl: () => null,
      }),
    });
    await flush();
    await empty.vm.$nextTick();

    expect(empty.find('table').exists()).toBe(false);
    // The invitation, not the apology: what the screen is for, and the one action.
    expect(empty.text()).toContain('This is where an idea becomes a series');
    expect(empty.findAll('[aria-controls="rv-new-project-panel"]').length).toBeGreaterThan(0);

    const full = await mountStudio(ProjectsView, { locale: 'en', path: '/projects' });
    await flush();
    await full.vm.$nextTick();

    expect(full.find('table').exists()).toBe(true);
    // A studio whose second project needs a different route from its first has a hidden
    // door; the trigger is present in both states.
    expect(full.findAll('[aria-controls="rv-new-project-panel"]').length).toBeGreaterThan(0);
  });

  it('creates a project from a name and an idea and shows it in the list', async () => {
    const wrapper = await mountStudio(ProjectsView, {
      locale: 'en',
      path: '/projects',
      api: emptyThenReal(),
    });
    await flush();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('The Sealed Well');

    await wrapper.find('[aria-controls="rv-new-project-panel"]').trigger('click');
    await wrapper.vm.$nextTick();

    await wrapper.find('#rv-new-project-name').setValue('The Sealed Well');
    await wrapper.find('#rv-new-project-idea').setValue('Three people, one well, one truth.');
    await wrapper.find('form').trigger('submit');
    await flush(8);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('The Sealed Well');
    // Re-read from the server rather than pushed onto the array: the row is a read model
    // the API joins from four places, and a row assembled here would be a guess.
    expect(wrapper.find('table').exists()).toBe(true);
  });

  it('refuses an empty idea beside the field that caused it, without sending anything', async () => {
    let posted = 0;
    const fixtures = new FixtureTransport();
    const wrapper = await mountStudio(ProjectsView, {
      locale: 'en',
      path: '/projects',
      api: new StudioApi({
        kind: 'http',
        send: (request) => {
          if (request.method === 'POST') posted += 1;
          return fixtures.send(request);
        },
        eventSourceUrl: () => null,
      }),
    });
    await flush();
    await wrapper.vm.$nextTick();

    await wrapper.find('[aria-controls="rv-new-project-panel"]').trigger('click');
    await wrapper.vm.$nextTick();

    await wrapper.find('#rv-new-project-name').setValue('A name but no idea');
    await wrapper.find('form').trigger('submit');
    await flush();
    await wrapper.vm.$nextTick();

    expect(posted).toBe(0);
    expect(wrapper.find('#rv-new-project-idea').attributes('aria-invalid')).toBe('true');
    // The message sits with the field, not in a summary at the top of the form.
    expect(wrapper.find('#rv-new-project-idea-hint').text()).toContain('short sentence');
  });

  it('keeps everything typed when the server refuses the creation', async () => {
    const wrapper = await mountStudio(ProjectsView, {
      locale: 'en',
      path: '/projects',
      api: new StudioApi({
        kind: 'http',
        send: (request) =>
          request.method === 'POST'
            ? Promise.reject(new Error('offline'))
            : Promise.resolve(request.schema.parse({ projects: [] })),
        eventSourceUrl: () => null,
      }),
    });
    await flush();
    await wrapper.vm.$nextTick();

    await wrapper.find('[aria-controls="rv-new-project-panel"]').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('#rv-new-project-name').setValue('Kept');
    await wrapper.find('#rv-new-project-idea').setValue('Every word of this must survive.');
    await wrapper.find('form').trigger('submit');
    await flush(8);
    await wrapper.vm.$nextTick();

    // Losing a filled form to a server error is the single most enraging thing an
    // interface can do, and it is also the moment a retry is most likely to work.
    const name = wrapper.find('#rv-new-project-name').element as HTMLInputElement;
    const idea = wrapper.find('#rv-new-project-idea').element as HTMLTextAreaElement;
    expect(name.value).toBe('Kept');
    expect(idea.value).toBe('Every word of this must survive.');
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });
});

describe('a row that goes somewhere', () => {
  it('makes the project name a link with an accessible name, not bold text', async () => {
    const wrapper = await mountStudio(ProjectsView, { locale: 'en', path: '/projects' });
    await flush();
    await wrapper.vm.$nextTick();

    const links = wrapper.findAll('tbody th[scope="row"] a');
    expect(links.length).toBe(2);

    const first = links[0];
    expect(first).toBeDefined();
    // Style Lab is genuinely the next step: the pipeline is style-first and nothing
    // downstream runs against a project whose bible is not locked.
    expect(first?.attributes('href')).toContain('/style-lab');
    expect(first?.attributes('href')).toContain('project=');
    expect(first?.attributes('aria-label')).toContain('Open project');
  });

  it('says so when a project has no idea recorded, rather than leaving a blank cell', async () => {
    const wrapper = await mountStudio(ProjectsView, { locale: 'en', path: '/projects' });
    await flush();
    await wrapper.vm.$nextTick();

    // The second fixture carries no logline. A blank would read as a rendering bug.
    expect(wrapper.text()).toContain('No idea written down yet');
  });
});

describe('what fills the page below the table', () => {
  it('totals the spend across every row it is showing', async () => {
    const wrapper = await mountStudio(ProjectsView, { locale: 'en', path: '/projects' });
    await flush();
    await wrapper.vm.$nextTick();

    const foot = wrapper.find('tfoot');
    expect(foot.exists()).toBe(true);
    // $1.84 + $0.00, aggregated from the rows on screen rather than fetched separately.
    expect(foot.text()).toContain('$1.84');
    expect(foot.text()).toContain('2 projects');
  });
});
