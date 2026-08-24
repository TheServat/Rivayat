import { describe, expect, it } from 'vitest';

import { StudioApi } from '../../api/client';
import { ApiError } from '../../api/errors';
import { FixtureTransport } from '../../api/fixtures/fixture-transport';
import { parseOrThrow, type StudioTransport, type TransportRequest } from '../../api/transport';
import { flush, mountStudio } from '../../test/harness';

import AssetsView from './AssetsView.vue';
import { representationOf } from './representation';
import { useAssetsStore } from './assets.store';

/**
 * The screen where the second non-negotiable is upheld or quietly broken.
 *
 * The assertions that matter are about *what was called*, not about what was rendered:
 * "cancelling makes no call" is only true if no request was made, and a test that
 * checked the dialog closed would pass on a screen that had already spent the money.
 */

/** A transport that records every request and otherwise behaves exactly as the fixture. */
class CountingTransport implements StudioTransport {
  readonly kind = 'fixture' as const;
  readonly calls: { method: string; path: string }[] = [];
  readonly #inner = new FixtureTransport();

  eventSourceUrl(): string | null {
    // The fixture transport has no stream, and neither does this. Declared rather than
    // delegated because its signature takes no argument.
    return this.#inner.eventSourceUrl();
  }

  send<T>(request: TransportRequest<T>): Promise<T> {
    this.calls.push({ method: request.method, path: request.path });
    return this.#inner.send(request);
  }

  wrote(): { method: string; path: string }[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }
}

/** A transport that fails one route, so the error and unavailable paths are reachable. */
class FailingTransport implements StudioTransport {
  readonly kind = 'fixture' as const;
  readonly #inner = new FixtureTransport();
  readonly #match: RegExp;
  readonly #error: ApiError;

  constructor(match: RegExp, error: ApiError) {
    this.#match = match;
    this.#error = error;
  }

  eventSourceUrl(): null {
    return null;
  }

