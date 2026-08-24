/**
 * Does the clip draw the thing it meant to draw?
 *
 * Every other guard in this repo verifies a *step*: the IR parses, the evaluator is pure,
 * the frame hash is stable, the linter finds no dangling reference. None of them looks at
 * the picture. A rig whose wing pivots at the wing's own bottom-centre instead of at its
 * shoulder satisfies all of them and renders a hole through the bird's body in every
 * frame, because the defect is in the geometry the arithmetic faithfully reproduced.
 *
 * So this module measures the artefact. It samples the clip across time, builds each
 * node's silhouette from its world transform and its own extent, and asserts invariants
 * that a correct assembly satisfies and a broken one cannot:
 *
 *  - a joint closed at rest has its child's pivot **inside** the parent, so no rotation
 *    can prise it open;
 *  - a joint closed at rest never separates;
 *  - a node's inked area moves continuously, so nothing pops or vanishes between frames;
 *  - nodes declared as contained stay in the scene box, and the camera's focus stays in
 *    frame.
 *
 * It rasterises nothing, which is what makes it cheap enough to run on every clip.
 *
 * ## What it cannot see
 *
 * It measures *silhouettes*, not pixels. A part with the wrong artwork inside a correct
 * outline, a colour that vanishes against its background, a z-order that hides a
 * character behind a hill - none of those are geometry, and none of them are caught here.
 * Overlap is computed between *pairs*, so a hole enclosed by three or more parts that all
 * still touch each other is invisible to the separation check; that specific case is the
 * bird, and it is why {@link checkGeometry} leads with pivot containment rather than with
 * separation. The two are not alternatives - separation catches a part that flew off, and
 * containment catches a joint that will grind itself open.
 */

import { at, must, require_ } from '@rv/shared-kernel';
import type { AnimationIR, NodeId, Rect, SceneSnapshot, Size, Vec2 } from '@rv/contracts';

import { evaluate, type EvaluateOptions } from '../evaluate';
import { rotateVec } from '../transform';
import {
  convexSeparation,
  excursionBeyondRect,
  intersectConvex,
  polygonArea,
  signedDistanceToConvex,
  type ConvexPolygon,
} from './polygon';
import {
  DEFAULT_ELLIPSE_SEGMENTS,
  extentsFromIr,
  seamToleranceScenePx,
  silhouetteOf,
  type NodeExtent,
} from './silhouette';

/**
 * Stable, greppable codes. Never derived from a message, and never renamed silently -
 * a CI job that suppresses one of these has to name it.
 */
export const GEOMETRY_FINDING_CODES = [
  'joint.pivot-outside-parent',
  'joint.opened',
  'silhouette.area-discontinuity',
  'scene.out-of-bounds',
  'camera.focus-out-of-frame',
] as const;
export type GeometryFindingCode = (typeof GEOMETRY_FINDING_CODES)[number];

export type GeometryUnit = 'scene-px' | 'ratio';

/**
 * One defect, with its reproduction.
 *
 * `frame` is the authoritative reproducer - re-evaluating at `frame / sampleFps` returns
 * the exact geometry that produced the finding - and `timeMs` is the same instant
 * rounded, for a human reading a table. Everything is a structured field: a test that
 * asserts on these numbers still means something after somebody rewords a message.
 */
export interface GeometryFinding {
  readonly code: GeometryFindingCode;
  readonly nodeId: NodeId;
  /** The other node the finding is about: the parent, for a joint. */
  readonly relatedNodeId?: NodeId;
  readonly frame: number;
  readonly timeMs: number;
  /** The measured quantity, in `unit`. Always the worst value found for this pairing. */
  readonly measured: number;
  readonly tolerance: number;
  readonly unit: GeometryUnit;
}

