/**
 * A composition that takes long enough to be killed in the middle of.
 *
 * Everything about its size is chosen against one constraint: the kill in
 * `resume.e2e-spec.ts` has to land **between two frames of a render that is genuinely
 * in flight**, from a parent process that only knows what is in the frame directory.
 *
 *  - **144 frames.** Enough that "some frames survived and some did not" is a real
 *    state rather than a coin flip.
 *  - **192x192.** A frame file is 144 KB, so the whole store is about 20 MB. At 720p it
 *    would be a gigabyte, and the test would be measuring the disk.
 *  - **300 ellipses.** Purely to make a frame cost something. Without them the whole
 *    render is 600 ms including the encode, and a parent polling every few
 *    milliseconds could plausibly miss the entire window. With them it is roughly
 *    19 ms a frame and about three seconds of drawing, which is a window a poll cannot
 *    miss. They are drawn, not skipped - `selectBackend` sees a shape-only composition
 *    and picks Skia.
 *
 * Built through `AnimationIR.parse` rather than as a literal, so a fixture that drifts
 * out of the schema fails here instead of producing a test that passes against a shape
 * the real pipeline would reject.
 */

import { AnimationIR, type NodeId } from '@rv/contracts';

export const RENDER_SIZE = { width: 192, height: 192 } as const;
export const RENDER_FPS = 24;
export const RENDER_DURATION_MS = 6000;
/** `durationMs * fps / 1000`, spelled out because assertions compare against it. */
export const RENDER_FRAMES = (RENDER_DURATION_MS * RENDER_FPS) / 1000;

const CLUTTER = 300;

function nodeId(index: number): NodeId {
  return `nod_${String(index).padStart(26, '0')}`;
}

function clutter(): unknown[] {
  return Array.from({ length: CLUTTER }, (_unused, index) => ({
    kind: 'shape',
    id: nodeId(index + 100),
    name: `clutter-${String(index)}`,
    parentId: null,
    depth: index,
    shape: 'ellipse',
    fill: '#88aa33',
    stroke: '#112233',
    strokeWidth: 2,
    size: { width: 20 + (index % 30), height: 20 + (index % 17) },
    transform: {
      position: { x: (index % 13) * 12 - 70, y: (index % 11) * 14 - 70 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: index,
    },
  }));
}

/**
 * @param variant folded into the subject's travel so two fixtures hash differently -
 * the render key is a content hash, and a test that needs two distinct renders needs
 * two distinct compositions.
 */
export function heavyIr(variant = 0): AnimationIR {
  return AnimationIR.parse({
    irVersion: 1,
    id: 'anm_00000000000000000000000001',
    name: 'resume fixture',
    fps: RENDER_FPS,
    durationMs: RENDER_DURATION_MS,
    sceneSpace: { ...RENDER_SIZE },
    seed: 7,
    nodes: [
      {
        kind: 'shape',
        id: nodeId(1),
        name: 'backdrop',
        parentId: null,
        depth: 1000,
        shape: 'rect',
        fill: '#204060',
        size: { ...RENDER_SIZE },
        transform: { anchor: { x: 0.5, y: 0.5 } },
      },
      ...clutter(),
      {
        kind: 'shape',
        id: nodeId(2),
        name: 'subject',
        parentId: null,
        depth: -10,
        shape: 'ellipse',
        fill: '#ffcc33',
        stroke: '#000000',
        strokeWidth: 3,
        size: { width: 32, height: 32 },
        transform: { position: { x: -60, y: 0 }, anchor: { x: 0.5, y: 0.5 } },
      },
    ],
    tracks: [
      {
        id: 'trk_00000000000000000000000001',
        nodeId: nodeId(2),
        channel: 'position.x',
        keyframes: [
          { timeMs: 0, value: -60 - variant, easing: { kind: 'named', name: 'linear' } },
          { timeMs: RENDER_DURATION_MS, value: 60, easing: { kind: 'named', name: 'linear' } },
        ],
      },
    ],
    behaviours: [],
    markers: [],
  });
}

/** The `payload.render` object a `POST /api/runs` for S10 carries. */
export function renderPayload(variant = 0): Record<string, unknown> {
  return {
    ir: heavyIr(variant),
    size: { ...RENDER_SIZE },
    backend: 'napi-canvas',
    frames: null,
    codec: 'h264',
    // Kept so the resume assertion can compare frame mtimes and show that the surviving
    // frames were reused rather than redrawn.
    keepFrames: true,
  };
}
