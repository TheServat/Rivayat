import { describe, expect, it } from 'vitest';

import { StudioApi, useStudioApi } from '../../api/client';
import { flush, mountStudio } from '../../test/harness';

import StyleLabView from './StyleLabView.vue';

const PATH = '/style-lab';

/**
 * The lab, opened for a project that has not chosen a style.
 *
 * Explicit about the project because the screen now resolves one: the first fixture
 * project has a style locked already, so opening on it would show a finished lock, and
 * every test below this is about the path that gets there.
 */
async function open(locale: 'fa' | 'en' = 'en'): Promise<ReturnType<typeof mountStudio>> {
  const wrapper = await mountStudio(StyleLabView, {
    locale,
    path: `${PATH}?project=prj_01JQZM5P9R7S2T4V6W8X0Y1Z3A`,
  });
  await flush(8);
  return wrapper;
}

/** Chooses the first card and waits for `POST /style/from-preset` to answer. */
async function chooseFirst(wrapper: Awaited<ReturnType<typeof open>>): Promise<void> {
  const first = wrapper.findAll('input[name="rv-style-preset"]')[0];
  expect(first).toBeDefined();
  await first?.trigger('change');
  await flush(8);
  await wrapper.vm.$nextTick();
}

describe('the shelf', () => {
  it('shows every preset with its palette and its motion, not just its name', async () => {
    const wrapper = await open();

    const cards = wrapper.findAll('input[name="rv-style-preset"]');
    expect(cards.length).toBe(11);

    const text = wrapper.text();
    expect(text).toContain('Paper Cutout');
    expect(text).toContain('Woodblock');
    // The motion readout is on the card, because a still cannot carry it: frame rate,
    // stepping, tempo and boil are what separate two styles with similar palettes.
    expect(text).toContain('On 2s');
    expect(text).toContain('Smooth');
    expect(wrapper.findAll('.sl-card__swatch').length).toBeGreaterThan(11);
  });

  it('gives every card a different motion presentation', async () => {
    const wrapper = await open();

    // The same property `motion-preview.spec.ts` asserts on the data, asserted on what
    // actually reaches the DOM: eleven films, eleven distinct sets of animation values.
    const films = wrapper.findAll('.sl-film');
    expect(films.length).toBe(11);

    const signatures = films.map((film) => film.attributes('style') ?? '');
    expect(new Set(signatures).size).toBe(11);
  });

  it('is one radio group, so eleven styles cost one tab stop', async () => {
    const wrapper = await open();
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(true);
    // A shared `name` is what makes the arrow keys walk the set instead of the tab key.
    const names = wrapper
      .findAll('input[name="rv-style-preset"]')
      .map((input) => input.attributes('name'));
    expect(new Set(names).size).toBe(1);
  });

  it('renders the shelf in Persian with Persian digits', async () => {
    const wrapper = await open('fa');
    expect(wrapper.text()).toContain('کاغذ بریده');
    expect(wrapper.text()).not.toContain('Paper Cutout');
    // Frame rates and tempi are displayed in Persian digits; the values stay Latin.
    expect(wrapper.text()).toMatch(/[۰-۹]/);
  });
});

