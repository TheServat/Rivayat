import { describe, expect, it } from 'vitest';

import { StudioApi } from '../../api/client';
import { TERRACE_IR } from '../../api/fixtures/animations.fixture';
import { FixtureTransport } from '../../api/fixtures/fixture-transport';
import { parseOrThrow, type StudioTransport, type TransportRequest } from '../../api/transport';
import { flush, mountStudio } from '../../test/harness';

import TimelineView from './TimelineView.vue';
import TrackLanes from './TrackLanes.vue';
import TransportBar from './TransportBar.vue';
import { motionSourceFor } from './motion-source';
import { useTimelineStore } from './timeline.store';

/**
 * Behaviour and invariants, not markup.
 *
 * The assertions that matter here are the ones a rewrite would have to keep: the
 * playhead moves the correct way in a right-to-left document, the whole thing is
 * operable from the keyboard, an edit undoes exactly, and a track whose channel a
 * behaviour also drives says what a drag will do to it.
 */

async function mountTimeline(locale: 'fa' | 'en' = 'fa') {
  const wrapper = await mountStudio(TimelineView, { locale, path: '/timeline' });
  await flush(8);
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe('the timeline loads an IR and shows it', () => {
  it('renders tracks, markers and behaviours from the document', async () => {
    const wrapper = await mountTimeline('en');
    const store = useTimelineStore();

    expect(store.status).toBe('ready');
    expect(store.ir?.id).toBe(TERRACE_IR.id);
    // One lane per track plus the marker lane.
    expect(wrapper.findAll('.rv-lanes__lane').length).toBe(TERRACE_IR.tracks.length + 1);
    expect(wrapper.findAll('.rv-lanes__marker').length).toBe(TERRACE_IR.markers.length);
    expect(wrapper.findAll('.rv-behaviours__item').length).toBe(TERRACE_IR.behaviours.length);
  });

  it('keeps every user-visible string in the catalogue, in both languages', async () => {
    const persian = await mountTimeline('fa');
    expect(persian.text()).toContain('خط زمان');
    expect(persian.text()).not.toContain('Timeline');

    const english = await mountTimeline('en');
    expect(english.text()).toContain('Timeline');
    expect(english.text()).not.toContain('خط زمان');
  });
});

describe('an empty timeline says what will live there', () => {
  it('invites the first shot rather than showing a blank panel', async () => {
    // The fixture always has one animation, so an empty index is reached with a
    // transport that answers one. An empty state is an invitation, not an apology.
    const empty: StudioTransport = {
      kind: 'fixture',
      eventSourceUrl: () => null,
      send: <T>(request: TransportRequest<T>): Promise<T> => {
        // The server's route and the server's shape. The client maps compositions to
        // animations, and a stub that answered the studio's own vocabulary would skip
        // exactly the translation most likely to be wrong.
        if (request.path === '/compositions') {
          return Promise.resolve(parseOrThrow(request.path, request.schema, { compositions: [] }));
        }
        return new FixtureTransport().send(request);
      },
    };
    const wrapper = await mountStudio(TimelineView, {
      locale: 'en',
      path: '/timeline',
      api: new StudioApi(empty),
    });
    await flush(8);
    await wrapper.vm.$nextTick();

    expect(useTimelineStore().ir).toBeNull();
    expect(wrapper.text()).toContain('There is no motion to edit yet');
    expect(wrapper.text()).toContain('Animation IR');
    expect(wrapper.find('.rv-motif').exists()).toBe(true);
  });
});

describe('the playhead moves the right way in each direction', () => {
  it('is placed from the inline start, so it travels toward the reader end', async () => {
    const wrapper = await mountTimeline('fa');
    const store = useTimelineStore();

    store.seek(TERRACE_IR.durationMs / 2);
    await wrapper.vm.$nextTick();

    const scrubber = wrapper.find('[data-testid="scrubber"]');
    // A physical `left` would be wrong in one of the two directions and there would be
    // no way to tell which from the markup. `--rv-progress` plus `inset-inline-start`
    // is correct in both by construction, and this asserts the value is being fed.
    expect(scrubber.attributes('style')).toContain('--rv-progress: 50%');
  });

  it('reads the arrow keys mirrored in Persian and unmirrored in English', async () => {
    for (const [locale, forward] of [
      ['fa', 'ArrowLeft'],
      ['en', 'ArrowRight'],
    ] as const) {
      const wrapper = await mountTimeline(locale);
      const store = useTimelineStore();
      store.seek(1000);
      await wrapper.vm.$nextTick();

      const scrubber = wrapper.find('[data-testid="scrubber"]');
      await scrubber.trigger('keydown', { key: forward });
      // Time runs toward the inline end, so "forward" is a different physical key in
      // each direction and both of them mean later.
      expect(store.timeMs, locale).toBeGreaterThan(1000);

      const back = forward === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
      await scrubber.trigger('keydown', { key: back });
      expect(store.timeMs, locale).toBe(1000);
    }
  });

  it('gives the keyboard everything the pointer has', async () => {
    const wrapper = await mountTimeline('en');
    const store = useTimelineStore();
    const scrubber = wrapper.find('[data-testid="scrubber"]');

    await scrubber.trigger('keydown', { key: 'End' });
    expect(store.timeMs).toBe(TERRACE_IR.durationMs);
    await scrubber.trigger('keydown', { key: 'Home' });
    expect(store.timeMs).toBe(0);
    await scrubber.trigger('keydown', { key: 'PageUp' });
    // One second at the clip's own fps.
    expect(store.timeMs).toBeCloseTo(1000, 6);
    await scrubber.trigger('keydown', { key: 'ArrowRight', shiftKey: true });
    expect(store.frame).toBe(34);
    await scrubber.trigger('keydown', { key: ' ' });
    expect(store.playing).toBe(true);
  });

  it('is a labelled slider with a live position, not a bare div', async () => {
    const wrapper = await mountTimeline('en');
    const scrubber = wrapper.find('[data-testid="scrubber"]');
    expect(scrubber.attributes('role')).toBe('slider');
    expect(scrubber.attributes('tabindex')).toBe('0');
    expect(scrubber.attributes('aria-label')).toBeTruthy();
    expect(scrubber.attributes('aria-valuenow')).toBe('0');
    expect(scrubber.attributes('aria-valuetext')).toBeTruthy();
  });
});

describe('a keyframe is draggable, keyboard-movable, and undoable', () => {
  it('moves a keyframe with the arrow keys, mirrored with the document', async () => {
    const wrapper = await mountTimeline('en');
    const store = useTimelineStore();
    const before = store.ir?.tracks[0]?.keyframes[1]?.timeMs ?? 0;

    const keys = wrapper.findAll('.rv-lanes__key');
    const target = keys[1];
    expect(target).toBeDefined();
    await target?.trigger('keydown', { key: 'ArrowRight' });

    const after = store.ir?.tracks[0]?.keyframes[1]?.timeMs ?? 0;
    expect(after).toBeGreaterThan(before);
    expect(store.editCount).toBe(1);
  });

  it('undoes an edit exactly, with no confirmation anywhere in the way', async () => {
    const wrapper = await mountTimeline('en');
    const store = useTimelineStore();
    const before = JSON.stringify(store.ir);

    const target = wrapper.findAll('.rv-lanes__key')[1];
    await target?.trigger('keydown', { key: 'ArrowRight' });
    expect(JSON.stringify(store.ir)).not.toBe(before);

    store.undo();
    // Byte for byte, which is what RV-211 asks for and what a diff-based stack only
    // approximates.
    expect(JSON.stringify(store.ir)).toBe(before);
    expect(store.canRedo).toBe(true);
    // And the "not saved" count goes back to nothing, because after this undo there is
    // nothing unsaved. A monotonic counter would keep claiming otherwise.
    expect(store.editCount).toBe(0);

    store.redo();
    expect(JSON.stringify(store.ir)).not.toBe(before);
  });

  it('collapses one drag into one undo entry, not one per pointer move', async () => {
    // Found in a real browser, which jsdom could not have: a short drag emits eight
    // `pointermove` events, and without a gesture identity the user unwinds their own
    // drag a pixel at a time. Undo has to undo the *gesture*.
    const wrapper = await mountTimeline('en');
    const store = useTimelineStore();
    const track = store.ir?.tracks[0];
    const before = JSON.stringify(store.ir);

    for (const timeMs of [1000, 1100, 1200, 1300, 1400]) {
      store.apply(
        { kind: 'moveKeyframe', trackId: track?.id ?? '', index: 1, timeMs, value: -0.5 },
        'drag-1',
      );
    }
    await wrapper.vm.$nextTick();

    expect(store.editCount).toBe(1);
    store.undo();
    // Back to before the drag started, not to the previous pointer sample.
    expect(JSON.stringify(store.ir)).toBe(before);
  });

  it('keeps separate gestures separate', async () => {
    await mountTimeline('en');
    const store = useTimelineStore();
    const track = store.ir?.tracks[0];

    store.apply(
      { kind: 'moveKeyframe', trackId: track?.id ?? '', index: 1, timeMs: 1000, value: 0 },
      'drag-1',
    );
    store.apply(
      { kind: 'moveKeyframe', trackId: track?.id ?? '', index: 1, timeMs: 1500, value: 0 },
      'drag-2',
    );
    expect(store.editCount).toBe(2);
  });

  it('says why an edit was refused instead of silently dropping it', async () => {
    const wrapper = await mountTimeline('en');
    const store = useTimelineStore();
    const track = store.ir?.tracks[0];
    expect(track).toBeDefined();

    // Past its neighbour: the schema requires strict time order.
    const accepted = store.apply({
      kind: 'moveKeyframe',
      trackId: track?.id ?? '',
      index: 0,
      timeMs: 5000,
      value: -1,
    });
    await wrapper.vm.$nextTick();

    expect(accepted).toBe(false);
    expect(store.refusal?.code).toBe('out-of-order');
    expect(store.editCount).toBe(0);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });

  it('gives every keyframe an accessible name that says where it is', async () => {
    const wrapper = await mountTimeline('en');
    const label = wrapper.findAll('.rv-lanes__key')[0]?.attributes('aria-label') ?? '';
    expect(label).toContain('opacity');
    expect(label.length).toBeGreaterThan(10);
  });
});

describe('a track says where its motion comes from', () => {
  it('marks a plain keyframed track as literally editable', () => {
    const lantern = TERRACE_IR.tracks[0];
    expect(lantern).toBeDefined();
    if (lantern === undefined) return;
    const source = motionSourceFor(TERRACE_IR, lantern);
    expect(source.kind).toBe('keyframe');
    expect(source.editsAreLiteral).toBe(true);
    expect(source.contenders).toEqual([]);
  });

  it('marks a track whose channel a behaviour also drives, and names the behaviour', () => {
    // The heron carries a `position.x` track *and* a `wind` behaviour, and wind writes
    // `position.x`. The evaluator's rule is that the track replaces the behaviour
    // unless it declared itself additive - which is a thing the user has to be told
    // before they drag, not after they render.
    const heron = TERRACE_IR.tracks[2];
    expect(heron).toBeDefined();
    if (heron === undefined) return;
    const source = motionSourceFor(TERRACE_IR, heron);
    expect(source.kind).toBe('keyframe-over-procedural');
    expect(source.contenders).toEqual(['wind']);
    expect(source.editsAreLiteral).toBe(false);
  });

  it('shows the consequence on the screen rather than only in the model', async () => {
    const wrapper = await mountTimeline('en');
    const notes = wrapper.findAll('[data-testid="motion-consequence"]');
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]?.text()).toContain('Wind');
    expect(notes[0]?.text()).toContain('replaces');
  });
});

