import { describe, expect, it } from 'vitest';

import { testIds } from '../__fixtures__/builders';
import { AnimChannel, AnimationIR, type BehaviourKind } from './ir';
import {
  IR_FEATURES,
  IR_FEATURE_BY_BEHAVIOUR,
  IR_FEATURE_BY_CHANNEL,
  type IrFeature,
  describeIrFeature,
  detectIrFeatures,
  irFeatureForChannel,
  irFeatureList,
} from './features';

const ids = testIds();
const ROOT = ids.node();
const CHILD = ids.node();
const ANIMATION = ids.animation();

function ir(overrides: Record<string, unknown> = {}): AnimationIR {
  return AnimationIR.parse({
    irVersion: 1,
    id: ANIMATION,
    name: 'probe',
    fps: 24,
    durationMs: 4000,
    sceneSpace: { width: 2560, height: 2560 },
    seed: 7,
    nodes: [{ kind: 'group', id: ROOT, name: 'root', parentId: null }],
    ...overrides,
  });
}

/** The features present, as a plain sorted list. */
function featuresOf(document: AnimationIR): readonly IrFeature[] {
  return irFeatureList(detectIrFeatures(document));
}

describe('the vocabulary is closed and total over the unions it names', () => {
  it('names every animatable channel exactly once', () => {
    // Total by type, but a `Record` can be total and still map two channels to a
    // feature nobody declared. Both halves are checked.
    expect(Object.keys(IR_FEATURE_BY_CHANNEL).sort()).toEqual([...AnimChannel.options].sort());
    for (const channel of AnimChannel.options) {
      expect(IR_FEATURES).toContain(irFeatureForChannel(channel));
    }
  });

  it('names every behaviour kind exactly once', () => {
    const kinds = Object.keys(IR_FEATURE_BY_BEHAVIOUR) as BehaviourKind[];

    expect(new Set(Object.values(IR_FEATURE_BY_BEHAVIOUR)).size).toBe(kinds.length);
    for (const kind of kinds) {
      expect(IR_FEATURES).toContain(IR_FEATURE_BY_BEHAVIOUR[kind]);
    }
  });

  it('has no duplicate members', () => {
    expect(new Set(IR_FEATURES).size).toBe(IR_FEATURES.length);
  });

  it('describes every feature, because a warning nobody can read is not a warning', () => {
    for (const feature of IR_FEATURES) {
      expect(describeIrFeature(feature).length, feature).toBeGreaterThan(3);
    }
  });
});

describe('nodes', () => {
  it('reports the kind of every node and the ids that carry it', () => {
    const uses = detectIrFeatures(
      ir({
        nodes: [
          { kind: 'group', id: ROOT, name: 'root', parentId: null },
          { kind: 'text', id: CHILD, name: 'title', parentId: ROOT, text: 'Hello' },
        ],
      }),
    );

    // The ids are the point: "text is approximated" is a footnote, naming the node is
    // something a reviewer can act on.
    expect(uses.get('node:group')).toEqual([ROOT]);
    expect(uses.get('node:text')).toEqual([CHILD]);
    expect(uses.get('node:hierarchy')).toEqual([CHILD]);
  });

  it('does not claim a hierarchy for a document that is all roots', () => {
    expect(featuresOf(ir())).toEqual(['node:group']);
  });

  it('reports each optional property of an asset instance only when it is used', () => {
    const bare = ir({
      nodes: [
        {
          kind: 'asset-instance',
          id: ROOT,
          name: 'oak',
          parentId: null,
          asset: { assetId: ids.asset(), versionId: ids.assetVersion() },
        },
      ],
    });
    const dressed = ir({
      nodes: [
        {
          kind: 'asset-instance',
          id: ROOT,
          name: 'oak',
          parentId: null,
          asset: { assetId: ids.asset(), versionId: ids.assetVersion() },
          tint: '#ff8800',
          flipX: true,
          clipName: 'sway',
        },
      ],
    });

    expect(featuresOf(bare)).toEqual(['node:asset-instance']);
    expect(featuresOf(dressed)).toEqual([
      'node:asset-instance',
      'node:tint',
      'node:flip-x',
      'node:clip-playback',
    ]);
  });

  it('separates right-to-left text from text, because most formats have only the first', () => {
    const ltr = ir({
      nodes: [{ kind: 'text', id: ROOT, name: 'a', parentId: null, text: 'x', direction: 'ltr' }],
    });
    const rtl = ir({
      nodes: [{ kind: 'text', id: ROOT, name: 'a', parentId: null, text: 'x', direction: 'rtl' }],
    });

    expect(featuresOf(ltr)).toEqual(['node:text']);
    expect(featuresOf(rtl)).toEqual(['node:text', 'node:text-rtl']);
  });

  it('separates path geometry from the primitive shapes', () => {
    const rect = ir({
      nodes: [{ kind: 'shape', id: ROOT, name: 's', parentId: null, shape: 'rect' }],
    });
    const path = ir({
      nodes: [
        {
          kind: 'shape',
          id: ROOT,
          name: 's',
          parentId: null,
          shape: 'path',
          geometry: 'M0 0 L1 1',
        },
      ],
    });

    expect(featuresOf(rect)).toEqual(['node:shape']);
    expect(featuresOf(path)).toEqual(['node:shape', 'node:shape-path']);
  });

  it('reports the node kinds that carry nothing beyond themselves', () => {
    const instance = ids.node();
    const document = ir({
      nodes: [
        { kind: 'group', id: ROOT, name: 'root', parentId: null },
        {
          kind: 'asset-instance',
          id: instance,
          name: 'oak',
          parentId: null,
          asset: { assetId: ids.asset(), versionId: ids.assetVersion() },
        },
        {
          kind: 'part',
          id: ids.node(),
          name: 'branch',
          parentId: null,
          instanceId: instance,
          partId: ids.part(),
        },
        {
          kind: 'bone',
          id: ids.node(),
          name: 'spine',
          parentId: null,
          instanceId: instance,
          boneId: ids.bone(),
        },
        {
          kind: 'fx-emitter',
          id: ids.node(),
          name: 'dust',
          parentId: null,
          effect: 'dust',
          rate: 10,
          area: { width: 100, height: 100 },
          seed: 1,
        },
      ],
    });

    expect(featuresOf(document)).toEqual([
      'node:group',
      'node:asset-instance',
      'node:part',
      'node:bone',
      'node:fx-emitter',
    ]);
  });
});

