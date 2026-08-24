import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { at } from '@rv/shared-kernel';
import { AnimationIR, type SceneSnapshot } from '@rv/contracts';

import {
  GOLDEN_CLIPS,
  GOLDEN_FILE_URL,
  GOLDEN_NOTE_KEY,
  cameraPanOverDepths,
  computeGoldens,
  serialiseGoldens,
  walkCycleTwoStatures,
} from '../__fixtures__/golden-clips';
import { DEFAULT_EASINGS, evaluate } from '../evaluate';
import { SCENE_HASH_QUANTUM, canonicalScene, hashClip, type ClipHash } from './scene-hash';

const BLESS = 'pnpm --filter @rv/anim-engine bless:goldens';

/** The file as it sits on disk: a note, and a hash per fixture. */
type StoredGoldens = Readonly<Record<string, ClipHash | string | undefined>>;

function storedGoldens(): StoredGoldens {
  // Read from disk rather than imported, so what is asserted is the file that is
  // committed and not a copy the bundler cached.
  expect(
    existsSync(GOLDEN_FILE_URL),
    `the blessed hashes are missing; regenerate them deliberately with \`${BLESS}\``,
  ).toBe(true);
  return JSON.parse(readFileSync(GOLDEN_FILE_URL, 'utf8')) as StoredGoldens;
}

function positionsOf(ir: AnimationIR, timeMs: number): Map<string, { x: number; y: number }> {
  const names = new Map(ir.nodes.map((node) => [node.id, node.name]));
  return new Map(
    evaluate(ir, timeMs).nodes.map((node) => [
      names.get(node.nodeId) ?? node.nodeId,
      node.worldTransform.position,
    ]),
  );
}

describe('the blessed frame hashes', () => {
  const stored = storedGoldens();

  for (const name of Object.keys(GOLDEN_CLIPS).sort()) {
    it(`"${name}" still evaluates to the frames it was blessed with`, () => {
      const build = at(Object.values(GOLDEN_CLIPS), Object.keys(GOLDEN_CLIPS).indexOf(name));
      const golden = stored[name] as ClipHash | undefined;
      expect(
        golden,
        `no blessed hash for "${name}"; a new fixture is blessed with \`${BLESS}\``,
      ).toBeDefined();

      const actual = hashClip(build());
      expect(actual.frames, `"${name}" now covers a different number of frames`).toBe(
        golden?.frames,
      );
      expect(
        actual.restHash,
        `"${name}" draws a different rest pose than the one blessed. If that was the ` +
          `point of your change, re-bless with \`${BLESS}\` and let the moved hash show ` +
          'in the diff.',
      ).toBe(golden?.restHash);
      expect(
        actual.clipHash,
        `"${name}" draws different frames than the ones blessed. If that was the point ` +
          `of your change, re-bless with \`${BLESS}\`.`,
      ).toBe(golden?.clipHash);
    });
  }

  it('holds a hash for every fixture and a fixture for every hash', () => {
    const blessed = Object.keys(stored).filter((key) => key !== GOLDEN_NOTE_KEY);
    expect(blessed.sort()).toEqual(Object.keys(GOLDEN_CLIPS).sort());
  });

  it('is byte-identical to what blessing would write, so no hand edit survives', () => {
    expect(readFileSync(GOLDEN_FILE_URL, 'utf8')).toBe(serialiseGoldens(computeGoldens()));
  });

  it('carries its own re-blessing instructions to whoever opens it', () => {
    expect(stored[GOLDEN_NOTE_KEY]).toContain(BLESS);
  });

  it('describes clips that are valid IR, so the goldens pin something real', () => {
    for (const build of Object.values(GOLDEN_CLIPS)) {
      const parsed = AnimationIR.safeParse(build());
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    }
  });
});

// ── the two defects the goldens were commissioned for ────────────────────────

describe('the parallax fixture can fail on the defect it exists for', () => {
  const ir = cameraPanOverDepths();
  const start = positionsOf(ir, 0);
  const end = positionsOf(ir, 1958);

  function travel(name: string): number {
    return (end.get(name)?.x ?? 0) - (start.get(name)?.x ?? 0);
  }

  it('moves a layer behind the camera plane with the camera, so it lags on screen', () => {
    expect(travel('far-trees')).toBeGreaterThan(1);
    expect(travel('distant-ridge')).toBeGreaterThan(travel('far-trees'));
  });

  it('moves a layer in front of the plane against the camera, so it over-travels', () => {
    // The sign is the whole defect: inverted, the background raced past the foreground.
    // A fixture with only far layers would have called that correct.
    expect(travel('near-post')).toBeLessThan(-1);
  });

  it('leaves a layer on the camera plane exactly where it was authored', () => {
    expect(travel('mid-subject')).toBeCloseTo(0, 9);
  });
});