export interface GeometryCheckOptions {
  /**
   * Extents for nodes whose size lives outside the IR - asset instances, and any node
   * whose renderer holds a paint table. Merged over, and winning against, whatever the
   * document declares for itself.
   */
  readonly extents?: ReadonlyMap<NodeId, NodeExtent>;
  /** Defaults to {@link seamToleranceScenePx} for the clip's own `sceneSpace`. */
  readonly toleranceScenePx?: number;
  /** Defaults to the clip's own fps: the gate should look at the frames that ship. */
  readonly sampleFps?: number;
  readonly motion?: EvaluateOptions['motion'];
  readonly ellipseSegments?: number;
  /**
   * Nodes that must not leave {@link sceneBounds}.
   *
   * Opt-in per node because "outside the scene box" is normal for a sky, a ground plane
   * or any layer deliberately oversized to survive a parallax offset. A check that fires
   * on those is a check everybody learns to ignore.
   */
  readonly containedNodeIds?: readonly NodeId[];
  /**
   * The scene box, defaulting to the canvas centred on the origin - the convention
   * `@rv/render-engine`'s `projectToNorm` maps scene space to the composition with.
   */
  readonly sceneBounds?: Rect;
  /** Check that `camera.focusNodeId` stays in frame. Off by default; needs a camera. */
  readonly checkCameraFocus?: boolean;
  /** Fraction of the frame the focus must stay within. 1 is the full frame. */
  readonly safeAreaFraction?: number;
  /**
   * Relative area change within one frame that is worth a second look. Cheap pre-filter
   * only: every candidate it raises is then confirmed or dismissed by sub-sampling.
   */
  readonly areaStepRatio?: number;
  /** Sub-samples per suspicious frame interval. */
  readonly areaSubSamples?: number;
  /**
   * Share of a frame's area change that must fall in a single sub-interval before it
   * counts as a discontinuity rather than as fast, smooth motion.
   */
  readonly areaConcentration?: number;
}

export interface GeometryReport {
  readonly findings: readonly GeometryFinding[];
  readonly sampledFrames: number;
  /** Nodes an extent was known for. **Zero means the gate measured nothing.** */
  readonly measuredNodes: number;
  /** Nodes skipped for want of an extent. Reported so a silent no-op is impossible. */
  readonly unmeasuredNodes: number;
  /** Parent/child pairs found overlapping at t=0, and therefore checked as joints. */
  readonly joints: number;
  readonly toleranceScenePx: number;
}

const DEFAULT_AREA_STEP_RATIO = 0.25;
const DEFAULT_AREA_SUB_SAMPLES = 8;
const DEFAULT_AREA_CONCENTRATION = 0.5;

interface MeasuredShape {
  readonly polygon: ConvexPolygon;
  /** Area weighted by opacity, zero when invisible: how much ink the node lays down. */
  readonly ink: number;
  readonly pivot: Vec2;
}

interface Joint {
  readonly childId: NodeId;
  readonly parentId: NodeId;
}

/**
 * How far outside the camera's frame a scene point sits, in scene units; 0 when inside.
 *
 * The same map `@rv/render-engine`'s `projectToNorm` applies, stopped one step earlier so
 * the answer is a distance rather than a fraction. A point is in frame exactly when
 * `|R(-rotation)(p - cameraPosition)|` is within `sceneSpace / (2 * zoom)` on both axes,
 * which is that function's `0 <= 0.5 + rotated * zoom / size <= 1` rearranged. Restated
 * here rather than imported because `anim-engine` sits below the renderer, and
 * `scene-projection.ts` already records that this arithmetic belongs in this package.
 */
export function cameraFrameExcursion(
  point: Vec2,
  camera: SceneSnapshot['camera'],
  sceneSpace: Size,
  safeAreaFraction: number,
): number {
  const rotated = rotateVec(
    { x: point.x - camera.position.x, y: point.y - camera.position.y },
    -camera.rotation,
  );
  const halfWidth = (sceneSpace.width * safeAreaFraction) / (2 * camera.zoom);
  const halfHeight = (sceneSpace.height * safeAreaFraction) / (2 * camera.zoom);
  return Math.max(0, Math.abs(rotated.x) - halfWidth, Math.abs(rotated.y) - halfHeight);
}