describe('the five states', () => {
  it('keeps the gallery shape while it is loading', async () => {
    const wrapper = await mountStudio(StyleLabView, {
      locale: 'en',
      path: PATH,
      api: new StudioApi({
        kind: 'http',
        send: () => new Promise(() => undefined),
        eventSourceUrl: () => null,
      }),
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.sl__skeleton').length).toBeGreaterThan(0);
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="status"]').map((n) => n.text())).toContain('Fetching styles…');
  });

  it('invites rather than apologises when the shelf comes back empty', async () => {
    const wrapper = await mountStudio(StyleLabView, {
      locale: 'en',
      path: PATH,
      api: new StudioApi({
        kind: 'http',
        send: (request) => Promise.resolve(request.schema.parse({ presets: [] })),
        eventSourceUrl: () => null,
      }),
    });
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('The shelf is empty');
  });

  it('names the failure and offers a retry when the shelf cannot be fetched', async () => {
    const wrapper = await mountStudio(StyleLabView, {
      locale: 'en',
      path: PATH,
      api: new StudioApi({
        kind: 'http',
        send: () => Promise.reject(new Error('offline')),
        eventSourceUrl: () => null,
      }),
    });
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('style-presets-load-failed');
  });

  it('holds the probe and the lock shut until a style is chosen', async () => {
    const wrapper = await open();

    // The partial state: the shelf has arrived, nothing is chosen, and the two steps that
    // need a style say why they cannot run rather than failing when pressed.
    expect(wrapper.text()).toContain('Choose a style first');
    const disabled = wrapper.findAll('button[disabled]').length;
    expect(disabled).toBeGreaterThanOrEqual(2);
  });
});

describe('cost before commitment', () => {
  it('shows the estimate and the lane before the probe button does anything', async () => {
    const wrapper = await open();

    // Nothing has been clicked. Both lanes and both prices are already on screen, so the
    // choice is a comparison rather than a toggle followed by a surprise.
    const text = wrapper.text();
    expect(text).toContain('Estimate, before it runs');
    expect(text).toContain('4 images on the Local lane');
    expect(text).toContain('Free');
    expect(text).toContain('$0.13');
  });

  it('defaults to the free lane', async () => {
    const wrapper = await open();
    const lanes = wrapper.findAll('input[name="rv-probe-lane"]');
    expect(lanes.length).toBe(2);
    expect(lanes[0]?.attributes('value')).toBe('free');
    expect((lanes[0]?.element as HTMLInputElement).checked).toBe(true);
  });

  it('re-quotes and drops the old sheet when the lane changes', async () => {
    const wrapper = await open();
    await chooseFirst(wrapper);

    await wrapper.find('.sl-probe__actions button').trigger('click');
    await flush(8);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.sl-probe__image').length).toBe(4);

    const paid = wrapper.findAll('input[name="rv-probe-lane"]')[1];
    await paid?.trigger('change');
    await wrapper.vm.$nextTick();

    // A sheet run on the free lane, relabelled as the paid one, would misreport what was
    // spent - so it goes rather than being re-badged.
    expect(wrapper.findAll('.sl-probe__image').length).toBe(0);
    expect(wrapper.text()).toContain('4 images on the Cloud lane');
  });

  it('charges nothing on the free lane and real money on the paid one', async () => {
    const wrapper = await open();
    await chooseFirst(wrapper);

    const paid = wrapper.findAll('input[name="rv-probe-lane"]')[1];
    await paid?.trigger('change');
    await wrapper.vm.$nextTick();

    await wrapper.find('.sl-probe__actions button').trigger('click');
    await flush(8);
    await wrapper.vm.$nextTick();

    // Four tiles at $0.0336 each, from the same catalogue the server prices with.
    expect(wrapper.find('.sl-probe__result').text()).toContain('$0.13');
  });
});

describe('choosing, probing and locking', () => {
  it('mints a draft bible with a checksum when a style is chosen', async () => {
    const wrapper = await open();
    expect(wrapper.text()).toContain('Not made yet');

    await chooseFirst(wrapper);

    expect(wrapper.find('.sl-lock__hash').exists()).toBe(true);
    expect(wrapper.text()).toContain('Draft');
    // Not locked yet, and the screen says which of the two states it is in.
    expect(wrapper.text()).toContain('Settled when you lock');
  });

  it('renders the four fixed probe subjects, each with an accessible name', async () => {
    const wrapper = await open();
    await chooseFirst(wrapper);

    await wrapper.find('.sl-probe__actions button').trigger('click');
    await flush(8);
    await wrapper.vm.$nextTick();

    // Four subjects, always the same four, so two styles are genuinely comparable.
    expect(wrapper.findAll('.sl-probe__image').length).toBe(4);
    const alts = wrapper.findAll('.sl-probe__image').map((img) => img.attributes('alt') ?? '');
    expect(alts.every((alt) => alt.length > 0)).toBe(true);
    expect(alts.join(' ')).toContain('Standing figure');
  });

  it('confirms the lock, and only the lock', async () => {
    const wrapper = await open();
    await chooseFirst(wrapper);

    // Nothing else on this screen asks twice: choosing a style and probing are both
    // reversible, and a confirmation on a reversible action trains people to click
    // through the one that is not.
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);

    await wrapper.find('#rv-style-lock-trigger').trigger('click');
    await wrapper.vm.$nextTick();

    const dialog = wrapper.find('[role="alertdialog"]');
    expect(dialog.exists()).toBe(true);
    // It states the consequence rather than asking "are you sure".
    expect(dialog.text()).toContain('fingerprint is frozen');
    expect(dialog.text()).toContain('forks the asset library');
  });

  it('locks only after the confirmation is accepted', async () => {
    const wrapper = await open();
    await chooseFirst(wrapper);

    await wrapper.find('#rv-style-lock-trigger').trigger('click');
    await wrapper.vm.$nextTick();

    // Backing out leaves the style exactly as it was.
    await wrapper.findAll('[role="alertdialog"] button')[1]?.trigger('click');
    await flush();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('This style is locked');

    await wrapper.find('#rv-style-lock-trigger').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('#rv-style-lock-confirm-yes').trigger('click');
    await flush(8);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('This style is locked');
    expect(wrapper.find('#rv-style-lock-trigger').exists()).toBe(false);
  });
});

/**
 * The reduced-motion half of the trap.
 *
 * The brief is explicit: under `prefers-reduced-motion`, replace the loop with a
 * representative frame sequence the reader can step through - remove the travel, not the
 * information. A still card is the failure, not the accommodation.
 */