describe('tracks', () => {
  function withTrack(overrides: Record<string, unknown>): AnimationIR {
    return ir({
      tracks: [
        {
          id: ids.track(),
          nodeId: ROOT,
          channel: 'rotation',
          keyframes: [
            { timeMs: 0, value: 0 },
            { timeMs: 1000, value: 1 },
          ],
          ...overrides,
        },
      ],
    });
  }

  it('folds the two axes of one property into one feature', () => {
    // No format supports `position.x` without `position.y`, so splitting them would
    // produce a warning nobody could act on.
    const document = ir({
      tracks: (['position.x', 'position.y'] as const).map((channel) => ({
        id: ids.track(),
        nodeId: ROOT,
        channel,
        keyframes: [{ timeMs: 0, value: 0 }],
      })),
    });

    expect(featuresOf(document)).toEqual(['node:group', 'track:position']);
    expect(detectIrFeatures(document).get('track:position')).toHaveLength(2);
  });

  it('reports an additive track separately from the channel it animates', () => {
    expect(featuresOf(withTrack({ additive: true }))).toEqual([
      'node:group',
      'track:rotation',
      'track:additive',
    ]);
  });

  it('reports extrapolation when either end leaves hold', () => {
    expect(featuresOf(withTrack({}))).toEqual(['node:group', 'track:rotation']);
    expect(featuresOf(withTrack({ before: 'loop' }))).toContain('track:extrapolation');
    expect(featuresOf(withTrack({ after: 'ping-pong' }))).toContain('track:extrapolation');
  });

  it('treats a single jump at the end of an interval as ordinary, and anything else as not', () => {
    // One trailing jump is what every format calls a hold. More than one, or a jump at
    // the start, is something most of them cannot express.
    const hold = withTrack({
      keyframes: [
        { timeMs: 0, value: 0, easing: { kind: 'stepped', steps: 1, at: 'end' } },
        { timeMs: 1000, value: 1 },
      ],
    });
    const multi = withTrack({
      keyframes: [
        { timeMs: 0, value: 0, easing: { kind: 'stepped', steps: 4, at: 'end' } },
        { timeMs: 1000, value: 1 },
      ],
    });
    const atStart = withTrack({
      keyframes: [
        { timeMs: 0, value: 0, easing: { kind: 'stepped', steps: 1, at: 'start' } },
        { timeMs: 1000, value: 1 },
      ],
    });
    const eased = withTrack({
      keyframes: [
        { timeMs: 0, value: 0, easing: { kind: 'named', name: 'ease-in' } },
        { timeMs: 1000, value: 1 },
      ],
    });

    expect(featuresOf(hold)).not.toContain('track:stepped-easing');
    expect(featuresOf(eased)).not.toContain('track:stepped-easing');
    expect(featuresOf(multi)).toContain('track:stepped-easing');
    expect(featuresOf(atStart)).toContain('track:stepped-easing');
  });

  it('names the same track once however many keyframes are stepped', () => {
    const document = withTrack({
      keyframes: [
        { timeMs: 0, value: 0, easing: { kind: 'stepped', steps: 3, at: 'end' } },
        { timeMs: 500, value: 1, easing: { kind: 'stepped', steps: 3, at: 'end' } },
        { timeMs: 1000, value: 2 },
      ],
    });

    expect(detectIrFeatures(document).get('track:stepped-easing')).toHaveLength(1);
  });

  it('maps every channel to the feature its table declares', () => {
    for (const channel of AnimChannel.options) {
      const document = ir({
        tracks: [{ id: ids.track(), nodeId: ROOT, channel, keyframes: [{ timeMs: 0, value: 0 }] }],
      });

      expect(featuresOf(document), channel).toContain(IR_FEATURE_BY_CHANNEL[channel]);
    }
  });
});

