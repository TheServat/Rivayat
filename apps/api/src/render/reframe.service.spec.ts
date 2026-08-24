/**
 * The reframe joint, and the one decision in it.
 *
 * The solver is `@rv/render-engine`'s and is tested there. What is decided *here* is
 * where the focus comes from - the shot, the composition's camera, or a default - and
 * that is exactly the decision with a wrong answer that looks right, so it is the
 * decision these assert on.
 */

import { AnimationIR, Ids, type NodeId } from '@rv/contracts';
import { isErr } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { DEFAULT_FOCUS_REGION, ReframeBody } from './reframe.contracts';
import { REFRAMABLE_FORMATS, ReframeService } from './reframe.service';

const SUBJECT = 'nod_01J0000000000000000000000B' as NodeId;

/**
 * A subject that crosses the frame, with the camera holding still.
 *
 * The camera is static on purpose: with a moving camera the *projected* position and the
 * raw scene position differ, which is the bug `scene-projection.ts` documents and which
 * belongs to the engine's tests. Here the two agree, so a crop that follows the subject
 * is unambiguous evidence that the subject was followed at all.
 */
function crossingIr(travel = 160): AnimationIR {
  return AnimationIR.parse({
    irVersion: 1,
    id: 'anm_01J0000000000000000000000A',
    name: 'crossing',
    fps: 24,
    durationMs: 4000,
    sceneSpace: { width: 400, height: 400 },
    seed: 7,
    nodes: [
      {
        kind: 'shape',
        id: 'nod_01J0000000000000000000000A',
        name: 'backdrop',
        parentId: null,
        depth: 100,
        shape: 'rect',
        fill: '#204060',
        size: { width: 400, height: 400 },
        transform: { anchor: { x: 0.5, y: 0.5 } },
      },
      {
        kind: 'shape',
        id: SUBJECT,
        name: 'subject',
        parentId: null,
        depth: 0,
        shape: 'ellipse',
        fill: '#ffcc33',
        size: { width: 40, height: 40 },
        transform: { position: { x: -travel, y: 0 }, anchor: { x: 0.5, y: 0.5 } },
      },
    ],
    tracks: [
      {
        id: 'trk_01J0000000000000000000000A',
        nodeId: SUBJECT,
        channel: 'position.x',
        keyframes: [
          { timeMs: 0, value: -travel, easing: { kind: 'named', name: 'linear' } },
          { timeMs: 4000, value: travel, easing: { kind: 'named', name: 'linear' } },
        ],
      },
    ],
    behaviours: [],
    markers: [],
    camera: {
      keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
      focusNodeId: SUBJECT,
    },
  });
}

function service(): ReframeService {
  return new ReframeService({ ids: new Ids() });
}

function body(overrides: Record<string, unknown> = {}) {
  return ReframeBody.parse({
    ir: crossingIr(),
    formats: ['yt-1080p', 'shorts-9x16'],
    ...overrides,
  });
}

describe('ReframeService', () => {
  it('solves one plan per requested format and nothing more', () => {
    const planned = service().plan(body());
    if (isErr(planned)) throw planned.error;

    expect(Object.keys(planned.value.plans).sort()).toEqual(['shorts-9x16', 'yt-1080p']);
    expect(planned.value.plans['yt-1080p']?.targetSize.width).toBe(1920);
    expect(planned.value.plans['shorts-9x16']?.targetSize.height).toBe(1920);
  });

  it('treats a composition with no shot list as one shot, and says it did', () => {
    const planned = service().plan(body());
    if (isErr(planned)) throw planned.error;

    expect(planned.value.derivedShots).toBe(true);
    const shots = planned.value.plans['yt-1080p']?.shots ?? [];
    expect(shots).toHaveLength(1);
    // The whole timeline, not a guess at a cut.
    expect(shots[0]?.shotId).toMatch(/^sht_/);
  });

  it('follows the camera’s focus node, so a crossing subject moves the crop', () => {
    // The property the endpoint exists for. A solver that ignored the focus would give
    // the same crop for a subject on the left as for one that crosses the frame.
    const stationary = service().plan(
      ReframeBody.parse({ ir: crossingIr(0), formats: ['shorts-9x16'] }),
    );
    const crossing = service().plan(
      ReframeBody.parse({ ir: crossingIr(180), formats: ['shorts-9x16'] }),
    );
    if (isErr(stationary) || isErr(crossing)) throw new Error('expected both to solve');

    const still = stationary.value.plans['shorts-9x16']?.shots[0];
    const moving = crossing.value.plans['shorts-9x16']?.shots[0];
    expect(still).toBeDefined();
    expect(moving).toBeDefined();

    // A subject that does not move needs no pan; one that crosses either pans or is
    // solved to a different crop. Either way the two answers cannot be identical.
    expect(JSON.stringify(moving)).not.toBe(JSON.stringify(still));
  });

  it('uses the shot’s own focus node over the composition’s', () => {
    const planned = service().plan(
      body({
        shots: [
          {
            shotId: 'sht_01J0000000000000000000000A',
            startMs: 0,
            durationMs: 2000,
            focusNodeId: 'nod_01J0000000000000000000000A',
            focusRegion: { x: 0, y: 0, width: 0.2, height: 0.2 },
          },
        ],
      }),
    );
    if (isErr(planned)) throw planned.error;

    expect(planned.value.derivedShots).toBe(false);
    expect(planned.value.plans['yt-1080p']?.shots[0]?.shotId).toBe(
      'sht_01J0000000000000000000000A',
    );
  });

  it('frames on the region itself when nothing names a subject', () => {
    // A composition with no camera focus. The middle third is a default, not a guess
    // about content, and the solver still has to produce a usable crop from it.
    const ir = crossingIr();
    const cameraless = AnimationIR.parse({ ...ir, camera: { keyframes: ir.camera?.keyframes } });

    const planned = service().plan(ReframeBody.parse({ ir: cameraless, formats: ['ig-1x1'] }));
    if (isErr(planned)) throw planned.error;

    const shot = planned.value.plans['ig-1x1']?.shots[0];
    expect(shot).toBeDefined();
    expect(shot?.sourceCrop.width).toBeGreaterThan(0);
    // Centred, because the default region is.
    expect(shot?.focusPoint.x).toBeCloseTo(0.5, 1);
  });

  it('honours a hand-authored crop rather than re-solving it', () => {
    const override = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    const planned = service().plan(
      body({
        formats: ['ig-1x1'],
        shots: [
          { shotId: 'sht_01J0000000000000000000000A', startMs: 0, durationMs: 2000, override },
        ],
      }),
    );
    if (isErr(planned)) throw planned.error;

    // "Every artefact of every earlier stage is editable in the UI" - an author who has
    // framed a shot by hand must not have it re-solved underneath them.
    expect(planned.value.plans['ig-1x1']?.shots[0]?.sourceCrop).toEqual(override);
  });

  it('can solve every format the contract publishes', () => {
    // The list is derived from `FORMAT_PRESETS`, so a new platform profile is solved
    // here without anyone remembering to add it.
    const planned = service().plan(body({ formats: REFRAMABLE_FORMATS }));
    if (isErr(planned)) throw planned.error;
    expect(Object.keys(planned.value.plans)).toHaveLength(REFRAMABLE_FORMATS.length);
  });

  it('exposes a default focus region that is a centred third', () => {
    expect(DEFAULT_FOCUS_REGION.x + DEFAULT_FOCUS_REGION.width).toBeCloseTo(2 / 3, 6);
    expect(DEFAULT_FOCUS_REGION.y + DEFAULT_FOCUS_REGION.height).toBeCloseTo(2 / 3, 6);
  });
});
