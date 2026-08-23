/**
 * Deformation meshes, with weights that sum to 1 by construction.
 *
 * `DeformMesh` in `@rv/contracts` refines "every vertex's influence weights must sum to
 * 1", and the comment above it says why: a vertex whose weights sum to less than 1
 * shrinks toward the origin as the rig moves, which is a subtle, maddening artefact.
 * The schema will catch it - at parse time, after the rig has been built and handed
 * on. Building it correctly is cheaper than discovering it there, so normalisation
 * here is exact rather than approximate: the residual is folded into the largest
 * influence so the sum is 1 to the last representable bit, not 1 ± 1e-9.
 */

import type { BoneId, DeformMesh, PartId, Rect, Vec2 } from '@rv/contracts';

/** A bone a vertex may be weighted to, positioned in canvas pixels. */
export interface MeshBoneCandidate {
  readonly boneId: BoneId;
  readonly worldPosition: Vec2;
}

export interface BuildMeshInput {
  readonly partId: PartId;
  /** Where the part sits in the canvas, in pixels. Vertices are placed inside it. */
  readonly bounds: Rect;
  /** Non-empty. The first entry is the fallback when nothing is in range. */
  readonly bones: readonly MeshBoneCandidate[];
  readonly rows?: number;
  readonly cols?: number;
  /** At most 4 - the schema's cap, and more buys nothing at 2D scale. */
  readonly maxInfluences?: number;
  /**
   * How sharply influence falls off with distance.
   *
   * Inverse distance raised to this power. 2 keeps a limb's mesh essentially rigid near
   * its own bone while still blending across a joint, which is what a hand-authored
   * 2D rig looks like.
   */
  readonly falloff?: number;
}

const DEFAULT_GRID = 4;
const MAX_INFLUENCES = 4;

export function buildDeformMesh(input: BuildMeshInput): DeformMesh {
  const rows = clampGrid(input.rows ?? DEFAULT_GRID);
  const cols = clampGrid(input.cols ?? DEFAULT_GRID);
  const maxInfluences = Math.max(1, Math.min(MAX_INFLUENCES, input.maxInfluences ?? 2));
  const falloff = input.falloff ?? 2;

  const vertices: DeformMesh['vertices'] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const u = cols === 1 ? 0.5 : col / (cols - 1);
      const v = rows === 1 ? 0.5 : row / (rows - 1);
      vertices.push({
        uv: { x: u, y: v },
        influences: weightsFor(
          {
            x: input.bounds.x + u * input.bounds.width,
            y: input.bounds.y + v * input.bounds.height,
          },
          input.bones,
          maxInfluences,
          falloff,
        ),
      });
    }
  }

  const indices: number[] = [];
  for (let row = 0; row + 1 < rows; row += 1) {
    for (let col = 0; col + 1 < cols; col += 1) {
      const topLeft = row * cols + col;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + cols;
      const bottomRight = bottomLeft + 1;
      indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
    }
  }

  return { partId: input.partId, rows, cols, vertices, indices };
}

/** The grid has to be at least 2×2 for the schema, and 64 is its ceiling. */
function clampGrid(value: number): number {
  return Math.max(2, Math.min(64, Math.round(value)));
}

function weightsFor(
  point: Vec2,
  bones: readonly MeshBoneCandidate[],
  maxInfluences: number,
  falloff: number,
): DeformMesh['vertices'][number]['influences'] {
  const first = bones[0];
  if (first === undefined) {
    // Callers pass the part's own bone, so this is unreachable in the pipeline - but a
    // mesh with no influence is an unparseable rig, and returning one would move the
    // failure to a place with less context.
    throw new TypeError('buildDeformMesh requires at least one candidate bone');
  }

  const ranked = bones
    .map((bone) => {
      const dx = bone.worldPosition.x - point.x;
      const dy = bone.worldPosition.y - point.y;
      return { bone, distance: Math.sqrt(dx * dx + dy * dy) };
    })
    // Bone id tie-breaks the sort so two equidistant bones always resolve the same way.
    .sort(
      (left, right) =>
        left.distance - right.distance || compare(left.bone.boneId, right.bone.boneId),
    )
    .slice(0, maxInfluences);

  const raw = ranked.map((entry) => 1 / Math.pow(Math.max(entry.distance, 1e-3), falloff));
  const total = raw.reduce((sum, value) => sum + value, 0);

  const influences = ranked.map((entry, index) => ({
    boneId: entry.bone.boneId,
    weight: (raw[index] ?? 0) / total,
  }));

  return normaliseExactly(influences);
}

/**
 * Folds the floating-point residual into the largest weight.
 *
 * Dividing by the sum leaves a residual of a few ULPs, and `Math.abs(total - 1) < 1e-4`
 * would accept that - but the same arithmetic on 64 vertices of a 8×8 mesh accumulates,
 * and the refinement is checked per vertex against a fixed epsilon rather than against
 * a tolerance that scales. Correcting the dominant weight costs nothing and removes the
 * question.
 */
function normaliseExactly(
  influences: readonly { boneId: BoneId; weight: number }[],
): DeformMesh['vertices'][number]['influences'] {
  const out = influences.map((influence) => ({ ...influence }));
  let largest = 0;
  let total = 0;
  out.forEach((influence, index) => {
    total += influence.weight;
    const best = out[largest];
    if (best !== undefined && influence.weight > best.weight) largest = index;
  });

  const target = out[largest];
  if (target !== undefined) target.weight = clamp01(target.weight + (1 - total));
  return out;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
