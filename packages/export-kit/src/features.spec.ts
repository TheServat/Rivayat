import { describe, expect, it } from 'vitest';
import { AnimChannel } from '@rv/contracts';

import { IR_FEATURES, describeFeature, detectFeatures, featureForChannel } from './features';
import { easedMoveIr, hierarchyIr, richIr, windIr } from './__fixtures__/ir';

describe('describeFeature', () => {
  it('has a description for every feature, so no warning can read as undefined', () => {
    for (const feature of IR_FEATURES) {
      expect(describeFeature(feature).length).toBeGreaterThan(3);
    }
  });
});

describe('featureForChannel', () => {
  it('maps every animatable channel to a feature', () => {
    for (const channel of AnimChannel.options) {
      expect(IR_FEATURES).toContain(featureForChannel(channel));
    }
  });

  it('groups the components of a vector channel under one feature', () => {
    expect(featureForChannel('position.x')).toBe(featureForChannel('position.y'));
    expect(featureForChannel('tint.r')).toBe(featureForChannel('tint.b'));
  });
});

describe('detectFeatures', () => {
  it('names the node kinds present and the ids that carry them', () => {
    const ir = richIr();
    const found = detectFeatures(ir);

    expect(found.get('node:asset-instance')).toEqual([ir.nodes[0]?.id]);
    expect(found.get('node:fx-emitter')).toEqual([ir.nodes[1]?.id]);
    expect(found.get('node:shape-path')).toEqual([ir.nodes[2]?.id]);
  });

  it('reports node properties a format may not have', () => {
    const found = detectFeatures(richIr());
    expect(found.has('node:tint')).toBe(true);
    expect(found.has('node:flip-x')).toBe(true);
    expect(found.has('node:clip-playback')).toBe(true);
  });

  it('reports track semantics separately from the channels they animate', () => {
    const found = detectFeatures(richIr());
    expect(found.has('track:additive')).toBe(true);
    expect(found.has('track:extrapolation')).toBe(true);
    expect(found.has('track:stepped-easing')).toBe(true);
    expect(found.has('track:fx-intensity')).toBe(true);
    expect(found.has('track:depth')).toBe(true);
    expect(found.has('track:anchor')).toBe(true);
  });

  it('does not report a stepped easing that Lottie can hold exactly', () => {
    const ir = richIr();
    const single = {
      ...ir,
      tracks: ir.tracks.map((track) => ({
        ...track,
        keyframes: track.keyframes.map((keyframe) =>
          keyframe.easing?.kind === 'stepped'
            ? { ...keyframe, easing: { kind: 'stepped' as const, at: 'end' as const, steps: 1 } }
            : keyframe,
        ),
      })),
    };
    expect(detectFeatures(single).has('track:stepped-easing')).toBe(false);
  });

  it('reports the camera, its shake and its focus node independently', () => {
    const found = detectFeatures(richIr());
    expect(found.has('camera:track')).toBe(true);
    expect(found.has('camera:shake')).toBe(true);
    expect(found.has('camera:focus-node')).toBe(true);
  });

  it('reports only enabled behaviours', () => {
    const ir = windIr();
    expect(detectFeatures(ir).has('behaviour:wind')).toBe(true);

    const disabled = {
      ...ir,
      behaviours: ir.behaviours.map((behaviour) => ({ ...behaviour, enabled: false })),
    };
    expect(detectFeatures(disabled).has('behaviour:wind')).toBe(false);
  });

  it('reports a hierarchy only when one exists', () => {
    expect(detectFeatures(hierarchyIr()).has('node:hierarchy')).toBe(true);
    expect(detectFeatures(easedMoveIr()).has('node:hierarchy')).toBe(false);
  });

  it('reports markers and rtl text', () => {
    const found = detectFeatures(hierarchyIr());
    expect(found.get('markers')).toHaveLength(2);
    expect(found.has('node:text-rtl')).toBe(true);
  });

  it('reports nothing for a document that uses nothing', () => {
    const found = detectFeatures(easedMoveIr());
    expect(found.has('markers')).toBe(false);
    expect(found.has('camera:track')).toBe(false);
    expect([...found.keys()].sort()).toEqual(['node:shape', 'track:position']);
  });
});