describe('behaviour parameters change the preview and undo', () => {
  it('issues one setBehaviourParam op per change', async () => {
    const wrapper = await mountTimeline('en');
    const store = useTimelineStore();
    const before = store.ir?.behaviours[0];
    expect(before?.kind).toBe('sway');

    const range = wrapper.find('.rv-behaviours__range');
    expect(range.exists()).toBe(true);
    const element = range.element as HTMLInputElement;
    element.value = '2';
    await range.trigger('input');

    expect(store.editCount).toBe(1);
    expect(store.lastOp?.kind).toBe('setBehaviourParam');
    store.undo();
    expect(JSON.stringify(store.ir?.behaviours[0])).toBe(JSON.stringify(before));
  });
});

describe('the transport mirrors pointer input as well as keys', () => {
  it('measures the pointer from the inline start of the track', async () => {
    const wrapper = await mountStudio(TransportBar, {
      locale: 'fa',
      path: '/timeline',
      props: { ir: TERRACE_IR, timeMs: 0, playing: false, looping: true },
    });
    const exposed = wrapper.vm as unknown as {
      fractionFromPointer: (rect: DOMRect, clientX: number, rtl: boolean) => number;
    };
    const rect = { left: 100, right: 300, width: 200 } as DOMRect;

    // A quarter of the way along the *reading* direction is a different physical x in
    // each script, and both have to answer 0.25.
    expect(exposed.fractionFromPointer(rect, 150, false)).toBeCloseTo(0.25, 9);
    expect(exposed.fractionFromPointer(rect, 250, true)).toBeCloseTo(0.25, 9);
  });

  it('renders the same elements in both directions, with no mirrored markup', async () => {
    const classesOf = async (locale: 'fa' | 'en'): Promise<string[]> => {
      const wrapper = await mountStudio(TrackLanes, {
        locale,
        path: '/timeline',
        props: { ir: TERRACE_IR, timeMs: 1000, selection: null },
      });
      await flush();
      return [...(wrapper.element as Element).querySelectorAll('[class]')].map(
        (node) => node.getAttribute('class') ?? '',
      );
    };
    expect(await classesOf('fa')).toEqual(await classesOf('en'));
  });
});