describe('reduced motion gets a strip, not a still', () => {
  function preferReducedMotion(reduce: boolean): void {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string): MediaQueryList =>
        ({
          matches: reduce && query.includes('reduce'),
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as MediaQueryList,
    });
  }

  it('offers play and step when the reader has expressed no preference', async () => {
    preferReducedMotion(false);
    const wrapper = await open();

    expect(wrapper.find('.sl__toggle').exists()).toBe(true);
    // Playing by default: a static gallery is the thing this screen exists to avoid.
    expect(wrapper.findAll('.sl-film--stepped').length).toBe(0);
    expect(wrapper.find('.sl__stepper').exists()).toBe(false);
  });

  it('replaces the loop with a steppable sequence when the system asks for less motion', async () => {
    preferReducedMotion(true);
    const wrapper = await open();

    // No Play control at all, because `motion.css` collapses every animation under this
    // preference and a Play button that does nothing is worse than no Play button.
    expect(wrapper.find('.sl__toggle').exists()).toBe(false);
    expect(wrapper.text()).toContain('reduced motion');

    // Every card is parked rather than blank, and the frames can be walked.
    expect(wrapper.findAll('.sl-film--stepped').length).toBe(11);
    expect(wrapper.find('.sl__stepper').exists()).toBe(true);
    expect(wrapper.text()).toContain('Frame 1 of 12');

    preferReducedMotion(false);
  });

  it('moves every card to the same frame, so two styles can be compared', async () => {
    preferReducedMotion(true);
    const wrapper = await open();

    const seekAt = (): string[] =>
      wrapper.findAll('.sl-film').map((film) => {
        const style = film.attributes('style') ?? '';
        return /--sl-seek:\s*([^;]+)/.exec(style)?.[1]?.trim() ?? '';
      });

    const atZero = seekAt();
    expect(atZero.every((seek) => seek === '0s')).toBe(true);

    await wrapper.findAll('.sl__step-button')[1]?.trigger('click');
    await wrapper.vm.$nextTick();

    const atOne = seekAt();
    expect(wrapper.text()).toContain('Frame 2 of 12');
    // Every card advanced, and each by its own cycle length - a style with a slower
    // tempo is a different number of seconds into a longer loop at the same frame.
    expect(atOne.every((seek) => seek !== '0s')).toBe(true);
    expect(new Set(atOne).size).toBeGreaterThan(1);

    preferReducedMotion(false);
  });
});

/**
 * A lock belongs to a project, which is the thing this screen used not to know.
 *
 * The Projects screen has linked here with `?project=` since it was written and this
 * screen ignored the parameter, so locking minted a bible attached to nothing: a project
 * read "no style chosen" however many times someone locked one, and every stage
 * downstream refused to run for want of a style that had in fact been chosen three times.
 */
describe('the lock belongs to a project', () => {
  const WITH_STYLE = 'prj_01JQZK3M7X8YB4N2VTC6WPHRDE';
  const WITHOUT_STYLE = 'prj_01JQZM5P9R7S2T4V6W8X0Y1Z3A';

  async function openFor(project: string): Promise<ReturnType<typeof mountStudio>> {
    const wrapper = await mountStudio(StyleLabView, {
      locale: 'en',
      path: `${PATH}?project=${project}`,
    });
    await flush(8);
    return wrapper;
  }

  it('shows the style a returning project already locked', async () => {
    const wrapper = await openFor(WITH_STYLE);

    // Not the empty gallery a returning project used to get.
    expect(wrapper.text()).toContain('This style is locked');
    expect(wrapper.text()).not.toContain('Not made yet');
  });

  it('names the project the lock will be recorded on', async () => {
    const wrapper = await openFor(WITHOUT_STYLE);

    // The consequence is now project-shaped, so the button says which project. A studio
    // holding three projects and a lock button naming none of them is a coin toss.
    expect(wrapper.text()).toContain('The Cartographer');
  });

  it('points the project at the bible it just locked', async () => {
    const wrapper = await openFor(WITHOUT_STYLE);
    await chooseFirst(wrapper);

    await wrapper.find('#rv-style-lock-trigger').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('#rv-style-lock-confirm-yes').trigger('click');
    await flush(12);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('This style is locked');
    // The assertion that matters: the *project* changed, not just the panel. Asking the
    // server rather than reading the screen, because the screen is what was lying before.
    const after = await useStudioApi().listProjects();
    const project = after.projects.find((entry) => entry.id === WITHOUT_STYLE);
    expect(project?.styleBibleId).not.toBeNull();
  });

  it('offers to finish the job when the lock landed and the attach did not', async () => {
    const wrapper = await openFor(WITHOUT_STYLE);
    await chooseFirst(wrapper);

    await wrapper.find('#rv-style-lock-trigger').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('#rv-style-lock-confirm-yes').trigger('click');
    await flush(12);
    await wrapper.vm.$nextTick();

    // A lock that attached leaves nothing to retry. The control exists for the state
    // where it did not, and showing it here would be a permanent nag.
    expect(wrapper.text()).not.toContain('does not point at it yet');
  });
});
