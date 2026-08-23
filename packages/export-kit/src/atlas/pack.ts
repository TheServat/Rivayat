/**
 * MaxRects packing, trimming, and the composite that produces the page.
 *
 * Shared by the sprite-atlas exporter and by DragonBones' companion texture page, so the
 * two cannot disagree about where a frame ended up.
 *
 * **Determinism is the requirement, not a nice-to-have.** An atlas is a derived,
 * rebuildable artefact (architecture §6), which is only true if rebuilding it produces
 * the same bytes - otherwise every rebuild invalidates every cache downstream of it. Two
 * things could make it drift and both are pinned here: the input is sorted by name with
 * a **codepoint** comparator rather than a locale-aware one, and frames are composited in
 * that same order rather than in whatever order the packer happened to place them.
 * `maxrects-packer` 2.7.3 (research §8) is itself deterministic for a given input order.
 */

import { type AppError, type Result, ValidationError, at, err, isErr, ok } from '@rv/shared-kernel';
import type { Rect, Size, Vec2 } from '@rv/contracts';
import { MaxRectsPacker } from 'maxrects-packer';

import type { AtlasOptions } from '../options';
import {
  type EncodedImage,
  type ImageEncoderPort,
  type RgbaImage,
  blankImage,
  compositeImage,
  cropImage,
  trimBounds,
} from '../pixels';

/**
 * One image to place, named.
 *
 * `sourceSize` and `sourceOffset` describe the *untrimmed* frame when the caller has
 * already cropped one: an asset part is stored as a tight bitmap plus its bounds inside
 * the asset canvas, and losing that offset is what makes a trimmed frame land in the
 * wrong place on screen.
 */
export interface AtlasFrameSource {
  readonly name: string;
  readonly image: RgbaImage;
  readonly sourceSize?: Size;
  readonly sourceOffset?: Vec2;
  /** Normalised pivot within the untrimmed frame. Defaults to the centre. */
  readonly pivot?: Vec2;
}

/**
 * Where a frame landed, and everything needed to draw it back where it belongs.
 *
 * `trimOffset` is the load-bearing field. A trimmed frame drawn at its source position
 * without adding the offset back is displaced by exactly the margin that was removed -
 * a bug that looks like bad art rather than like bad maths, which is why it survives so
 * long in pipelines that do not record it.
 */
export interface PackedFrame {
  readonly name: string;
  /** The frame's rectangle inside the page. */
  readonly rect: Rect;
  /** Where the placed pixels sit inside the untrimmed frame. */
  readonly trimOffset: Vec2;
  /** The untrimmed frame's size. */
  readonly sourceSize: Size;
  readonly trimmed: boolean;
  readonly pivot: Vec2;
}

export interface AtlasPage {
  readonly index: number;
  readonly size: Size;
  readonly image: EncodedImage;
  readonly frames: readonly PackedFrame[];
}

export interface ResolvedAtlasOptions {
  readonly name: string;
  readonly maxSize: number;
  readonly padding: number;
  readonly border: number;
  readonly trim: boolean;
  readonly alphaThreshold: number;
  readonly powerOfTwo: boolean;
  readonly square: boolean;
}

export const DEFAULT_ATLAS_NAME = 'atlas';
const DEFAULT_MAX_SIZE = 2048;
const DEFAULT_PADDING = 2;

export function resolveAtlasOptions(
  raw: AtlasOptions,
  fallbackName = DEFAULT_ATLAS_NAME,
): Result<ResolvedAtlasOptions, AppError> {
  const maxSize = raw.maxSize ?? DEFAULT_MAX_SIZE;
  const padding = raw.padding ?? DEFAULT_PADDING;
  const border = raw.border ?? 0;

  if (!Number.isInteger(maxSize) || maxSize < 1) {
    return err(
      new ValidationError({
        message: 'atlas maxSize must be a positive integer',
        context: { maxSize },
      }),
    );
  }
  if (!Number.isInteger(padding) || padding < 0 || !Number.isInteger(border) || border < 0) {
    return err(
      new ValidationError({
        message: 'atlas padding and border must be non-negative integers',
        context: { padding, border },
      }),
    );
  }

  return ok({
    name: raw.name ?? fallbackName,
    maxSize,
    padding,
    border,
    trim: raw.trim ?? true,
    alphaThreshold: raw.alphaThreshold ?? 0,
    powerOfTwo: raw.powerOfTwo ?? false,
    square: raw.square ?? false,
  });
}

/** Codepoint order. `localeCompare` varies with the host locale and would leak into the bytes. */
export function compareByCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface PackedRect {
  width: number;
  height: number;
  x: number;
  y: number;
  /** Index into the prepared frame list. `maxrects-packer` allows arbitrary extra fields. */
  slot: number;
  [field: string]: unknown;
}