/**
 * Samples the clip and reports every geometry invariant it breaks.
 *
 * One finding per (code, node, related node) - the **worst** sample, with the frame it
 * happened on - rather than one per frame. A wing that detaches for forty consecutive
 * frames is one defect, and forty copies of it buries the other four.
 */
export function checkGeometry(ir: AnimationIR, options: GeometryCheckOptions = {}): GeometryReport {
  const segments = options.ellipseSegments ?? DEFAULT_ELLIPSE_SEGMENTS;
  const tolerance = options.toleranceScenePx ?? seamToleranceScenePx(ir.sceneSpace);
  const sampleFps = options.sampleFps ?? ir.fps;
  require_(sampleFps > 0, 'sampleFps must be positive');

  const extents = new Map<NodeId, NodeExtent>([
    ...extentsFromIr(ir),
    ...(options.extents ?? new Map<NodeId, NodeExtent>()),
  ]);
  const parentOf = new Map<NodeId, NodeId | null>(ir.nodes.map((node) => [node.id, node.parentId]));

  const frames = Math.max(1, Math.round((ir.durationMs / 1000) * sampleFps));
  const evaluateOptions: EvaluateOptions =
    options.motion === undefined ? {} : { motion: options.motion };

  const sampleWith = (
    timeMs: number,
    withOptions: EvaluateOptions,
  ): { shapes: Map<NodeId, MeasuredShape>; camera: SceneSnapshot['camera'] } => {
    const snapshot = evaluate(ir, timeMs, withOptions);
    const shapes = new Map<NodeId, MeasuredShape>();
    for (const resolved of snapshot.nodes) {
      const extent = extents.get(resolved.nodeId);
      if (extent === undefined) continue;
      const polygon = silhouetteOf(resolved.worldTransform, extent, segments);
      shapes.set(resolved.nodeId, {
        polygon,
        ink: resolved.visible ? polygonArea(polygon) * resolved.worldTransform.opacity : 0,
        pivot: resolved.worldTransform.position,
      });
    }
    return { shapes, camera: snapshot.camera };
  };

  const sample = (timeMs: number): ReturnType<typeof sampleWith> =>
    sampleWith(timeMs, evaluateOptions);
  // See `findAreaDiscontinuities`: the refinement asks whether the *motion* is
  // continuous, and a stepped cadence is a deliberate quantisation of it.
  const smooth: EvaluateOptions =
    options.motion === undefined ? {} : { motion: { ...options.motion, stepMode: 'smooth' } };
  const refine = (timeMs: number): ReturnType<typeof sampleWith> => sampleWith(timeMs, smooth);

  const worst = new Map<string, GeometryFinding>();
  const record = (finding: GeometryFinding): void => {
    const key = findingKey(finding);
    const previous = worst.get(key);
    if (previous === undefined || finding.measured > previous.measured) worst.set(key, finding);
  };

  const first = sample(0);
  const joints = findJoints(first.shapes, parentOf);
  const inkSeries = new Map<NodeId, number[]>([...first.shapes.keys()].map((id) => [id, []]));

  const containedNodeIds = options.containedNodeIds ?? [];
  const sceneBounds = options.sceneBounds ?? centredCanvas(ir.sceneSpace);
  const safeAreaFraction = options.safeAreaFraction ?? 1;
  const focusNodeId = options.checkCameraFocus === true ? ir.camera?.focusNodeId : undefined;

  for (let frame = 0; frame < frames; frame += 1) {
    const timeMs = (frame / sampleFps) * 1000;
    const { shapes, camera } = frame === 0 ? first : sample(timeMs);
    const stamp = { frame, timeMs: Math.round(timeMs), tolerance } as const;

    for (const [nodeId, series] of inkSeries) {
      series.push(must(shapes, nodeId, 'silhouette').ink);
    }

    for (const joint of joints) {
      const child = must(shapes, joint.childId, 'child silhouette');
      const parent = must(shapes, joint.parentId, 'parent silhouette');

      const outside = signedDistanceToConvex(parent.polygon, child.pivot);
      if (outside > tolerance) {
        record({
          ...stamp,
          code: 'joint.pivot-outside-parent',
          nodeId: joint.childId,
          relatedNodeId: joint.parentId,
          measured: outside,
          unit: 'scene-px',
        });
      }

      const gap = convexSeparation(child.polygon, parent.polygon);
      if (gap > tolerance) {
        record({
          ...stamp,
          code: 'joint.opened',
          nodeId: joint.childId,
          relatedNodeId: joint.parentId,
          measured: gap,
          unit: 'scene-px',
        });
      }
    }

    for (const nodeId of containedNodeIds) {
      const shape = shapes.get(nodeId);
      if (shape === undefined) continue;
      const excursion = excursionBeyondRect(shape.polygon, sceneBounds);
      if (excursion > tolerance) {
        record({
          ...stamp,
          code: 'scene.out-of-bounds',
          nodeId,
          measured: excursion,
          unit: 'scene-px',
        });
      }
    }

    if (focusNodeId !== undefined) {
      const focus = shapes.get(focusNodeId);
      if (focus !== undefined) {
        const excursion = cameraFrameExcursion(
          focus.pivot,
          camera,
          ir.sceneSpace,
          safeAreaFraction,
        );
        if (excursion > tolerance) {
          record({
            ...stamp,
            code: 'camera.focus-out-of-frame',
            nodeId: focusNodeId,
            measured: excursion,
            unit: 'scene-px',
          });
        }
      }
    }
  }

  for (const finding of findAreaDiscontinuities(inkSeries, sampleFps, options, refine)) {
    record(finding);
  }

  return {
    findings: [...worst.values()].sort(compareFindings),
    sampledFrames: frames,
    measuredNodes: extents.size,
    unmeasuredNodes: ir.nodes.length - extents.size,
    joints: joints.length,
    toleranceScenePx: tolerance,
  };
}