describe('behaviours', () => {
  function behaviour(kind: BehaviourKind): Record<string, unknown> {
    const base = { id: ids.behaviour(), nodeId: ROOT, seed: 1, kind };
    switch (kind) {
      case 'orbit':
        return { ...base, centre: { x: 0, y: 0 }, radius: { x: 10, y: 10 } };
      case 'look-at':
        return { ...base, targetNodeId: ROOT };
      case 'follow-path':
        return { ...base, path: 'M0 0 L1 1', durationMs: 1000 };
      case 'lip-sync':
        return { ...base, phonemes: [{ timeMs: 0, viseme: 'aa', durationMs: 100 }] };
      default:
        return base;
    }
  }

  it('names every behaviour kind the union declares', () => {
    const kinds = Object.keys(IR_FEATURE_BY_BEHAVIOUR) as BehaviourKind[];
    const document = ir({ behaviours: kinds.map(behaviour) });

    expect(featuresOf(document)).toEqual([
      'node:group',
      ...IR_FEATURES.filter((feature) => feature.startsWith('behaviour:')),
    ]);
  });

  it('ignores a disabled behaviour, which nothing evaluates', () => {
    // Warning that an export loses a behaviour the evaluator never runs would be a
    // warning about nothing.
    const document = ir({ behaviours: [{ ...behaviour('wind'), enabled: false }] });

    expect(featuresOf(document)).toEqual(['node:group']);
  });
});

describe('the scene level', () => {
  it('reports no camera feature for a document without one', () => {
    expect(featuresOf(ir())).toEqual(['node:group']);
  });

  it('reports the camera, and shake and focus only when they are set', () => {
    const plain = ir({ camera: { keyframes: [{ timeMs: 0, position: { x: 0, y: 0 } }] } });
    const full = ir({
      camera: {
        keyframes: [{ timeMs: 0, position: { x: 0, y: 0 } }],
        shakeAmplitude: 0.4,
        focusNodeId: ROOT,
      },
    });

    expect(featuresOf(plain)).toEqual(['node:group', 'camera:track']);
    expect(featuresOf(full)).toEqual([
      'node:group',
      'camera:track',
      'camera:shake',
      'camera:focus-node',
    ]);
    // The focus node is named by the node it points at, because that is the node a
    // reframer will fail to keep in shot.
    expect(detectIrFeatures(full).get('camera:focus-node')).toEqual([ROOT]);
  });

  it('reports markers by their own ids, so a lost cue can be named', () => {
    const first = ids.marker();
    const second = ids.marker();
    const document = ir({
      markers: [
        { id: first, timeMs: 0, kind: 'beat', label: 'in' },
        { id: second, timeMs: 100, kind: 'cut', label: 'out' },
      ],
    });

    expect(detectIrFeatures(document).get('markers')).toEqual([first, second]);
  });

  it('reports nothing for an empty marker list', () => {
    expect(featuresOf(ir({ markers: [] }))).toEqual(['node:group']);
  });
});

describe('irFeatureList', () => {
  it('returns the features in vocabulary order, so two decisions can be diffed', () => {
    const document = ir({
      markers: [{ id: ids.marker(), timeMs: 0, kind: 'beat', label: 'in' }],
      camera: { keyframes: [{ timeMs: 0, position: { x: 0, y: 0 } }] },
      tracks: [
        { id: ids.track(), nodeId: ROOT, channel: 'opacity', keyframes: [{ timeMs: 0, value: 1 }] },
      ],
    });

    // Vocabulary order, not insertion order: a router logs this list and a log that
    // reorders itself between two identical runs is not comparable.
    expect(irFeatureList(detectIrFeatures(document))).toEqual([
      'node:group',
      'track:opacity',
      'camera:track',
      'markers',
    ]);
  });

  it('is empty for a map with nothing in it', () => {
    expect(irFeatureList(new Map())).toEqual([]);
  });
});
