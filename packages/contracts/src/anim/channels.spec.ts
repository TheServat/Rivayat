import { describe, expect, it } from 'vitest';

import { AnimChannel } from './ir';
import { CHANNEL_METRIC, ChannelMetric, channelMetric, scalesWithRig } from './channels';

describe('what a channel measures', () => {
  it('has an answer for every channel, so no channel is silently unscaled', () => {
    // The totality that makes this table worth having: a nineteenth channel added to
    // `AnimChannel` fails the build here, not in a render three weeks later.
    const declared = new Set(Object.keys(CHANNEL_METRIC));
    const missing = AnimChannel.options.filter((channel) => !declared.has(channel));
    expect(missing).toEqual([]);
  });

  it('only ever names a metric the vocabulary declares', () => {
    const known = new Set<string>(ChannelMetric.options);
    const rogue = Object.entries(CHANNEL_METRIC).filter(([, metric]) => !known.has(metric));
    expect(rogue).toEqual([]);
  });

  it('reads a channel’s metric', () => {
    expect(channelMetric('position.x')).toBe('length');
    expect(channelMetric('rotation')).toBe('angle');
    expect(channelMetric('scale.x')).toBe('ratio');
    expect(channelMetric('opacity')).toBe('normalised');
    expect(channelMetric('depth')).toBe('ordinal');
  });
});

describe('which channels retargeting rescales', () => {
  it('scales position, because a stride is a distance', () => {
    expect(scalesWithRig('position.x')).toBe(true);
    expect(scalesWithRig('position.y')).toBe(true);
  });

  it('leaves rotation alone, because a knee bends through the same angle at any size', () => {
    expect(scalesWithRig('rotation')).toBe(false);
    expect(scalesWithRig('skew.x')).toBe(false);
  });

  it('leaves multipliers and normalised channels alone', () => {
    // Scaling a multiplier compounds; scaling a 0..1 channel drives it out of its own
    // range. Both are silent in one frame and obvious across a hundred.
    for (const channel of ['scale.x', 'scale.y', 'clip.speed'] as const) {
      expect(scalesWithRig(channel), channel).toBe(false);
    }
    for (const channel of ['opacity', 'anchor.x', 'tint.r', 'path.progress'] as const) {
      expect(scalesWithRig(channel), channel).toBe(false);
    }
  });

  it('scales exactly the channels whose metric is a length, and no others', () => {
    const scaled = AnimChannel.options.filter((channel) => scalesWithRig(channel));
    expect(scaled).toEqual(['position.x', 'position.y']);
  });
});
