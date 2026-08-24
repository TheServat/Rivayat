/**
 * Animation IR fixtures for the linter's specs.
 *
 * Hand-written rather than generated, because the point of each one is a specific
 * defect: the linter is judged on whether it names the right path, and a generated
 * document cannot be wrong in a chosen way.
 */

/**
 * A ULID body with the right shape. The digits carry no meaning.
 *
 * 22 fixed characters plus a four-character tail is exactly the 26 the id regex wants;
 * getting that wrong turns every fixture into six identical "expected a NodeId" issues
 * and hides whatever the fixture was actually testing.
 */
function id(prefix: string, tail: string): string {
  return `${prefix}_01J8ZQ4E7K9M2N4P6R8T0V${tail.toUpperCase().padStart(4, '0')}`;
}

export const NODE_A = id('nod', '001');
export const NODE_B = id('nod', '002');
export const TRACK_A = id('trk', '010');
export const BEHAVIOUR_A = id('bhv', '020');
export const MARKER_A = id('mrk', '030');

/** A document that validates and lints clean: two nodes, one animated, one their parent. */
export function validIr(): Record<string, unknown> {
  return {
    irVersion: 1,
    id: id('anm', '100'),
    name: 'grove',
    fps: 24,
    durationMs: 2000,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 42,
    nodes: [
      {
        kind: 'group',
        id: NODE_A,
        name: 'root',
        parentId: null,
        transform: {},
        visible: true,
        depth: 0,
      },
      {
        kind: 'shape',
        id: NODE_B,
        name: 'disc',
        parentId: NODE_A,
        transform: {},
        visible: true,
        depth: 1,
        shape: 'ellipse',
        fill: '#112233',
        size: { width: 100, height: 100 },
      },
    ],
    tracks: [
      {
        id: TRACK_A,
        nodeId: NODE_B,
        channel: 'position.x',
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 1000, value: 100 },
        ],
      },
    ],
    behaviours: [],
    markers: [],
  };
}

/** A track pointing at a node that does not exist. Caught by the schema, not by us. */
export function irWithDanglingTrack(): Record<string, unknown> {
  const ir = validIr();
  const tracks = ir.tracks as { nodeId: string }[];
  const first = tracks[0];
  if (first !== undefined) first.nodeId = id('nod', '999');
  return ir;
}

/** A parent cycle: the evaluator would not terminate, so the schema refuses it. */
export function irWithCycle(): Record<string, unknown> {
  const ir = validIr();
  const nodes = ir.nodes as { id: string; parentId: string | null }[];
  const root = nodes[0];
  if (root !== undefined) root.parentId = NODE_B;
  return ir;
}

/** Valid, but the last keyframe is past the end of the timeline. A warning, not an error. */
export function irWithLateKeyframe(): Record<string, unknown> {
  const ir = validIr();
  const tracks = ir.tracks as { keyframes: { timeMs: number; value: number }[] }[];
  tracks[0]?.keyframes.push({ timeMs: 9000, value: 200 });
  return ir;
}

/** Valid, with a behaviour that can never contribute. */
export function irWithSilentBehaviour(): Record<string, unknown> {
  const ir = validIr();
  ir.behaviours = [
    {
      kind: 'sway',
      id: BEHAVIOUR_A,
      nodeId: NODE_B,
      seed: 1,
      weight: 0,
      startMs: 5000,
    },
  ];
  return ir;
}

export const NODE_BODY = id('nod', '040');
export const NODE_WING = id('nod', '041');
export const BEHAVIOUR_FLAP = id('bhv', '042');

/**
 * The rig that shipped in `rv animate`, reduced to the two nodes that mattered.
 *
 * Schema-valid, lint-clean by every rule that existed before the geometry pass, and
 * visibly broken: the wing is offset 22 px from the body and anchored at its own
 * bottom-centre, so it rotates about a point clear of the body and tears the joint open.
 * Nothing here is exaggerated for the test - these are the numbers that put a triangular
 * hole through the bird in `workspace/demo/grove-16x9.mp4`.
 */