  send<T>(request: TransportRequest<T>): Promise<T> {
    if (this.#match.test(request.path)) return Promise.reject(this.#error);
    return this.#inner.send(request);
  }
}

/**
 * The asset a test names, or a loud failure.
 *
 * `find` returns `T | undefined` and every call site here needs the value, so the check
 * lives once rather than as a `?? ''` fallback at each one - a fallback that would turn
 * "the fixture changed" into "the assertion quietly ran against nothing".
 */
function assetIdFor(store: ReturnType<typeof useAssetsStore>, semanticKey: string) {
  const entry = store.assets.find((candidate) => candidate.semanticKey === semanticKey);
  if (entry === undefined) throw new Error(`no fixture asset for ${semanticKey}`);
  return entry.id;
}

async function mountAssets(locale: 'fa' | 'en' = 'fa', api?: StudioApi) {
  const wrapper = await mountStudio(AssetsView, {
    locale,
    path: '/assets',
    ...(api === undefined ? {} : { api }),
  });
  await flush(10);
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe('the library lists what exists', () => {
  it('shows each asset with its counts and its accumulated spend', async () => {
    const wrapper = await mountAssets('en');
    const store = useAssetsStore();

    expect(store.status).toBe('ready');
    expect(store.assets.length).toBeGreaterThan(0);
    expect(wrapper.text()).toContain('Terrace street lamp');
    expect(wrapper.text()).toContain('prop/street-lamp/terrace');

    // The lamp has two versions; the count is what makes "appended, never overwritten"
    // visible without opening anything.
    const lamp = store.assets.find((entry) => entry.semanticKey === 'prop/street-lamp/terrace');
    expect(lamp?.versionCount).toBe(2);
  });

  it('says how each asset is built rather than implying they are all the same shape', async () => {
    // Representation is independent of style: a flat image, a cutout rig and a mesh
    // cutout are different things to animate. Derived from the parts and the rig today,
    // and marked as derived, because the contract does not declare it yet.
    const wrapper = await mountAssets('en');
    expect(wrapper.text()).toContain('Cutout');
    expect(wrapper.text()).toContain('Flat image');
  });

  it('keeps every user-visible string in the catalogue, in both languages', async () => {
    const persian = await mountAssets('fa');
    expect(persian.text()).toContain('کتابخانهٔ دارایی‌ها');
    expect(persian.text()).not.toContain('Asset library');

    const english = await mountAssets('en');
    expect(english.text()).toContain('Asset library');
    expect(english.text()).not.toContain('کتابخانهٔ دارایی‌ها');
  });

  it('renders Persian numerals without ever parsing one back', async () => {
    const persian = await mountAssets('fa');
    // The Persian digit four, from a version count, a part count or a cost.
    expect(persian.text()).toMatch(/[۰-۹]/);
  });
});

describe('the five states', () => {
  it('draws a skeleton shaped like the table while it loads', async () => {
    const wrapper = await mountStudio(AssetsView, { locale: 'en', path: '/assets' });
    // Before `flush`, the request has not resolved.
    expect(wrapper.find('.rv-assets__skeleton-row').exists()).toBe(true);
    expect(wrapper.find('[role="status"]').text()).toContain('Reading the library');
  });

  it('invites the first asset rather than apologising for having none', async () => {
    // An empty library is a real state and the fixture never produces one, so it is
    // reached with a transport that answers an empty page. The screen has to say what
    // it is for; a blank panel teaches nothing.
    const empty: StudioTransport = {
      kind: 'fixture',
      eventSourceUrl: () => null,
      send: <T>(request: TransportRequest<T>): Promise<T> => {
        if (/^\/assets(\?|$)/.test(request.path)) {
          return Promise.resolve(
            parseOrThrow(request.path, request.schema, { assets: [], total: 0, incomplete: [] }),
          );
        }
        return new FixtureTransport().send(request);
      },
    };
    const wrapper = await mountAssets('en', new StudioApi(empty));

    expect(useAssetsStore().isEmpty).toBe(true);
    expect(wrapper.text()).toContain('Nothing has been generated yet');
    expect(wrapper.text()).toContain('reused forever');
    // The drawing is part of the invitation, not decoration.
    expect(wrapper.find('.rv-motif').exists()).toBe(true);
  });

  it('names the missing endpoint rather than blaming the network', async () => {
    // Three of this screen's routes are not implemented in `apps/api`. A 404 from one of
    // them is not a failure - it is a screen waiting for a story - and saying "something
    // went wrong" about a server that is working fine teaches people to distrust the UI.
    const api = new StudioApi(
      new FailingTransport(
        /^\/assets(\?|$)/,
        new ApiError({
          failure: 'api',
          code: 'http-404',
          kind: 'validation',
          status: 404,
          message: 'Not Found',
        }),
      ),
    );
    const wrapper = await mountAssets('en', api);

    expect(useAssetsStore().status).toBe('unavailable');
    expect(wrapper.text()).toContain('not built on the server yet');
    expect(wrapper.text()).toContain('GET /api/assets');
    expect(wrapper.text()).toContain('RV-208');
    expect(wrapper.find('.rv-error').exists()).toBe(false);
  });

  it('shows a retryable error when the server actually fails', async () => {
    const api = new StudioApi(
      new FailingTransport(/^\/assets(\?|$)/, ApiError.network(new Error('offline'))),
    );
    const wrapper = await mountAssets('en', api);

    expect(useAssetsStore().status).toBe('error');
    expect(wrapper.find('.rv-error').exists()).toBe(true);
  });

  it('shows a partial screen when the plan is unavailable but the library is not', async () => {
    const api = new StudioApi(
      new FailingTransport(
        /^\/assets\/demand\/plan$/,
        new ApiError({ failure: 'api', code: 'http-404', status: 404, message: 'Not Found' }),
      ),
    );
    const wrapper = await mountAssets('en', api);
    const store = useAssetsStore();

    // Partial is a state, not a failure: the list arrived and is usable.
    expect(store.status).toBe('ready');
    expect(store.planStatus).toBe('unavailable');
    expect(wrapper.text()).toContain('Terrace street lamp');
  });
});

describe('plan before produce', () => {
  it('says $0.00 for a run that resolves entirely to cache hits, and means it', async () => {
    const transport = new CountingTransport();
    const wrapper = await mountAssets('en', new StudioApi(transport));
    const store = useAssetsStore();

    expect(store.plan).not.toBeNull();
    expect(store.plan?.hitCount).toBeGreaterThan(0);
    // Resolving writes nothing and calls no provider, so the plan can be read as often
    // as somebody likes. Asserted on the requests, not on the rendering.
    expect(transport.wrote()).toEqual([]);

    const hitsOnly = store.plan?.resolutions.filter((row) => row.outcome === 'cache-hit') ?? [];
    expect(hitsOnly.every((row) => row.estimatedCostNanoUsd === 0)).toBe(true);
    expect(wrapper.text()).toContain('$0.00');
  });

  it('shows the misses, and the estimate is the sum of only those', async () => {
    await mountAssets('en');
    const store = useAssetsStore();
    const plan = store.plan;
    expect(plan).not.toBeNull();
    if (plan === null) return;

    const expected = plan.resolutions.reduce((sum, row) => sum + row.estimatedCostNanoUsd, 0);
    expect(plan.totalEstimatedNanoUsd).toBe(expected);
    expect(plan.missCount).toBeGreaterThan(0);
  });
});

describe('a failed take is not a missing asset', () => {
  it('shows which of the eight steps it stopped at', async () => {
    const wrapper = await mountAssets('en');
    expect(wrapper.text()).toContain('Stopped at Matte');
    expect(wrapper.text()).toContain('Step 2 of 8');
  });

  it('shows the engine own diagnosis verbatim, numbers and all', async () => {
    // "removed nothing: alpha coverage 0.9912 is above 0.98" is a diagnosis a user can
    // act on. "Matting failed" is not, and paraphrasing it into the catalogue would
    // throw the number away.
    const wrapper = await mountAssets('en');
    expect(wrapper.text()).toContain('alpha coverage 0.9912 is above 0.98');
  });

  it('distinguishes a step that failed from one that was never reached', async () => {
    const wrapper = await mountAssets('en');
    const outcomes = wrapper
      .findAll('.rv-trail__step')
      .map((step) => step.attributes('data-outcome'));
    expect(outcomes).toContain('failed');
    expect(outcomes).toContain('not-reached');
    expect(outcomes).toContain('ran');
  });
});

describe('regeneration is deliberate', () => {
  async function openLamp(transport: CountingTransport) {
    const wrapper = await mountAssets('en', new StudioApi(transport));
    const store = useAssetsStore();
    const lampId = assetIdFor(store, 'prop/street-lamp/terrace');
    await store.open(lampId);
    await flush(6);
    await wrapper.vm.$nextTick();
    return { wrapper, store };
  }

  it('cannot be reached by accident: the dialog opens without calling anything', async () => {
    const transport = new CountingTransport();
    const { wrapper, store } = await openLamp(transport);
    const writesBefore = transport.wrote().length;

    store.beginRegenerate();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(transport.wrote().length).toBe(writesBefore);
  });

  it('refuses to submit until a reason from the enum has been chosen', async () => {
    const transport = new CountingTransport();
    const { wrapper, store } = await openLamp(transport);
    store.beginRegenerate();
    await wrapper.vm.$nextTick();

    const buttons = wrapper.findAll('[role="dialog"] button');
    const confirm = buttons.find((button) => button.text().includes('Generate a new version'));
    expect(confirm).toBeDefined();
    // No default reason: a pre-selected one is a reason nobody chose.
    expect(confirm?.attributes('disabled')).toBeDefined();

    await wrapper.find('[role="dialog"] input[type="radio"]').setValue();
    await wrapper.vm.$nextTick();
    expect(
      wrapper
        .findAll('[role="dialog"] button')
        .find((button) => button.text().includes('Generate a new version'))
        ?.attributes('disabled'),
    ).toBeUndefined();
  });

  it('shows the cost before the button, not after the bill', async () => {
    const transport = new CountingTransport();
    const { wrapper, store } = await openLamp(transport);
    store.beginRegenerate();
    await wrapper.vm.$nextTick();

    const dialog = wrapper.find('[role="dialog"]').text();
    expect(dialog).toContain('Estimated cost before it runs');
    expect(dialog).toMatch(/\$\d/);
    // And the previous version is named by its ordinal, not merely alluded to.
    expect(dialog).toContain('Version 2 is untouched');
  });

  it('cancelling makes no call at all', async () => {
    const transport = new CountingTransport();
    const { wrapper, store } = await openLamp(transport);
    store.beginRegenerate();
    await wrapper.vm.$nextTick();

    const cancel = wrapper
      .findAll('[role="dialog"] button')
      .find((button) => button.text().includes('Cancel'));
    const before = transport.calls.length;
    await cancel?.trigger('click');
    await flush(4);

    expect(store.regenerateStatus).toBe('idle');
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    // Every call, not only the writes: cancelling must not even re-read.
    expect(transport.calls.length).toBe(before);
  });
});

describe('a second take is appended, never written over the first', () => {
  it('adds a version, keeps every previous one, and both ids stay addressable', async () => {
    const transport = new CountingTransport();
    const wrapper = await mountAssets('en', new StudioApi(transport));
    const store = useAssetsStore();

    const lampId = assetIdFor(store, 'prop/street-lamp/terrace');
    await store.open(lampId);
    await flush(6);

    const before = store.detail?.versions.map((version) => version.id) ?? [];
    const previousCurrent = store.detail?.currentVersionId;
    expect(before.length).toBe(2);

    store.beginRegenerate();
    await store.regenerate({ reason: 'quality-reject', keepPrevious: true });
    await flush(8);
    await wrapper.vm.$nextTick();

    const after = store.detail?.versions.map((version) => version.id) ?? [];
    // Appended: every id that was there is still there, and there is one more.
    expect(after.length).toBe(before.length + 1);
    for (const id of before) expect(after).toContain(id);
    // The ordinal is monotonic, so version 2 did not become version 3.
    expect(store.detail?.versions.map((version) => version.ordinal).toSorted()).toEqual([1, 2, 3]);
    expect(store.lastRegenerate?.previousVersionId).toBe(previousCurrent);
    expect(store.lastRegenerate?.newVersionId).not.toBe(previousCurrent);

    // And the screen shows the evidence rather than asserting it in a sentence: two
    // addressable ids, the old one and the new one.
    const text = wrapper.text();
    expect(text).toContain('Version 3 appended');
    expect(text).toContain(store.lastRegenerate?.previousVersionId ?? 'missing');
    expect(text).toContain(store.lastRegenerate?.newVersionId ?? 'missing');
  });

  it('sends a RegenerateIntent whose keepPrevious is true', async () => {
    const sent: unknown[] = [];
    const inner = new FixtureTransport();
    const spy: StudioTransport = {
      kind: 'fixture',
      eventSourceUrl: () => null,
      send: <T>(request: TransportRequest<T>): Promise<T> => {
        if (request.path.endsWith('/regenerate')) sent.push(request.body);
        return inner.send(request);
      },
    };
    await mountAssets('en', new StudioApi(spy));
    const store = useAssetsStore();
    await store.open(assetIdFor(store, 'prop/street-lamp/terrace'));
    await flush(6);

    await store.regenerate({ reason: 'new-take', keepPrevious: true, note: 'another roll' });
    await flush(6);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ reason: 'new-take', keepPrevious: true, note: 'another roll' });
  });
});

