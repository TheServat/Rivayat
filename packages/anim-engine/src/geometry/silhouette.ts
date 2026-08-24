/**
 * What a node covers on screen, as a polygon in scene space.
 *
 * `evaluate` answers "where is this node"; a picture is made of "what does this node
 * cover", and the difference between the two is the entire gap this module closes. The
 * missing input is the node's own **extent** - how large the thing being drawn is - and
 * the IR carries that for the node kinds that own their geometry (`shape`, `fx-emitter`)
 * and not for the ones that borrow it from elsewhere (an `asset-instance` is as big as
 * whatever the registry resolved). So extents come from two places: derived from the
 * document where the document knows, supplied by the caller where it does not.
 *
 * A node the checker cannot measure is **counted and reported**, never silently skipped.
 * A gate that measures nothing and announces "clean" is worse than no gate, because it
 * converts an unknown into a false assurance.
 */

import { require_ } from '@rv/shared-kernel';
import type { AnimationIR, AnimNode, NodeId, Size, Transform2D, Vec2 } from '@rv/contracts';
import { FORMAT_PRESETS } from '@rv/contracts';

import { transformPoint } from '../transform';
import type { ConvexPolygon } from './polygon';

export const SILHOUETTE_SHAPES = ['rect', 'ellipse'] as const;
export type SilhouetteShape = (typeof SILHOUETTE_SHAPES)[number];

/**
 * How much space a node's artwork occupies in the node's own local units.
 *
 * `shape` is not decoration. A wing is an ellipse and its bounding box is 21 % larger
 * than it is; checking a joint against the box rather than the shape is the difference
 * between measuring the drawing and measuring a rectangle that contains it.
 */
export interface NodeExtent {
  readonly width: number;
  readonly height: number;
  readonly shape: SilhouetteShape;
}

/**
 * How finely an ellipse is approximated.
 *
 * 32 is where the approximation stops mattering at the scale a seam is judged on: the
 * polygon **circumscribes** the ellipse, overshooting it by `1/cos(pi/n) - 1`, which at
 * n = 32 is 0.48 % of the radius - under a twentieth of a pixel on a 12 px wing.
 *
 * Circumscribing rather than inscribing is deliberate and asymmetric. It makes every
 * *separation* answer conservative - two shapes reported as apart are certainly apart,
 * so a finding is never an artefact of the approximation - at the cost of making a
 * *containment* answer pessimistic by the same 0.48 %, which is the direction a
 * containment check should err in anyway.
 */
export const DEFAULT_ELLIPSE_SEGMENTS = 32;

/**
 * Which IR shape kinds are measured as an ellipse and which as their box.
 *
 * A total record rather than a `switch` (CLAUDE.md §2): a sixth shape kind is a compile
 * error here, in the one file that has an opinion about silhouettes, instead of falling
 * through to a default that quietly measures the wrong thing. `line`, `polygon` and
 * `path` are measured as their bounding box because the IR gives their geometry as an
 * SVG string this package deliberately does not parse - the box is a superset of the
 * truth, which under-reports separations rather than inventing them.
 */
const SHAPE_SILHOUETTES: Readonly<
  Record<'rect' | 'ellipse' | 'line' | 'polygon' | 'path', SilhouetteShape>
> = {
  rect: 'rect',
  ellipse: 'ellipse',
  line: 'rect',
  polygon: 'rect',
  path: 'rect',
};

/**
 * The node's artwork as a convex polygon in scene space.
 *
 * The local box runs from `(-width * anchor.x, -height * anchor.y)` and spans
 * `width x height`, which is the same arithmetic a renderer performs when it offsets a
 * sprite by its anchor - the point being that this measures what will be *drawn* rather
 * than a second opinion about it.
 */
