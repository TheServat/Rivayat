/**
 * Valid instances of the contract documents the schema stores whole.
 *
 * Everything here goes through the Zod schema's `parse`, so a fixture cannot drift from
 * the contract: if `ShotCamera` grows a required field, this file stops compiling
 * rather than storing a document the rest of the system would reject on read.
 */

import { sha256 } from '@rv/shared-kernel';
import {
  type Beat,
  type EmotionalValueShift,
  type Ids,
  type SceneId,
  type SceneSpace,
  type ShotAudio,
  type ShotCamera,
  type ShotLayer,
  type StyleBible,
  Beat as BeatSchema,
  EmotionalValueShift as EmotionalValueShiftSchema,
  SceneSpace as SceneSpaceSchema,
  ShotAudio as ShotAudioSchema,
  ShotCamera as ShotCameraSchema,
  ShotLayer as ShotLayerSchema,
  StyleBible as StyleBibleSchema,
} from '@rv/contracts';

import type { ActOutline } from '../schema/story';

export function styleBible(ids: Ids): StyleBible {
  return StyleBibleSchema.parse({
    id: ids.styleBible(),
    name: 'Paper Grove',
    version: 1,
    origin: 'preset',
    visual: {
      medium: 'paper-cutout',
      palette: {
        colors: [
          { name: 'moss', hex: '#4a6b3f', role: 'primary' },
          { name: 'bark', hex: '#5a4632', role: 'secondary' },
          { name: 'sky', hex: '#cfe3ef', role: 'background' },
        ],
        harmony: 'earthy',
        contrastFloor: 0.35,
        organicRamp: [],
      },
      line: {},
      shading: {},
      texture: {},
      shape: {
        roundness: 0.7,
        exaggeration: 0.4,
        headToBodyRatio: 5,
        silhouetteRule: 'Readable as a solid black shape at 64px.',
        detailDensity: 0.3,
      },
      backgroundTreatment: 'layered-parallax',
      negative: ['photorealism', 'text'],
    },
    motion: {
      fps: 24,
      stepMode: 'on-2s',
      easings: [{ name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } }],
      defaultEasing: 'ease-in-out',
      principles: {},
      boil: {},
      ambient: {},
      camera: {},
      tempo: 1,
    },
    render: {},
    prompts: {
      positive: 'layered paper cutout, matte textured paper, soft drop shadow',
      negative: 'photorealistic, 3d render, text, watermark',
      bySubject: { foliage: 'torn paper edges on every leaf cluster' },
      byModel: {},
    },
    anchors: [],
    seed: 12345,
    checksum: sha256('paper-grove') as string,
    lockedAt: null,
    createdAt: '2026-08-23T00:00:00.000Z',
  });
}

export function episodeStructure(ids: Ids, sceneId: SceneId): ActOutline[] {
  return [
    {
      id: ids.act(),
      ordinal: 1,
      title: 'Act one',
      summary: 'Kael takes a passenger he should have refused.',
      plannedSummary: null,
      turningPoint: 'He can no longer claim he did not know.',
      sequences: [
        {
          id: ids.sequence(),
          ordinal: 1,
          title: 'The jetty',
          summary: 'A stranger asks for passage.',
          plannedSummary: null,
          dramaticQuestion: 'Will he refuse the fare?',
          sceneIds: [sceneId],
        },
      ],
    },
  ];
}

export function beat(ids: Ids): Beat {
  return BeatSchema.parse({
    id: ids.beat(),
    ordinal: 1,
    title: 'The ask',
    summary: 'The stranger names the crossing.',
    plannedSummary: null,
    function: 'catalyst',
    movesEntityRefs: [ids.entity()],
  });
}

export function valueShift(): EmotionalValueShift {
  return EmotionalValueShiftSchema.parse({ axis: 'safety', from: 'neutral', to: 'negative' });
}

export function sceneSpace(): SceneSpace {
  return SceneSpaceSchema.parse({
    size: { width: 2400, height: 1600 },
    masterAspect: '16:9',
    reframeTargets: ['16:9', '9:16'],
  });
}

export function shotCamera(): ShotCamera {
  return ShotCameraSchema.parse({
    framing: 'medium',
    move: 'static',
    focusTarget: { instance: 'kael', region: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 } },
  });
}

export function shotLayer(ids: Ids): ShotLayer {
  return ShotLayerSchema.parse({
    z: 0,
    name: 'midground',
    instances: [
      {
        instance: 'kael',
        assetId: ids.asset(),
        assetVersionId: ids.assetVersion(),
        transform: {},
        depth: 1,
      },
    ],
  });
}

export function shotAudio(): ShotAudio {
  return ShotAudioSchema.parse({});
}
