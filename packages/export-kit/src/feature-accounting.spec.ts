/**
 * Nothing leaves the IR unaccounted for.
 *
 * `IR_FEATURES` is the vocabulary two independent things use: `detectIrFeatures` says what a
 * document contains, and every exporter declares what it can carry. The failure mode is
 * quiet on both sides - a feature the detector never emits is a feature no format is ever
 * asked about, and a feature an exporter forgets to classify is a file with something
 * missing from it and nothing in the warning list to say so.
 *
 * So this file asserts the closure rather than any one format's opinion:
 *
 *  1. There is a document that exercises **every** member of `IR_FEATURES`. Adding a
 *     feature without giving `detectIrFeatures` a way to see it fails here.
 *  2. Every feature that document uses is, for every registered format, either declared
 *     exact or named in a warning with the ids that carry it. Never silently absent.
 *  3. No format declares a feature both exactly and approximately, which would make
 *     `diffFeatures` pick one and hide the other.
 */

import { describe, expect, it } from 'vitest';
import {
  AnimationIR as AnimationIRSchema,
  type AnimationIR,
  IR_FEATURES,
  type IrFeature,
  detectIrFeatures,
} from '@rv/contracts';

import { createDefaultRegistry } from './registry';
import type { Exporter } from './port';
import { testClock, testIds } from './__fixtures__/ids';
import { SharpPngEncoder } from './__fixtures__/images';

const SCENE = { width: 1920, height: 1080 };

/**
 * One document that uses everything the IR can express.
 *
 * Deliberately absurd as a piece of animation and exactly right as a test input: the
 * point is coverage of the vocabulary, and a fixture that covers "a realistic scene"
 * covers whatever the author happened to think of.
 */
function maximalIr(): AnimationIR {
  const ids = testIds();
  const root = ids.node();
  const instance = ids.node();
  const part = ids.node();
  const bone = ids.node();
  const text = ids.node();
  const shape = ids.node();
  const emitter = ids.node();
  const prop = ids.node();

  const channels = [
    'position.x',
    'position.y',
    'rotation',
    'scale.x',
    'scale.y',
    'skew.x',
    'skew.y',
    'anchor.x',
    'anchor.y',
    'opacity',
    'depth',
    'tint.r',
    'tint.g',
    'tint.b',
    'clip.speed',
    'fx.intensity',
    'text.reveal',
    'path.progress',
  ] as const;

  const behaviourBase = { nodeId: root, seed: 7 };

  return AnimationIRSchema.parse({
    irVersion: 1,
    id: ids.animation(),
    name: 'Every Feature',
    fps: 24,
    durationMs: 1000,
    sceneSpace: SCENE,
    seed: 11,
    nodes: [
      { id: root, name: 'root', parentId: null, kind: 'group' },
      {
        id: instance,
        name: 'hero',
        parentId: root,
        kind: 'asset-instance',
        // `video` rather than the default `cutout`: footage is the one representation a
        // canvas backend genuinely cannot draw, so it is the one that must appear in a
        // format's warnings rather than being silently dropped.
        asset: {
          assetId: ids.asset(),
          versionId: ids.assetVersion(),
          representation: 'video',
        },
        clipName: 'idle',
        tint: '#ff8800',
        flipX: true,
      },
      {
        id: part,
        name: 'hand',
        parentId: root,
        kind: 'part',
        instanceId: instance,
        partId: ids.part(),
      },
      {
        id: bone,
        name: 'spine',
        parentId: root,
        kind: 'bone',
        instanceId: instance,
        boneId: ids.bone(),
      },
      {
        id: text,
        name: 'caption',
        parentId: root,
        kind: 'text',
        text: 'برخاست',
        direction: 'rtl',
      },
      {
        id: shape,
        name: 'sigil',
        parentId: root,
        kind: 'shape',
        shape: 'path',
        geometry: 'M0,0 L10,10',
        fill: '#112233',
      },
      {
        // Parented to the *instance* rather than to the root, because an attachment
        // refines where on its parent a node hangs and only an asset-instance has a rig
        // to hang off.
        id: prop,
        name: 'lantern',
        parentId: instance,
        kind: 'asset-instance',
        asset: { assetId: ids.asset(), versionId: ids.assetVersion() },
        attachment: { anchor: 'grip-right' },
      },
      {
        id: emitter,
        name: 'dust',
        parentId: root,
        kind: 'fx-emitter',
        effect: 'dust',
        rate: 12,
        area: { width: 100, height: 100 },
        seed: 3,
      },
    ],
    tracks: channels.map((channel, index) => ({
      id: ids.track(),
      nodeId: root,
      channel,
      // One track carries every track *semantic* as well as its channel, so `additive`,
      // the extrapolation modes and a multi-step hold are all present in the document.
      additive: index === 0,
      before: index === 0 ? 'loop' : 'hold',
      after: index === 0 ? 'ping-pong' : 'hold',
      keyframes: [
        {
          timeMs: 0,
          value: 0,
          ...(index === 0 ? { easing: { kind: 'stepped', at: 'start', steps: 3 } } : {}),
        },
        { timeMs: 500, value: 1 },
      ],
    })),
    behaviours: [
      { ...behaviourBase, id: ids.behaviour(), kind: 'wind' },
      { ...behaviourBase, id: ids.behaviour(), kind: 'breathe' },
      { ...behaviourBase, id: ids.behaviour(), kind: 'blink' },
      { ...behaviourBase, id: ids.behaviour(), kind: 'sway' },
      { ...behaviourBase, id: ids.behaviour(), kind: 'walk-cycle' },
      { ...behaviourBase, id: ids.behaviour(), kind: 'flap' },
      {
        ...behaviourBase,
        id: ids.behaviour(),
        kind: 'orbit',
        centre: { x: 0, y: 0 },
        radius: { x: 50, y: 25 },
      },
      { ...behaviourBase, id: ids.behaviour(), kind: 'parallax' },
      { ...behaviourBase, id: ids.behaviour(), kind: 'boil' },
      { ...behaviourBase, id: ids.behaviour(), kind: 'spring' },
      { ...behaviourBase, id: ids.behaviour(), kind: 'look-at', targetNodeId: instance },
      {
        ...behaviourBase,
        id: ids.behaviour(),
        kind: 'follow-path',
        path: 'M0,0 L100,0',
        durationMs: 1000,
      },
      {
        ...behaviourBase,
        id: ids.behaviour(),
        kind: 'lip-sync',
        phonemes: [{ timeMs: 0, viseme: 'aa', durationMs: 100 }],
      },
    ],
    markers: [{ id: ids.marker(), timeMs: 0, kind: 'beat', label: 'in' }],
    camera: {
      keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
      focusNodeId: instance,
      shakeAmplitude: 0.2,
      shakeSeed: 5,
      // Not orthographic, because this fixture's job is to exercise every member of
      // `IR_FEATURES` - and the default would leave `camera:projection` undetected,
      // which is precisely what the test below is built to notice.
      projection: 'isometric',
    },
  });
}