/** The canvas centred on the origin, which is where `projectToNorm` puts it. */
function centredCanvas(sceneSpace: Size): Rect {
  return {
    x: -sceneSpace.width / 2,
    y: -sceneSpace.height / 2,
    width: sceneSpace.width,
    height: sceneSpace.height,
  };
}

/**
 * The parent/child pairs that are welded together at rest.
 *
 * "Closed at rest" is the precondition for the joint invariants, and it is read off the
 * artwork rather than declared: two nodes whose silhouettes share area at `t=0` are a
 * joint, and two that merely happen to be related in the hierarchy are not. A bird's body
 * and its wings qualify; a bird and the hill it flies over do not, and neither does a
 * canopy floating above its trunk.
 */
function findJoints(
  shapes: ReadonlyMap<NodeId, MeasuredShape>,
  parentOf: ReadonlyMap<NodeId, NodeId | null>,
): readonly Joint[] {
  const joints: Joint[] = [];
  for (const [childId, child] of shapes) {
    // `must` rather than a nullish check: every measured node came from `ir.nodes`, so an
    // absent entry is a broken invariant and not a root node.
    const parentId = must(parentOf, childId, 'parent id');
    if (parentId === null) continue;
    const parent = shapes.get(parentId);
    if (parent === undefined) continue;
    if (polygonArea(intersectConvex(child.polygon, parent.polygon)) <= 0) continue;
    joints.push({ childId, parentId });
  }
  return joints;
}