export function irWithWingPivotedOffTheBody(): Record<string, unknown> {
  return {
    irVersion: 1,
    id: id('anm', '140'),
    name: 'bird',
    fps: 24,
    durationMs: 1000,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 4242,
    nodes: [
      {
        kind: 'shape',
        id: NODE_BODY,
        name: 'bird',
        parentId: null,
        transform: { position: { x: 0, y: 0 }, anchor: { x: 0.5, y: 1 } },
        visible: true,
        depth: 10,
        shape: 'ellipse',
        fill: '#2f2a26',
        size: { width: 46, height: 20 },
      },
      {
        kind: 'shape',
        id: NODE_WING,
        name: 'wing-l',
        parentId: NODE_BODY,
        transform: { position: { x: -22, y: 0 }, anchor: { x: 0.5, y: 1 } },
        visible: true,
        depth: 10,
        shape: 'ellipse',
        fill: '#2f2a26',
        size: { width: 54, height: 12 },
      },
    ],
    tracks: [],
    behaviours: [
      {
        kind: 'flap',
        id: BEHAVIOUR_FLAP,
        nodeId: NODE_WING,
        seed: 11,
        hz: 5.5,
        amplitudeDeg: 46,
        downstrokeBias: 0.35,
      },
    ],
    markers: [],
  };
}

/** The same two nodes, with the wing pivoting at its shoulder instead. */
export function irWithWingPivotedAtTheShoulder(): Record<string, unknown> {
  const ir = irWithWingPivotedOffTheBody();
  const nodes = ir.nodes as { name: string; transform: Record<string, unknown> }[];
  const wing = nodes.find((node) => node.name === 'wing-l');
  if (wing !== undefined) {
    wing.transform = { position: { x: -6, y: -12 }, anchor: { x: 1, y: 0.5 } };
  }
  return ir;
}

/** Valid, animated, and completely opaque to the geometry pass: nothing declares a size. */
export function irWithNoDeclaredSizes(): Record<string, unknown> {
  const ir = validIr();
  const nodes = ir.nodes as Record<string, unknown>[];
  ir.nodes = nodes.map((node) => (node.kind === 'shape' ? { ...node, size: undefined } : node));
  return ir;
}

export const NODE_TRUNK = id('nod', '050');
export const NODE_LIMB = id('nod', '051');
export const TRACK_SWING = id('trk', '052');
export const TRACK_BLINK_OUT = id('trk', '053');

/**
 * A limb welded to a trunk at rest, and dragged clear of it by a track.
 *
 * The other half of the joint story: `joint.pivot-outside-parent` is the rig that will
 * open, and this is the one that has already opened - a measurable gap, at a nameable
 * frame, in a document that satisfies every schema rule.
 */
export function irWithLimbDraggedOffTheBody(): Record<string, unknown> {
  return {
    irVersion: 1,
    id: id('anm', '150'),
    name: 'limb',
    fps: 24,
    durationMs: 1000,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 3,
    nodes: [
      {
        kind: 'shape',
        id: NODE_TRUNK,
        name: 'trunk',
        parentId: null,
        transform: { position: { x: 0, y: 0 } },
        visible: true,
        depth: 0,
        shape: 'rect',
        size: { width: 100, height: 100 },
      },
      {
        kind: 'shape',
        id: NODE_LIMB,
        name: 'limb',
        parentId: NODE_TRUNK,
        transform: { position: { x: 40, y: 0 } },
        visible: true,
        depth: 0,
        shape: 'rect',
        size: { width: 40, height: 20 },
      },
    ],
    tracks: [
      {
        id: TRACK_SWING,
        nodeId: NODE_LIMB,
        channel: 'position.x',
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 1000, value: 360 },
        ],
      },
    ],
    behaviours: [],
    markers: [],
  };
}

/** Valid, and the disc stops being drawn between one frame and the next. */
export function irWithPartThatPops(): Record<string, unknown> {
  const ir = validIr();
  ir.durationMs = 1000;
  (ir.tracks as unknown[]).push({
    id: TRACK_BLINK_OUT,
    nodeId: NODE_B,
    channel: 'opacity',
    keyframes: [
      { timeMs: 0, value: 0 },
      { timeMs: 500, value: 0 },
      { timeMs: 501, value: -1 },
    ],
  });
  return ir;
}

/** Valid, with the disc parked far outside the scene box and the camera watching it. */
export function irWithSubjectOffCanvas(): Record<string, unknown> {
  const ir = validIr();
  const nodes = ir.nodes as { name: string; transform: Record<string, unknown> }[];
  const disc = nodes.find((node) => node.name === 'disc');
  if (disc !== undefined) disc.transform = { position: { x: 3000, y: 0 } };
  ir.tracks = [];
  ir.camera = {
    keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
    focusNodeId: NODE_B,
  };
  return ir;
}