describe('the walk fixture can fail on the defect it exists for', () => {
  const ir = walkCycleTwoStatures();

  function rise(name: string): number {
    const names = new Map(ir.nodes.map((node) => [node.id, node.name]));
    let highest = 0;
    for (let frame = 0; frame < 48; frame += 1) {
      for (const node of evaluate(ir, (frame / 24) * 1000).nodes) {
        if (names.get(node.nodeId) !== name) continue;
        // Canvas y grows downward, so a rise is a decrease.
        highest = Math.min(highest, node.worldTransform.position.y);
      }
    }
    return -highest;
  }

  it('bounces a long-strided walker further than a short-strided one at the same setting', () => {
    // Both carry `bounce: 0.6`; only the stride differs, 2:1. A bounce measured in
    // absolute pixels - which is what shipped - makes these two identical.
    expect(rise('tall-walker')).toBeCloseTo(rise('short-walker') * 2, 6);
    expect(rise('short-walker')).toBeGreaterThan(0);
  });
});

// ── the hashing itself ───────────────────────────────────────────────────────

describe('hashClip', () => {
  it('returns the same fingerprint for the same clip, or it is not a golden', () => {
    expect(hashClip(cameraPanOverDepths())).toEqual(hashClip(cameraPanOverDepths()));
  });

  it('moves when the drawing moves, or it is decoration', () => {
    const before = hashClip(walkCycleTwoStatures());
    const mutated = walkCycleTwoStatures();
    const behaviours = mutated.behaviours as { strideLength?: number }[];
    const first = at(behaviours, 0);
    first.strideLength = 61;
    expect(hashClip(mutated).clipHash).not.toBe(before.clipHash);
  });

  it('separates a pose change from a motion change', () => {
    const ir = walkCycleTwoStatures();
    const moved = walkCycleTwoStatures();
    const nodes = moved.nodes as { transform: { position: { x: number } } }[];
    at(nodes, 0).transform.position.x = -299;
    const after = hashClip(moved);
    expect(after.restHash).not.toBe(hashClip(ir).restHash);
    expect(after.clipHash).not.toBe(hashClip(ir).clipHash);
  });

  it('samples the clip at its own frame rate unless told otherwise', () => {
    expect(hashClip(cameraPanOverDepths()).frames).toBe(48);
    expect(hashClip(cameraPanOverDepths(), { sampleFps: 6 }).frames).toBe(12);
  });

  it('always covers at least one frame, so a very short clip is still pinned', () => {
    const ir = { ...cameraPanOverDepths(), durationMs: 1 } as AnimationIR;
    expect(hashClip(ir).frames).toBe(1);
  });

  it('judges the frames a motion style will actually produce', () => {
    const smooth = hashClip(cameraPanOverDepths());
    const stepped = hashClip(cameraPanOverDepths(), {
      motion: { stepMode: 'on-2s', easings: [...DEFAULT_EASINGS], tempo: 1 },
    });
    expect(stepped.clipHash).not.toBe(smooth.clipHash);
  });

  it('ignores a difference finer than a coarse quantum, and sees it at a fine one', () => {
    const nudged = cameraPanOverDepths();
    const nodes = nudged.nodes as { transform: { position: { x: number } } }[];
    at(nodes, 1).transform.position.x += 1e-7;
    expect(hashClip(nudged, { quantum: 1 }).clipHash).toBe(
      hashClip(cameraPanOverDepths(), { quantum: 1 }).clipHash,
    );
    expect(hashClip(nudged, { quantum: 1e-9 }).clipHash).not.toBe(
      hashClip(cameraPanOverDepths(), { quantum: 1e-9 }).clipHash,
    );
  });
});

describe('canonicalScene', () => {
  function snapshot(overrides: Partial<SceneSnapshot['nodes'][number]>): SceneSnapshot {
    return {
      timeMs: 0,
      frame: 0,
      camera: { position: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
      nodes: [
        {
          nodeId: 'nod_01J8ZQ4E7K9M2N4P6R8T0VGZ01',
          worldTransform: {
            position: { x: 1, y: 2 },
            rotation: 3,
            scale: { x: 1, y: 1 },
            skew: { x: 0, y: 0 },
            anchor: { x: 0.5, y: 0.5 },
            opacity: 1,
          },
          visible: true,
          depth: 0,
          bonePose: {},
          ...overrides,
        },
      ],
    };
  }

  it('records a tint, so a recolour is not a silent change', () => {
    expect(canonicalScene(snapshot({}))).not.toBe(canonicalScene(snapshot({ tint: '#ff0000' })));
  });

  it('records every bone, in a fixed order, so a pose change cannot hide behind key order', () => {
    const one = canonicalScene(snapshot({ bonePose: { arm: 10, leg: 20 } }));
    const other = canonicalScene(snapshot({ bonePose: { leg: 20, arm: 10 } }));
    expect(one).toBe(other);
    expect(one).not.toBe(canonicalScene(snapshot({ bonePose: { arm: 11, leg: 20 } })));
  });

  it('records visibility, so a part that stops being drawn moves the hash', () => {
    expect(canonicalScene(snapshot({}))).not.toBe(canonicalScene(snapshot({ visible: false })));
  });

  it('defaults to the quantum the goldens were blessed at', () => {
    expect(canonicalScene(snapshot({}))).toBe(canonicalScene(snapshot({}), SCENE_HASH_QUANTUM));
  });
});