export function silhouetteOf(
  transform: Transform2D,
  extent: NodeExtent,
  segments: number = DEFAULT_ELLIPSE_SEGMENTS,
): ConvexPolygon {
  const originX = -extent.width * transform.anchor.x;
  const originY = -extent.height * transform.anchor.y;

  if (extent.shape === 'rect') {
    return [
      { x: originX, y: originY },
      { x: originX + extent.width, y: originY },
      { x: originX + extent.width, y: originY + extent.height },
      { x: originX, y: originY + extent.height },
    ].map((corner) => transformPoint(transform, corner));
  }

  const centreX = originX + extent.width / 2;
  const centreY = originY + extent.height / 2;
  const overshoot = 1 / Math.cos(Math.PI / segments);
  const vertices: Vec2[] = [];
  for (let i = 0; i < segments; i += 1) {
    // Half-step offset so no vertex lands on an axis: a vertex exactly on the extreme
    // would make the circumscribed polygon touch the ellipse there and understate the
    // overshoot the doc comment promises.
    const angle = ((i + 0.5) * 2 * Math.PI) / segments;
    vertices.push(
      transformPoint(transform, {
        x: centreX + Math.cos(angle) * (extent.width / 2) * overshoot,
        y: centreY + Math.sin(angle) * (extent.height / 2) * overshoot,
      }),
    );
  }
  return vertices;
}

/**
 * The extents the document already knows, keyed by node id.
 *
 * Only `shape` nodes that declared a `size` and `fx-emitter` nodes, whose `area` is
 * their extent by definition. Everything else - groups, text, asset instances, bones -
 * resolves its size somewhere outside the IR and has to be supplied by the caller, which
 * is why {@link extentsFromIr} returns a partial map rather than pretending.
 */
export function extentsFromIr(ir: AnimationIR): ReadonlyMap<NodeId, NodeExtent> {
  const extents = new Map<NodeId, NodeExtent>();
  for (const node of ir.nodes) {
    const extent = extentOfNode(node);
    if (extent !== undefined) extents.set(node.id, extent);
  }
  return extents;
}

function extentOfNode(node: AnimNode): NodeExtent | undefined {
  if (node.kind === 'shape') {
    const size = node.size;
    if (size === undefined) return undefined;
    return { width: size.width, height: size.height, shape: SHAPE_SILHOUETTES[node.shape] };
  }
  if (node.kind === 'fx-emitter') {
    return { width: node.area.width, height: node.area.height, shape: 'rect' };
  }
  return undefined;
}

/**
 * One delivered pixel, expressed in scene units - the tolerance every distance check uses.
 *
 * Picking a tolerance out of the air is how a gate ends up either screaming at every
 * legitimate rotation or sleeping through a 3 px seam, so this one is derived from the
 * thing that decides whether a defect is visible at all: the sharpest format the project
 * actually ships. A composition is authored once in `sceneSpace` and cropped per format;
 * the scene distance that one output pixel spans is `cropWidth / outputWidth`, and the
 * smallest such value across every format is the finest detail any viewer will ever see.
 *
 * For the 1920x1080 authoring canvas this repo uses, `youtube-4k` (3840x2160) is the
 * binding constraint and the answer is **0.5 scene pixels**. A gap smaller than that
 * cannot fill a whole pixel in any deliverable, so calling it a defect would be measuring
 * arithmetic rather than a picture.
 */
export function seamToleranceScenePx(
  sceneSpace: Size,
  formats: readonly { readonly size: Size }[] = Object.values(FORMAT_PRESETS),
): number {
  // An empty list would return "infinitely coarse", which reads as a passing gate rather
  // than as the configuration mistake it is.
  require_(formats.length > 0, 'a seam tolerance needs at least one delivery format');
  let finest = Infinity;
  for (const format of formats) {
    const aspect = format.size.width / format.size.height;
    // The crop is the largest undistorted rectangle of this aspect that fits the canvas.
    const cropWidth = Math.min(sceneSpace.width, sceneSpace.height * aspect);
    const scenePerOutputPixel = cropWidth / format.size.width;
    if (scenePerOutputPixel < finest) finest = scenePerOutputPixel;
  }
  return finest;
}