function allExporters(): readonly Exporter[] {
  return createDefaultRegistry({ encoder: new SharpPngEncoder(), clock: testClock() }).list();
}

describe('the feature vocabulary', () => {
  it('is fully exercised by one document, so no feature goes permanently unasked', () => {
    const detected = detectIrFeatures(maximalIr());
    const missing = IR_FEATURES.filter((feature) => !detected.has(feature));
    expect(missing, `no fixture exercises: ${missing.join(', ')}`).toEqual([]);
  });

  it('names the ids that carry each feature, so a warning is actionable', () => {
    for (const [feature, ids] of detectIrFeatures(maximalIr())) {
      expect(ids.length, `${feature} was detected with no id attached`).toBeGreaterThan(0);
      for (const id of ids) expect(typeof id).toBe('string');
    }
  });
});

describe('every registered format accounts for everything the document uses', () => {
  const detected = detectIrFeatures(maximalIr());
  const present = [...detected.keys()];

  it.each(allExporters().map((exporter) => [exporter.id, exporter] as const))(
    '%s classifies every present feature as exact, or warns about it by name',
    (_id, exporter) => {
      const warned = new Set<IrFeature>(
        createDefaultRegistry({ encoder: new SharpPngEncoder(), clock: testClock() })
          .preview(maximalIr())
          .filter((entry) => entry.format === exporter.id)
          .flatMap((entry) => entry.warnings.map((warning) => warning.feature)),
      );

      const unaccounted = present.filter(
        (feature) => !exporter.capabilities.exact.has(feature) && !warned.has(feature),
      );
      expect(unaccounted, `${exporter.id} loses these silently`).toEqual([]);
    },
  );

  it.each(allExporters().map((exporter) => [exporter.id, exporter] as const))(
    '%s does not declare one feature both exactly and approximately',
    (_id, exporter) => {
      const both = [...exporter.capabilities.exact].filter((feature) =>
        exporter.capabilities.approximate.has(feature),
      );
      expect(both).toEqual([]);
    },
  );

  it.each(allExporters().map((exporter) => [exporter.id, exporter] as const))(
    '%s declares only features that exist in the vocabulary',
    (_id, exporter) => {
      const known = new Set<string>(IR_FEATURES);
      const declared = [
        ...exporter.capabilities.exact,
        ...exporter.capabilities.approximate.keys(),
      ];
      expect(declared.filter((feature) => !known.has(feature))).toEqual([]);
    },
  );

  it('carries the ids through to the warning, not just the feature name', () => {
    const preview = createDefaultRegistry({
      encoder: new SharpPngEncoder(),
      clock: testClock(),
    }).preview(maximalIr());

    for (const entry of preview) {
      for (const warning of entry.warnings) {
        expect(
          warning.ids.length,
          `${entry.format} warns about ${warning.feature} without saying what carries it`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
