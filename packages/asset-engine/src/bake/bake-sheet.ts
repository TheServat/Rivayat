/**
 * `bakeSheet(version, clip, settings)` → `atlas.png` + `atlas.json` (RV-129).
 *
 * A sprite sheet is a **derived artefact**. It is rendered from the rig and the clip on
 * demand, cached in the content store, and rebuildable at any time; it is never the
 * source of truth, which is why re-timing or restyling a clip costs nothing and why
 * deleting a sheet is safe. The test that keeps that honest is the boring one: bake
 * twice, get the same hash.
 *
 * Determinism comes from three places, all of them deliberate. `evaluate(ir, t)` in
 * `@rv/anim-engine` is a pure function of time. The software rasteriser samples
 * nearest-neighbour with no floating-point tie-breaks that depend on evaluation order.
 * And `PngRaster` writes one fixed filter at one fixed deflate level. Swap any of the
 * three for something that optimises adaptively and the hash starts moving under you.
 */

import {
  type AppError,
  type Clock,
  type Result,
  ValidationError,
  err,
  isErr,
  ok,
  toIso,
} from '@rv/shared-kernel';
import type {
  AnimationClip,
  AnimationIR,
  MotionStyle,
  Part,
  Rect,
  Sha256Hex,
  SheetId,
  Size,
  SpriteSheet,
  Vec2,
} from '@rv/contracts';
import { evaluate } from '@rv/anim-engine';
import type { BlobStore } from '@rv/asset-registry';
import { MaxRectsPacker } from 'maxrects-packer';

import { contentId } from '../content-ids';
import type { RasterPort, RgbaImage } from '../ports/raster-port';
import { drawAffine, placementMatrix } from './rasterise';

export interface BakeSheetDeps {
  readonly raster: RasterPort;
  readonly blobs: BlobStore;
  readonly clock: Clock;
}

export interface BakeSheetSettings {
  readonly fps?: number;
  /** Frames to render. Defaults to one full loop of the clip at `fps`. */
  readonly frames?: number;
  readonly maxSize?: number;
  readonly padding?: number;
  readonly trim?: boolean;
}

export interface BakeSheetInput {
  readonly clip: AnimationClip;
  readonly ir: AnimationIR;
  /**
   * The version's parts, with their canvas geometry.
   *
   * The `Rig` is deliberately **not** an input. The IR fragment's nodes are named after
   * the template's bone roles and a `Part` carries its role, so the join is by role and
   * a baked sheet does not depend on which bone ids a particular fitting minted. That
   * is what lets one fragment bake against every asset of its archetype.
   */
  readonly parts: readonly Part[];
  /** Decoded part bitmaps, keyed by `Part.imageHash`. */
  readonly images: ReadonlyMap<Sha256Hex, RgbaImage>;
  readonly canvas: Size;
  /** Supplies the step cadence and easing curves the evaluator quantises against. */
  readonly motion: MotionStyle;
  readonly settings?: BakeSheetSettings;
}

export interface BakedPage extends Omit<SpriteSheet, 'id'> {
  readonly id: SheetId;
  /** `atlas.json` as it was written to the store, so a caller can serve it directly. */
  readonly atlasJson: string;
}

export interface BakeSheetOutput {
  /**
   * One entry per atlas page.
   *
   * Almost always one. A clip that does not fit `maxSize` spills to a second page
   * rather than failing (RV-129), which is why this is a list - `SpriteSheet` in
   * `@rv/contracts` models a single page, so a spill is several records rather than one
   * record with several images.
   */
  readonly pages: readonly BakedPage[];
  readonly frameCount: number;
}

const DEFAULT_MAX_SIZE = 2048;
const DEFAULT_PADDING = 2;

export class BakeSheetUseCase {
  readonly #deps: BakeSheetDeps;

  constructor(deps: BakeSheetDeps) {
    this.#deps = deps;
  }

  async execute(input: BakeSheetInput): Promise<Result<BakeSheetOutput, AppError>> {
    const settings = input.settings ?? {};
    const fps = settings.fps ?? input.clip.fps;
    const padding = settings.padding ?? DEFAULT_PADDING;
    const maxSize = settings.maxSize ?? DEFAULT_MAX_SIZE;
    const trim = settings.trim ?? true;
    const frameCount =
      settings.frames ?? Math.max(1, Math.round((input.clip.durationMs / 1000) * fps));

    if (frameCount < 1) {
      return err(
        new ValidationError({
          message: 'a sheet needs at least one frame',
          context: { frameCount },
        }),
      );
    }

    const rendered: { image: RgbaImage; offset: Vec2 }[] = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      const timeMs = (frame * 1000) / fps;
      const full = this.#renderFrame(input, timeMs);
      if (!trim) {
        rendered.push({ image: full, offset: { x: 0, y: 0 } });
        continue;
      }
      const bounds = this.#deps.raster.trimBounds(full, 0);
      if (bounds === null) {
        // A wholly transparent frame is legitimate - a `fade` ends on one - and it still
        // needs a rect, or the frame indices stop matching the clip's timeline.
        rendered.push({
          image: this.#deps.raster.blank({ width: 1, height: 1 }),
          offset: { x: 0, y: 0 },
        });
        continue;
      }
      const cropped = this.#deps.raster.crop(full, bounds);
      if (isErr(cropped)) return cropped;
      rendered.push({ image: cropped.value, offset: { x: bounds.x, y: bounds.y } });
    }