interface PreparedFrame {
  readonly name: string;
  readonly image: RgbaImage;
  readonly trimOffset: Vec2;
  readonly sourceSize: Size;
  readonly trimmed: boolean;
  readonly pivot: Vec2;
}

export async function packAtlas(
  sources: readonly AtlasFrameSource[],
  options: ResolvedAtlasOptions,
  encoder: ImageEncoderPort,
): Promise<Result<readonly AtlasPage[], AppError>> {
  if (sources.length === 0) {
    return err(new ValidationError({ message: 'an atlas needs at least one frame' }));
  }

  const names = new Set(sources.map((source) => source.name));
  if (names.size !== sources.length) {
    return err(
      new ValidationError({
        message: 'atlas frame names must be unique; the JSON is keyed by them',
        context: { frames: sources.length, distinctNames: names.size },
      }),
    );
  }

  const ordered = [...sources].sort((left, right) => compareByCodepoint(left.name, right.name));

  const prepared: PreparedFrame[] = [];
  for (const source of ordered) {
    const frame = prepare(source, options);
    if (isErr(frame)) return frame;
    prepared.push(frame.value);
  }

  const oversized = prepared.find(
    (frame) => frame.image.width > options.maxSize || frame.image.height > options.maxSize,
  );
  if (oversized !== undefined) {
    return err(
      new ValidationError({
        message: `frame "${oversized.name}" is larger than the atlas page and cannot be packed`,
        context: {
          frame: oversized.name,
          width: oversized.image.width,
          height: oversized.image.height,
          maxSize: options.maxSize,
        },
      }),
    );
  }

  const packer = new MaxRectsPacker<PackedRect>(options.maxSize, options.maxSize, options.padding, {
    smart: true,
    pot: options.powerOfTwo,
    square: options.square,
    allowRotation: false,
    border: options.border,
  });
  packer.addArray(
    prepared.map((frame, slot) => ({
      width: frame.image.width,
      height: frame.image.height,
      x: 0,
      y: 0,
      slot,
    })),
  );

  const pages: AtlasPage[] = [];
  for (const [index, bin] of packer.bins.entries()) {
    const size: Size = { width: bin.width, height: bin.height };
    let canvas = blankImage(size);

    // Sorted by name, not by the packer's traversal: the composite order decides the
    // bytes wherever two frames overlap a padding pixel, and the traversal order is an
    // implementation detail of the packer.
    const rects = [...bin.rects].sort((left, right) =>
      compareByCodepoint(at(prepared, left.slot).name, at(prepared, right.slot).name),
    );

    const frames: PackedFrame[] = [];
    for (const rect of rects) {
      const frame = at(prepared, rect.slot);
      canvas = compositeImage(canvas, frame.image, rect.x, rect.y);
      frames.push({
        name: frame.name,
        rect: { x: rect.x, y: rect.y, width: frame.image.width, height: frame.image.height },
        trimOffset: frame.trimOffset,
        sourceSize: frame.sourceSize,
        trimmed: frame.trimmed,
        pivot: frame.pivot,
      });
    }

    const encoded = await encoder.encode(canvas);
    if (isErr(encoded)) return encoded;
    pages.push({ index, size, image: encoded.value, frames });
  }

  return ok(pages);
}

/**
 * Trims a frame and records what was removed.
 *
 * A wholly transparent frame keeps a 1×1 placeholder rather than disappearing: it is a
 * legitimate input - a fade ends on one - and dropping it would shift every frame index
 * after it, which is the sort of bug that shows up as an animation being one frame out
 * of sync with its audio.
 */
function prepare(
  source: AtlasFrameSource,
  options: ResolvedAtlasOptions,
): Result<PreparedFrame, AppError> {
  const declaredSize = source.sourceSize ?? {
    width: source.image.width,
    height: source.image.height,
  };
  const declaredOffset = source.sourceOffset ?? { x: 0, y: 0 };
  const pivot = source.pivot ?? { x: 0.5, y: 0.5 };

  if (!options.trim) {
    return ok({
      name: source.name,
      image: source.image,
      trimOffset: declaredOffset,
      sourceSize: declaredSize,
      trimmed: false,
      pivot,
    });
  }

  const bounds = trimBounds(source.image, options.alphaThreshold);
  if (bounds === null) {
    return ok({
      name: source.name,
      image: blankImage({ width: 1, height: 1 }),
      trimOffset: declaredOffset,
      sourceSize: declaredSize,
      trimmed: true,
      pivot,
    });
  }

  const cropped = cropImage(source.image, bounds);
  if (isErr(cropped)) return cropped;

  return ok({
    name: source.name,
    image: cropped.value,
    // The margin this crop removed, on top of whatever the caller had already removed.
    trimOffset: { x: declaredOffset.x + bounds.x, y: declaredOffset.y + bounds.y },
    sourceSize: declaredSize,
    trimmed: true,
    pivot,
  });
}