/**
 * A pop, told apart from fast motion by refining the sample.
 *
 * Silhouette area is invariant under rotation and translation, so for a rigid part it
 * only moves when something scales, fades or disappears - which is precisely the family
 * of defects worth catching, and precisely why a flapping wing does not trip this check
 * at all. What remains is telling a legitimate fast change (a blink closes an eyelid in
 * 110 ms, most of a frame at 24 fps) from a discontinuity.
 *
 * The discriminator is the definition of continuity rather than a threshold picked to
 * taste: **a continuous change shrinks when the interval shrinks, and a jump does not.**
 * Split a suspicious frame into `areaSubSamples` intervals. A continuous function spreads
 * its variation across them, so no single interval holds much more than its `1/k` share;
 * a step puts all of it in one. Flagging at half the total means "this change is at least
 * `k/2` times more concentrated than smooth motion", which at the default k = 8 is a
 * factor of four of headroom on either side.
 *
 * The sub-samples are always taken smoothly, even when the clip renders on 2s: a stepped
 * cadence is a deliberate quantisation of continuous motion, and asking whether the
 * underlying motion is continuous is a question about the motion and not about the
 * cadence.
 */
function findAreaDiscontinuities(
  inkSeries: ReadonlyMap<NodeId, readonly number[]>,
  sampleFps: number,
  options: GeometryCheckOptions,
  sample: (timeMs: number) => { shapes: Map<NodeId, MeasuredShape> },
): readonly GeometryFinding[] {
  const stepRatio = options.areaStepRatio ?? DEFAULT_AREA_STEP_RATIO;
  const subSamples = options.areaSubSamples ?? DEFAULT_AREA_SUB_SAMPLES;
  const concentration = options.areaConcentration ?? DEFAULT_AREA_CONCENTRATION;
  require_(subSamples >= 2, 'areaSubSamples must be at least 2');

  const suspects = new Map<number, NodeId[]>();
  for (const [nodeId, series] of inkSeries) {
    for (let frame = 1; frame < series.length; frame += 1) {
      const before = at(series, frame - 1);
      const after = at(series, frame);
      const scale = Math.max(before, after);
      if (scale <= 0) continue;
      if (Math.abs(after - before) / scale <= stepRatio) continue;
      const bucket = suspects.get(frame);
      if (bucket === undefined) suspects.set(frame, [nodeId]);
      else bucket.push(nodeId);
    }
  }

  const findings: GeometryFinding[] = [];
  // Sorted so the sub-sampling - and therefore the output - does not depend on Map
  // iteration order once a caller starts building extents from an unordered source.
  for (const frame of [...suspects.keys()].sort((left, right) => left - right)) {
    const start = ((frame - 1) / sampleFps) * 1000;
    const step = 1000 / sampleFps / subSamples;
    const refined = Array.from(
      { length: subSamples + 1 },
      (_, index) => sample(start + index * step).shapes,
    );

    for (const nodeId of must(suspects, frame, 'suspect nodes')) {
      const inks = refined.map((shapes) => must(shapes, nodeId, 'refined silhouette').ink);
      let total = 0;
      let largest = 0;
      for (let index = 1; index < inks.length; index += 1) {
        const delta = Math.abs(at(inks, index) - at(inks, index - 1));
        total += delta;
        if (delta > largest) largest = delta;
      }
      if (total <= 0) continue;
      const share = largest / total;
      if (share <= concentration) continue;
      findings.push({
        code: 'silhouette.area-discontinuity',
        nodeId,
        frame,
        timeMs: Math.round((frame / sampleFps) * 1000),
        measured: share,
        tolerance: concentration,
        unit: 'ratio',
      });
    }
  }
  return findings;
}

/**
 * What makes two findings the same defect: the check, the node, and the node it is about.
 *
 * Also the sort tie-break, so one function decides both and they cannot disagree about
 * which findings are duplicates.
 */
function findingKey(finding: GeometryFinding): string {
  return `${finding.code}|${finding.nodeId}|${finding.relatedNodeId ?? ''}`;
}

/** Worst first, then by identity, so the report is a stable artefact worth diffing. */
function compareFindings(left: GeometryFinding, right: GeometryFinding): number {
  return right.measured - left.measured || findingKey(left).localeCompare(findingKey(right));
}