    const packer = new MaxRectsPacker<PackedRect>(maxSize, maxSize, padding, {
      smart: true,
      pot: false,
      square: false,
      allowRotation: false,
    });
    packer.addArray(
      rendered.map((entry, index) => ({
        width: entry.image.width,
        height: entry.image.height,
        x: 0,
        y: 0,
        frame: index,
      })),
    );

    const createdAt = toIso(this.#deps.clock.now());
    const pages: BakedPage[] = [];

    for (const [pageIndex, bin] of packer.bins.entries()) {
      const atlas = this.#deps.raster.blank({ width: bin.width, height: bin.height });
      // Sorted by frame so the composite order - and therefore the bytes - does not
      // depend on the packer's internal traversal.
      const rects = [...bin.rects].sort((left, right) => left.frame - right.frame);

      const frames: { rect: Rect; trimOffset: Vec2 }[] = [];
      for (const rect of rects) {
        const entry = rendered[rect.frame];
        if (entry === undefined) continue;
        const placed = this.#deps.raster.composite(atlas, entry.image, rect.x, rect.y);
        if (isErr(placed)) return placed;
        atlas.data.set(placed.value.data);
        frames.push({
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          trimOffset: entry.offset,
        });
      }

      const encoded = this.#deps.raster.encode(atlas);
      if (isErr(encoded)) return encoded;
      const imageStored = await this.#deps.blobs.put(encoded.value.data);
      if (isErr(imageStored)) return imageStored;

      const sheet = {
        clipId: input.clip.id,
        atlasImageHash: imageStored.value.hash,
        frameCount: frames.length,
        fps,
        frameSize: input.canvas,
        atlasSize: { width: bin.width, height: bin.height },
        frames,
        trimmed: trim,
        padding,
        createdAt,
      };

      const atlasJson = JSON.stringify({ page: pageIndex, ...sheet }, null, 2);
      const jsonStored = await this.#deps.blobs.put(new TextEncoder().encode(atlasJson));
      if (isErr(jsonStored)) return jsonStored;

      pages.push({
        // Derived from the atlas bytes: rebuilding an identical sheet yields an
        // identical id, which is what "sheets are derived, never source of truth"
        // means in practice.
        id: contentId<SheetId>('atl', `${input.clip.id}:${imageStored.value.hash}`),
        ...sheet,
        atlasJsonHash: jsonStored.value.hash,
        atlasJson,
      });
    }

    return ok({ pages, frameCount });
  }

  /**
   * One frame: evaluate the IR, then draw every part through its role's node.
   *
   * Parts are drawn in `zOrder`, not in node order. The IR's node order is the rig's
   * hierarchy and says nothing about who occludes whom - that is the part's own
   * property, which is why `Part.zOrder` exists and why the spec declared it before
   * anything was drawn.
   */
  #renderFrame(input: BakeSheetInput, timeMs: number): RgbaImage {
    const snapshot = evaluate(input.ir, timeMs, {
      motion: {
        stepMode: input.motion.stepMode,
        easings: input.motion.easings,
        tempo: input.motion.tempo,
      },
    });

    const nameByNodeId = new Map(input.ir.nodes.map((node) => [node.id, node.name]));
    const transformByRole = new Map(
      snapshot.nodes.map((node) => [nameByNodeId.get(node.nodeId) ?? '', node]),
    );

    const canvas = this.#deps.raster.blank(input.canvas);
    const ordered = [...input.parts].sort(
      (left, right) => left.zOrder - right.zOrder || left.name.localeCompare(right.name),
    );

    for (const part of ordered) {
      const bitmap = input.images.get(part.imageHash);
      if (bitmap === undefined) continue;

      const resolved = transformByRole.get(part.role);
      const transform = resolved?.worldTransform ?? IDENTITY_TRANSFORM;
      if (resolved !== undefined && !resolved.visible) continue;

      drawAffine(
        canvas,
        bitmap,
        placementMatrix({
          transform,
          restPivot: {
            x: part.bounds.x + part.pivot.x * part.bounds.width,
            y: part.bounds.y + part.pivot.y * part.bounds.height,
          },
          localPivot: { x: part.pivot.x * bitmap.width, y: part.pivot.y * bitmap.height },
        }),
        transform.opacity,
      );
    }

    return canvas;
  }
}

interface PackedRect {
  width: number;
  height: number;
  x: number;
  y: number;
  frame: number;
  [key: string]: unknown;
}

const IDENTITY_TRANSFORM = {
  position: { x: 0, y: 0 },
  rotation: 0,
  scale: { x: 1, y: 1 },
  skew: { x: 0, y: 0 },
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
} as const;