describe('search is submit-driven, because it costs money', () => {
  it('does not call the endpoint while somebody is typing', async () => {
    const transport = new CountingTransport();
    const wrapper = await mountAssets('en', new StudioApi(transport));

    const input = wrapper.find('input[type="search"]');
    await input.setValue('oak');
    await input.setValue('oak tr');
    await input.setValue('oak tree');
    await flush(4);

    expect(transport.calls.filter((call) => call.path === '/assets/search')).toEqual([]);

    await wrapper.find('form[role="search"]').trigger('submit');
    await flush(6);
    expect(transport.calls.filter((call) => call.path === '/assets/search')).toHaveLength(1);
  });

  it('returns nothing rather than the least-bad match when nothing is close', async () => {
    await mountAssets('en');
    const store = useAssetsStore();
    await store.search('a submarine made of glass');
    expect(store.searchHits).toEqual([]);
  });
});

describe('representation is derived from what the version actually carries', () => {
  it('calls a single-part rigid prop flat and a five-part mesh tree a mesh cutout', async () => {
    await mountAssets('en');
    const store = useAssetsStore();

    await store.open(assetIdFor(store, 'prop/wick-key/brass'));
    await flush(6);
    expect(representationOf(store.selectedVersion ?? undefined).kind).toBe('flat');

    await store.open(assetIdFor(store, 'flora/oak-tree/mature'));
    await flush(6);
    expect(representationOf(store.selectedVersion ?? undefined).kind).toBe('cutout-mesh');
    // Always marked derived: the contract does not declare it, and a reader deciding
    // whether an asset can be re-rigged should know the answer was inferred.
    expect(representationOf(store.selectedVersion ?? undefined).derived).toBe(true);
  });
});

describe('the layout mirrors rather than being rebuilt', () => {
  it('renders the same elements in both directions', async () => {
    const classesOf = async (locale: 'fa' | 'en'): Promise<string[]> => {
      const wrapper = await mountAssets(locale);
      return [...(wrapper.element as Element).querySelectorAll('[class]')].map(
        (node) => node.getAttribute('class') ?? '',
      );
    };
    expect(await classesOf('fa')).toEqual(await classesOf('en'));
  });
});

describe('the open asset lives in the URL', () => {
  it('opens from a query parameter, so a panel can be linked to', async () => {
    const wrapper = await mountAssets('en');
    const store = useAssetsStore();
    const lampId = assetIdFor(store, 'prop/street-lamp/terrace');

    await wrapper.vm.$router.replace({ path: '/assets', query: { asset: lampId } });
    await flush(8);
    await wrapper.vm.$nextTick();

    expect(store.detail?.id).toBe(lampId);
    expect(wrapper.text()).toContain('Dedup key');
  });
});
