import { FORMAT_PRESETS } from '@rv/contracts';
import type { VueWrapper } from '@vue/test-utils';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StudioApi } from '../../api/client';
import type { StudioTransport } from '../../api/transport';
import { flush, mountStudio } from '../../test/harness';

import RenderView from './RenderView.vue';
import {
  apiFailure,
  costFixture,
  FakeEventSource,
  FORMAT_PAYLOAD,
  PROJECT_ID,
  PROJECT_PAYLOAD,
  runFixture,
  stubTransport,
  type StubRoute,
} from './__fixtures__/render.fixtures';

const RUNS = `/projects/${PROJECT_ID}/runs`;
const COST = `/projects/${PROJECT_ID}/cost`;

function routes(overrides: Readonly<Record<string, StubRoute>> = {}): Record<string, StubRoute> {
  return {
    '/render/formats': { payload: FORMAT_PAYLOAD },
    '/projects': { payload: PROJECT_PAYLOAD },
    [RUNS]: { payload: [runFixture()] },
    [COST]: { payload: costFixture() },
    ...overrides,
  };
}

function api(overrides?: Readonly<Record<string, StubRoute>>): StudioApi {
  return new StudioApi(stubTransport(routes(overrides)));
}

/** A transport that never settles, so the loading state can be observed. */
function pendingTransport(): StudioTransport {
  return {
    kind: 'http',
    eventSourceUrl: () => null,
    send: () => new Promise(() => undefined),
  };
}

const mounted: VueWrapper[] = [];

/**
 * jsdom ships no `EventSource`, and `test/setup.ts` leaves it absent on purpose so a
 * spec that cares about the stream installs its own rather than inheriting one another
 * spec forgot to remove. This is that installation.
 */
