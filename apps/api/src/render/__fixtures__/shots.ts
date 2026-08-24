/**
 * Shots that a `Shot` schema actually accepts.
 *
 * Built through `Shot.parse` rather than as literals, so a fixture that drifts out of
 * the schema fails here instead of producing tests that pass against a shape the
 * pipeline would reject - the same reason `test/render-fixtures.ts` parses its IR.
 */

import { Shot, ShotId, type AssetInstanceKey } from '@rv/contracts';

export const SCENE = { width: 800, height: 450 } as const;

export function shotId(suffix: string): ShotId {
  return ShotId.parse(`sht_01J000000000000000000000${suffix}`);
}

/** A placed instance. `depth` is the parallax divisor, not the paint order. */
export function placed(
  instance: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    instance,
    assetId: 'ast_01J0000000000000000000000A',
    assetVersionId: 'asv_01J0000000000000000000000A',
    transform: { position: { x: 0, y: 0 } },
    depth: 1,
    ...overrides,
  };
}

const REGION = { x: 0.4, y: 0.35, width: 0.2, height: 0.3 };

/**
 * A two-band shot: a backdrop that lags and a subject on the focal plane.
 *
 * `overrides` is merged before parsing, so a test can replace the layout, the blocking
 * or the camera without restating the eleven fields it does not care about.
 */
export function shot(overrides: Record<string, unknown> = {}): Shot {
  return Shot.parse({
    id: shotId('0A'),
    index: 0,
    durationMs: 2000,
    beatRef: 'bet_01J0000000000000000000000A',
    sceneSpace: {
      size: { ...SCENE },
      masterAspect: '16:9',
      reframeTargets: ['16:9', '9:16'],
    },
    camera: {
      framing: 'wide',
      move: 'static',
      focusTarget: { instance: 'hero', region: REGION, priority: 'must-keep' },
    },
    layout: [
      { z: 0, name: 'backdrop', instances: [placed('sky', { depth: 4 })] },
      { z: 1, name: 'subjects', instances: [placed('hero')] },
    ],
    blocking: [],
    dialogue: [],
    audio: { sfx: [], music: null },
    safeArea: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
    focusTarget: { instance: 'hero', region: REGION, priority: 'must-keep' },
    ...overrides,
  });
}

/** A blocking action on `hero`, as a shot writes one. */
export function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance: 'hero' satisfies AssetInstanceKey,
    clip: 'walk-cycle',
    startMs: 400,
    durationMs: 800,
    ...overrides,
  };
}
