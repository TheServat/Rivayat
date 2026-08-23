/**
 * Compositions to render in tests.
 *
 * Built through `AnimationIR.parse` rather than as literals, so a fixture that drifts
 * out of the schema fails loudly here instead of producing a test that passes against
 * a shape the real pipeline would reject.
 */

import { AnimationIR, type AnimationId, type NodeId } from '@rv/contracts';

/** A deterministic, schema-valid prefixed ULID. */
export function testId(prefix: string, tag: string): string {
  const body = tag.toUpperCase().replaceAll(/[^0-9A-HJKMNP-TV-Z]/g, '0');
  return `${prefix}_${body.padEnd(26, '0').slice(0, 26)}`;
}

export const ANIMATION_ID: AnimationId = testId('anm', 'FIXTURE');
export const BACKDROP_ID: NodeId = testId('nod', 'BACKDROP');
export const SUBJECT_ID: NodeId = testId('nod', 'SUBJECT');
export const TITLE_ID: NodeId = testId('nod', 'TITLE');
export const SPARKS_ID: NodeId = testId('nod', 'SPARKS');
export const INSTANCE_ID: NodeId = testId('nod', 'INSTANCE');

const SCENE = { width: 400, height: 300 };

/**
 * Pure 2D: a backdrop, a moving ellipse and a caption.
 *
 * The subject crosses the frame on a keyframed track, which is what makes it a useful
 * reframing subject as well as a useful drawing subject.
 */
export function pure2dIr(overrides: { fps?: number; durationMs?: number } = {}): AnimationIR {
  return AnimationIR.parse({
    irVersion: 1,
    id: ANIMATION_ID,
    name: 'pure 2d fixture',
    fps: overrides.fps ?? 25,
    durationMs: overrides.durationMs ?? 4000,
    sceneSpace: SCENE,
    seed: 7,
    nodes: [
      {
        kind: 'shape',
        id: BACKDROP_ID,
        name: 'backdrop',
        parentId: null,
        depth: 10,
        shape: 'rect',
        fill: '#204060',
        size: { width: 400, height: 300 },
        transform: { anchor: { x: 0.5, y: 0.5 } },
      },
      {
        kind: 'shape',
        id: SUBJECT_ID,
        name: 'subject',
        parentId: null,
        depth: 0,
        shape: 'ellipse',
        fill: '#ffcc33',
        stroke: '#000000',
        strokeWidth: 2,
        size: { width: 60, height: 60 },
        transform: { position: { x: -150, y: 0 }, anchor: { x: 0.5, y: 0.5 } },
      },
      {
        kind: 'text',
        id: TITLE_ID,
        name: 'title',
        parentId: null,
        depth: -5,
        text: 'Rivayat',
        styleName: 'title',
        color: '#ffffff',
        align: 'center',
        transform: { position: { x: 0, y: 110 }, anchor: { x: 0.5, y: 0.5 } },
      },
    ],
    tracks: [
      {
        id: testId('trk', 'CROSS'),
        nodeId: SUBJECT_ID,
        channel: 'position.x',
        keyframes: [
          { timeMs: 0, value: 0, easing: { kind: 'named', name: 'linear' } },
          { timeMs: 4000, value: 300, easing: { kind: 'named', name: 'linear' } },
        ],
      },
    ],
    behaviours: [],
    markers: [],
  });
}

/** The same composition with a particle emitter, which only the browser backend claims. */
export function particlesIr(): AnimationIR {
  const base = pure2dIr();
  return AnimationIR.parse({
    ...base,
    nodes: [
      ...base.nodes,
      {
        kind: 'fx-emitter',
        id: SPARKS_ID,
        name: 'sparks',
        parentId: null,
        depth: -10,
        effect: 'sparks',
        rate: 40,
        area: { width: 200, height: 120 },
        seed: 11,
        intensity: 0.5,
        transform: { anchor: { x: 0.5, y: 0.5 } },
      },
    ],
  });
}

/** A composition that places an asset instance, for the bitmap-resolution paths. */
export function assetIr(options: { tint?: string } = {}): AnimationIR {
  return AnimationIR.parse({
    irVersion: 1,
    id: ANIMATION_ID,
    name: 'asset fixture',
    fps: 25,
    durationMs: 1000,
    sceneSpace: SCENE,
    seed: 3,
    nodes: [
      {
        kind: 'asset-instance',
        id: INSTANCE_ID,
        name: 'fox',
        parentId: null,
        depth: 0,
        asset: {
          assetId: testId('ast', 'FOX'),
          versionId: testId('asv', 'FOXV1'),
        },
        ...(options.tint === undefined ? {} : { tint: options.tint }),
        transform: { anchor: { x: 0.5, y: 0.5 } },
      },
    ],
  });
}

/** A camera that pushes in and follows the subject; exercises `focusNodeId`. */
export function cameraIr(): AnimationIR {
  const base = pure2dIr();
  return AnimationIR.parse({
    ...base,
    camera: {
      keyframes: [
        {
          timeMs: 0,
          position: { x: -100, y: 0 },
          zoom: 1,
          rotation: 0,
          easing: { kind: 'named', name: 'linear' },
        },
        { timeMs: 4000, position: { x: 100, y: 0 }, zoom: 1.4, rotation: 0 },
      ],
      focusNodeId: SUBJECT_ID,
      shakeAmplitude: 0,
      shakeSeed: 0,
    },
  });
}