beforeEach(() => {
  FakeEventSource.opened.length = 0;
  Object.defineProperty(globalThis, 'EventSource', {
    writable: true,
    configurable: true,
    value: FakeEventSource,
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'EventSource');
});

async function open(
  options: {
    locale?: 'fa' | 'en';
    api?: StudioApi;
  } = {},
): Promise<VueWrapper> {
  const wrapper = await mountStudio(RenderView, {
    locale: options.locale ?? 'en',
    path: '/render',
    api: options.api ?? api(),
  });
  await flush(60);
  mounted.push(wrapper);
  return wrapper;
}

afterEach(() => {
  // `useNow` holds a one-second interval; leaving one per test behind makes the suite
  // slower every time a test is added.
  while (mounted.length > 0) mounted.pop()?.unmount();
});

describe('the seven delivery targets', () => {
  it('shows one card per verified platform spec', async () => {
    const wrapper = await open();
    const cards = wrapper.findAll('[data-format]');
    expect(cards).toHaveLength(7);
    expect(cards.map((card) => card.attributes('data-format')).toSorted()).toEqual(
      Object.keys(FORMAT_PRESETS).toSorted(),
    );
  });

  it('draws each safe area at the platform’s real pixel geometry', async () => {
    const wrapper = await open();
    // Research 7: 900x1400 centred inside 1080x1920. Read back off the DOM, so the
    // assertion is against what a user is actually shown rather than against a helper.
    const shorts = wrapper.get('[data-format="shorts-9x16"]');
    expect(shorts.get('svg').attributes('viewBox')).toBe('0 0 1080 1920');
    const safe = shorts.get('.rv-frame__safe');
    expect({
      x: safe.attributes('x'),
      y: safe.attributes('y'),
      width: safe.attributes('width'),
      height: safe.attributes('height'),
    }).toEqual({ x: '90', y: '260', width: '900', height: '1400' });
  });

  it('draws no separate safe box for a format whose whole frame is safe', async () => {
    const wrapper = await open();
    const youtube = wrapper.get('[data-format="yt-1080p"]');
    expect(youtube.find('.rv-frame__safe').exists()).toBe(false);
    expect(youtube.text()).toContain('The whole frame is safe');
  });

  it('names TikTok’s three exclusion zones and reports their union, not their sum', async () => {
    const wrapper = await open();
    const tiktok = wrapper.get('[data-format="tiktok-9x16"]');
    expect(tiktok.findAll('.rv-frame__chrome')).toHaveLength(3);

    const zones = tiktok.findAll('.rv-format__zones li').map((node) => node.text());
    expect(zones).toEqual(['Top bar', 'Caption rail', 'Action rail']);

    // 1 - (0.65 x 0.85) = 44.75 %, which rounds to 45 %. The sum of the three would be
    // 50 %, and reporting that overstates how much of the frame is unusable.
    expect(tiktok.text()).toContain('covers 45% of the frame');
  });

  it('states the length limit each platform actually publishes', async () => {
    const wrapper = await open();
    expect(wrapper.get('[data-format="shorts-9x16"]').text()).toContain('Up to 3 minutes');
    expect(wrapper.get('[data-format="reels-9x16"]').text()).toContain('Up to 90 seconds');
    expect(wrapper.get('[data-format="tiktok-9x16"]').text()).toContain('Up to 10 minutes');
    expect(wrapper.get('[data-format="yt-1080p"]').text()).toContain('No length limit');
  });

  it('separates the codec we encode from the codecs the platform accepts', async () => {
    const wrapper = await open();
    // Reels is H.264 only, so there is nothing extra to say; TikTok also takes H.265.
    expect(wrapper.get('[data-format="tiktok-9x16"]').text()).toContain('h264 · h265');
    expect(wrapper.get('[data-format="reels-9x16"]').text()).not.toContain('The platform accepts');
  });
});

describe('the preview does not mirror, because a delivered frame does not', () => {
  it('puts TikTok’s action rail on the same side in Persian as in English', async () => {
    const geometry = async (locale: 'fa' | 'en'): Promise<Record<string, string | undefined>[]> => {
      const wrapper = await open({ locale });
      return wrapper
        .get('[data-format="tiktok-9x16"]')
        .findAll('.rv-frame__chrome')
        .map((node) => ({
          x: node.attributes('x'),
          y: node.attributes('y'),
          width: node.attributes('width'),
          height: node.attributes('height'),
        }));
    };

    const rtl = await geometry('fa');
    const ltr = await geometry('en');

    // The action rail is at x=918 of 1080 in both. A layout built on logical properties
    // would flip it, and the preview would then promise a Persian creator that the left
    // of frame is unsafe - which is the opposite of the truth, in the one locale this
    // studio is used in.
    expect(rtl).toEqual(ltr);
    expect(rtl[2]).toEqual({ x: '918', y: '0', width: '162', height: '1920' });
  });

  it('renders the same elements in both directions', async () => {
    const structure = async (locale: 'fa' | 'en'): Promise<string[]> => {
      const wrapper = await open({ locale });
      return wrapper.findAll('[data-format]').map((node) => node.attributes('data-format') ?? '');
    };
    expect(await structure('fa')).toEqual(await structure('en'));
  });

  it('renders Persian numerals in Persian and Latin ones in English', async () => {
    const fa = await open({ locale: 'fa' });
    const en = await open({ locale: 'en' });
    expect(fa.get('[data-format="shorts-9x16"]').text()).toContain('۱۰۸۰');
    expect(en.get('[data-format="shorts-9x16"]').text()).toContain('1080');
  });
});

describe('choosing targets', () => {
  it('starts with every target selected, because seven deliverables is the product', async () => {
    const wrapper = await open();
    const boxes = wrapper.findAll<HTMLInputElement>('.rv-format__check');
    expect(boxes).toHaveLength(7);
    expect(boxes.every((box) => box.element.checked)).toBe(true);
    expect(wrapper.get('.rv-gallery__count').text()).toContain('7 of 7');
  });

  it('unselects one target without hiding its spec', async () => {
    const wrapper = await open();
    await wrapper.get('[data-format="ig-1x1"] .rv-format__check').setValue(false);
    await flush();

    expect(wrapper.get('.rv-gallery__count').text()).toContain('6 of 7');
    // Still on screen: the seven specs are what the comparison is for, and hiding six
    // of them the moment they are deselected destroys it.
    expect(wrapper.findAll('[data-format]')).toHaveLength(7);
  });

  it('clears and restores the whole selection from the header', async () => {
    const wrapper = await open();
    await wrapper.get('.rv-gallery__actions button:last-of-type').trigger('click');
    await flush();
    expect(wrapper.get('.rv-gallery__count').text()).toContain('No target selected');

    await wrapper.get('.rv-gallery__actions button:first-of-type').trigger('click');
    await flush();
    expect(wrapper.get('.rv-gallery__count').text()).toContain('7 of 7');
  });

  it('keeps a narrowed selection in the address, so the choice survives a reload', async () => {
    const wrapper = await open();
    await wrapper.get('[data-format="ig-1x1"] .rv-format__check').setValue(false);
    await flush(40);
    expect(globalThis.location.search).toContain('formats=');
    expect(globalThis.location.search).not.toContain('ig-1x1');
  });
});

describe('the five states', () => {
  it('shows skeletons shaped like the cards while the specs are loading', async () => {
    const wrapper = await mountStudio(RenderView, {
      locale: 'en',
      path: '/render',
      api: new StudioApi(pendingTransport()),
    });
    mounted.push(wrapper);
    await flush();

    expect(wrapper.findAll('.rv-gallery__ghost')).toHaveLength(7);
    expect(wrapper.findAll('[data-format]')).toHaveLength(0);
    expect(wrapper.find('[role="status"]').exists()).toBe(true);
  });

  it('names what failed and offers a retry that asks again', async () => {
    let attempts = 0;
    const transport: StudioTransport = {
      kind: 'http',
      eventSourceUrl: () => null,
      send: async (request) => {
        await Promise.resolve();
        if (request.path === '/render/formats') {
          attempts += 1;
          throw apiFailure('render.formats-unavailable', 'the format table is unavailable');
        }
        if (request.path === '/projects') return request.schema.parse(PROJECT_PAYLOAD);
        if (request.path === RUNS) return request.schema.parse([runFixture()]);
        if (request.path === COST) return request.schema.parse(costFixture());
        throw apiFailure('unexpected', request.path);
      },
    };

    const wrapper = await mountStudio(RenderView, {
      locale: 'en',
      path: '/render',
      api: new StudioApi(transport),
    });
    mounted.push(wrapper);
    await flush(60);

    expect(attempts).toBe(1);
    const notice = wrapper.get('[role="alert"]');
    expect(notice.text()).toContain('render.formats-unavailable');

    await notice.get('button').trigger('click');
    await flush(8);
    expect(attempts).toBe(2);
  });

  it('invites the first project when the workspace has none', async () => {
    const wrapper = await open({ api: api({ '/projects': { payload: { projects: [] } } }) });
    expect(wrapper.text()).toContain('No project has been created yet');
    // The specs are still worth reading with no project at all, so they stay.
    expect(wrapper.findAll('[data-format]')).toHaveLength(7);
  });

  it('keeps the usable half when only the ledger fails', async () => {
    const wrapper = await open({
      api: api({ [COST]: { error: apiFailure('cost.unavailable', 'the ledger is unavailable') } }),
    });

    // Partial: seven previews, a run monitor, and one panel that says why it is empty.
    expect(wrapper.findAll('[data-format]')).toHaveLength(7);
    expect(wrapper.text()).toContain('Delivery run');
    expect(wrapper.text()).toContain('cost.unavailable');
  });

  it('says a project has no runs yet rather than showing an empty monitor', async () => {
    const wrapper = await open({ api: api({ [RUNS]: { payload: [] } }) });
    expect(wrapper.text()).toContain('No run has been recorded for this project yet');
    expect(wrapper.find('.rv-run__select').exists()).toBe(false);
  });
});

describe('a run that takes minutes', () => {
  it('offers cancel while it is going, and resume as the rescue for a killed worker', async () => {
    // A run whose worker was killed leaves a row that still says `running` with nothing
    // behind it. The runner's documented path back is to record `WORKER_LOST` and
    // re-queue, so the button has to exist in this state - restricting it to `failed`
    // makes the one render a user most needs to rescue the one they cannot.
    const wrapper = await open();
    const buttons = wrapper.findAll('.rv-run__controls button').map((node) => node.text());
    expect(buttons).toContain('Cancel run');
    expect(buttons).toContain('Resume from checkpoint');
    expect(wrapper.text()).toContain('If the render stopped without finishing');
    expect(wrapper.text()).toContain('You can close this page');

    // Cancel stays the loud one: resuming a run that really is executing is refused.
    const resume = wrapper
      .findAll('.rv-run__controls button')
      .find((node) => node.text().includes('Resume'));
    expect(resume?.classes()).toContain('rv-button--secondary');
  });

  it('offers resume for a failed run and cancel for neither', async () => {
    const failed = runFixture({
      status: 'failed',
      errorCode: 'VALIDATION_FAILED',
      finishedAt: '2026-08-23T18:53:40.948Z',
      stages: [
        {
          stage: 'render',
          status: 'failed',
          costNanoUsd: 0,
          durationMs: 2,
          artifacts: [],
          errorCode: 'VALIDATION_FAILED',
          inputHash: '31f3efc225d01e7363324e4588c4355adc5b1e2b8118370b6d989447f05298fa',
          deliveredMs: null,
        },
      ],
    });
    const wrapper = await open({ api: api({ [RUNS]: { payload: [failed] } }) });

    const buttons = wrapper.findAll('.rv-run__controls button').map((node) => node.text());
    expect(buttons).toContain('Resume from checkpoint');
    expect(buttons).not.toContain('Cancel run');
    expect(wrapper.text()).toContain('VALIDATION_FAILED');
    // The stage banked an input hash, which is the whole reason resume is cheap.
    expect(wrapper.text()).toContain('Has a checkpoint');
  });

  it('offers neither for a cancelled run, because cancelled has no outgoing edge', async () => {
    const cancelled = runFixture({ status: 'cancelled', finishedAt: '2026-08-23T18:55:00.000Z' });
    const wrapper = await open({ api: api({ [RUNS]: { payload: [cancelled] } }) });
    expect(wrapper.findAll('.rv-run__controls button')).toHaveLength(0);
    // The exit is still named: continuing is a new run, and it reuses the frames.
    expect(wrapper.text()).toContain('You stopped this run');
    expect(wrapper.text()).toContain('nothing is drawn twice');
  });

  it('never makes a run someone stopped look like a run that broke', async () => {
    const stopped = runFixture({ status: 'cancelled', finishedAt: '2026-08-23T18:55:00.000Z' });
    const broke = runFixture({
      status: 'failed',
      errorCode: 'WORKER_LOST',
      finishedAt: '2026-08-23T18:55:00.000Z',
    });

    const stoppedView = await open({ api: api({ [RUNS]: { payload: [stopped] } }) });
    const brokeView = await open({ api: api({ [RUNS]: { payload: [broke] } }) });

    // Different word, different tone, different exit. The six states exist precisely so
    // these two are not one, and a UI that renders them alike throws that away.
    expect(stoppedView.get('.rv-run__summary .rv-badge').text()).toBe('Cancelled');
    expect(brokeView.get('.rv-run__summary .rv-badge').text()).toBe('Failed');
    expect(stoppedView.get('.rv-run__summary .rv-badge').classes()).toContain('rv-badge--neutral');
    expect(brokeView.get('.rv-run__summary .rv-badge').classes()).toContain('rv-badge--danger');

    // And the progress bar, which is the largest thing on the panel, is not painted in
    // the colour of a run that went well.
    expect(stoppedView.get('[role="progressbar"]').attributes('data-status')).toBe('cancelled');
    expect(brokeView.get('[role="progressbar"]').attributes('data-status')).toBe('failed');

    expect(stoppedView.find('.rv-run__note--broke').exists()).toBe(false);
    expect(brokeView.find('.rv-run__note--broke').exists()).toBe(true);
    expect(stoppedView.find('.rv-run__error').exists()).toBe(false);
    expect(brokeView.text()).toContain('WORKER_LOST');
  });

  it('sends cancel to the run the user is looking at', async () => {
    const seen: string[] = [];
    const cancelled = runFixture({ status: 'cancelled', finishedAt: '2026-08-23T18:55:00.000Z' });
    const transport: StudioTransport = {
      kind: 'http',
      eventSourceUrl: () => null,
      send: async (request) => {
        await Promise.resolve();
        seen.push(`${request.method} ${request.path}`);
        const table = routes({ [`/runs/${runFixture().id}/cancel`]: { payload: cancelled } });
        const route = table[request.path.split('?')[0] ?? ''];
        if (route === undefined || 'error' in route) throw apiFailure('missing', request.path);
        return request.schema.parse(route.payload);
      },
    };

    const wrapper = await mountStudio(RenderView, {
      locale: 'en',
      path: '/render',
      api: new StudioApi(transport),
    });
    mounted.push(wrapper);
    await flush(60);

    await wrapper.get('.rv-run__controls button').trigger('click');
    await flush(8);

    expect(seen).toContain(`POST /runs/${runFixture().id}/cancel`);
    expect(wrapper.text()).toContain('Cancelled');
  });

  it('shows what a failed action was refused for and leaves the run as the server has it', async () => {
    const failed = runFixture({ status: 'failed', finishedAt: '2026-08-23T18:53:40.948Z' });
    const wrapper = await open({
      api: api({
        [RUNS]: { payload: [failed] },
        [`/runs/${failed.id}/resume`]: {
          error: apiFailure('CONFLICT', 'Run is already failed and cannot be resumed'),
        },
      }),
    });

    await wrapper.get('.rv-run__controls button').trigger('click');
    await flush(8);

    expect(wrapper.text()).toContain('CONFLICT');
    expect(wrapper.text()).toContain('Failed');
  });

  it('reports progress from the record when there is no stream to read', async () => {
    const half = runFixture({
      requestedStages: ['render', 'deliver'],
      status: 'running',
      stages: [
        {
          stage: 'render',
          status: 'succeeded',
          costNanoUsd: 0,
          durationMs: 12_000,
          artifacts: ['render-artifact:demo/grove-16x9.mp4'],
          errorCode: null,
          inputHash: 'a'.repeat(64),
          deliveredMs: 90_000,
        },
      ],
    });
    const wrapper = await open({ api: api({ [RUNS]: { payload: [half] } }) });

    // One of two stages finished.
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
    expect(wrapper.text()).toContain('demo/grove-16x9.mp4');
  });
});

describe('watching a run happen', () => {
  it('opens the stream for a live run and folds what it sends into the monitor', async () => {
    const wrapper = await open();
    const source = FakeEventSource.opened.at(-1);
    expect(source, 'a live run should be followed').toBeDefined();
    if (source === undefined) return;

    source.open();
    await flush();
    expect(wrapper.text()).toContain('Live');

    source.emit({
      type: 'stage-progress',
      runId: runFixture().id,
      stage: 'render',
      progress: 0.5,
      detail: null,
      item: { kind: 'frame', key: '900', index: 900, total: 1800 },
      seq: 1,
      at: '2026-08-23T18:54:00.000Z',
    });
    await flush(4);

    // Half of the first of two stages.
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('25');
  });

  it('does not follow a run that has already finished', async () => {
    const done = runFixture({ status: 'succeeded', finishedAt: '2026-08-23T18:57:00.000Z' });
    await open({ api: api({ [RUNS]: { payload: [done] } }) });
    expect(FakeEventSource.opened).toHaveLength(0);
  });

  it('shows an issue once, not once per reconnect', async () => {
    const wrapper = await open();
    const source = FakeEventSource.opened.at(-1);
    if (source === undefined) throw new Error('no stream');
    source.open();

    const raised = {
      type: 'issue-raised' as const,
      runId: runFixture().id,
      stage: 'render' as const,
      severity: 'warning' as const,
      code: 'reframe.needs-review',
      message: 'a shot could not hold its focus inside the TikTok safe area',
      seq: 1,
      at: '2026-08-23T18:54:13.000Z',
    };
    source.emit(raised);
    source.drop();
    source.open();
    // The server replays history to a reconnecting socket. The monitor must not grow.
    source.emit(raised);
    await flush(4);

    expect(wrapper.findAll('.rv-run__issues li')).toHaveLength(1);
  });
});

describe('cost per delivered minute', () => {
  it('leads with the per-minute figure rather than the run total', async () => {
    const wrapper = await open();
    const headline = wrapper.get('.rv-cost__figure--headline');
    expect(headline.text()).toContain('Cost per delivered minute');
    expect(headline.text()).toContain('$1.00');
  });

  it('says no minutes were delivered rather than reporting a rate of zero', async () => {
    const wrapper = await open({
      api: api({
        [COST]: {
          payload: costFixture({
            runs: [],
            deliveredMs: 0,
            nanoUsdPerDeliveredMinute: null,
            summary: {
              total: {
                calls: 0,
                failures: 0,
                inputTokens: 0,
                outputTokens: 0,
                images: 0,
                costNanoUsd: 0,
              },
              byProvider: {},
              byModel: {},
              byTask: {},
              byStage: {},
            },
          }),
        },
      }),
    });

    const headline = wrapper.get('.rv-cost__figure--headline');
    expect(headline.text()).toContain('No minutes delivered yet');
    expect(headline.text()).not.toContain('$0.00');
  });
});

describe('accessibility of the controls', () => {
  it('gives every checkbox a label that names its format', async () => {
    const wrapper = await open();
    for (const card of wrapper.findAll('[data-format]')) {
      const box = card.get('input[type="checkbox"]');
      const id = box.attributes('id');
      expect(id).toBeTruthy();
      const label = card.get(`label[for="${String(id)}"]`);
      expect(label.text().length).toBeGreaterThan(0);
    }
  });

  it('describes the progress bar for a reader that cannot see it', async () => {
    const wrapper = await open();
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes('aria-valuemin')).toBe('0');
    expect(bar.attributes('aria-valuemax')).toBe('100');
    expect(bar.attributes('aria-valuetext')).toBeTruthy();
  });

  it('never leaves a heading level out of order', async () => {
    const wrapper = await open();
    const levels = wrapper
      .findAll('h1, h2, h3')
      .map((node) => Number(node.element.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    for (const [index, level] of levels.entries()) {
      if (index === 0) continue;
      expect(level - (levels[index - 1] ?? 1)).toBeLessThanOrEqual(1);
    }
  });
});

describe('the address bar carries the run', () => {
  it('records the project and the run, so the page can be left and returned to', async () => {
    await open();
    await flush(8);
    expect(globalThis.location.search).toContain(`project=${PROJECT_ID}`);
    expect(globalThis.location.search).toContain(`run=${runFixture().id}`);
  });

  it('reopens on the run the address names rather than the newest one', async () => {
    const older = runFixture({
      id: 'run_01M0QZJ49MJYCB8W86NVBMBTT3',
      status: 'succeeded',
      startedAt: '2026-08-20T10:00:00.000Z',
      finishedAt: '2026-08-20T10:04:00.000Z',
    });
    const wrapper = await mountStudio(RenderView, {
      locale: 'en',
      path: `/render?project=${PROJECT_ID}&run=${older.id}`,
      api: api({ [RUNS]: { payload: [runFixture(), older] } }),
    });
    mounted.push(wrapper);
    await flush(60);

    expect(wrapper.get<HTMLSelectElement>('.rv-run__select').element.value).toBe(older.id);
  });
});

describe('what the screen does not pretend to know', () => {
  it('says the delivered files have not been checked against their platform yet', async () => {
    // The verdict comes from a probe of the finished bytes, and nothing serves that
    // result. A green tick here would be the one lie this screen must not tell.
    const wrapper = await open();
    expect(wrapper.text()).toContain('checked against their platform spec after rendering');
  });

  it('says the framing has not been solved rather than drawing a guess', async () => {
    const wrapper = await open();
    // Said once, above the grid, rather than seven times under seven cards.
    expect(wrapper.get('.rv-gallery__pending').text()).toContain('Framing not solved yet');
    expect(wrapper.findAll('.rv-format__verdict')).toHaveLength(0);
    // Nothing is drawn where the composition would be, because nothing is known.
    expect(wrapper.findAll('.rv-frame__composition')).toHaveLength(0);
    expect(wrapper.findAll('.rv-frame__focus')).toHaveLength(0);
  });
});
