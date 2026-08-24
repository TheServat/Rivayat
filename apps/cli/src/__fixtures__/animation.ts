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
