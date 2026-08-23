/**
 * The 2D surface the painter draws on, described rather than imported.
 *
 * Both backends end up in front of a canvas-shaped API - Skia in-process for
 * `napi-canvas`, the browser's own for `pixi-playwright` - so the painter is written
 * once against this interface and neither backend owns any drawing logic. It is also
 * what lets the painter be tested against a recording double: every call it makes is
 * observable, so "the ellipse was drawn with these radii under this matrix" is an
 * assertion rather than a pixel guess.
 */

import type { FrameBuffer } from '../ports/frame-renderer';

/** Whatever the backend's `drawImage` accepts. Opaque to the painter. */
export interface DrawableImage {
  readonly width: number;
  readonly height: number;
}

/** The subset of `CanvasRenderingContext2D` the painter uses. Nothing more. */
export interface CanvasContext2DLike {
  globalAlpha: number;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  direction: string;

  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;

  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
  ): void;
  fill(path?: unknown): void;
  stroke(path?: unknown): void;

  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { readonly width: number };

  drawImage(image: unknown, dx: number, dy: number): void;
}

export interface Surface2D {
  readonly width: number;
  readonly height: number;
  readonly context: CanvasContext2DLike;
  /** The current pixels as non-premultiplied RGBA. */
  read(): FrameBuffer;
  dispose(): void;
}

/**
 * Creates surfaces and uploads bitmaps.
 *
 * A factory rather than a constructed surface because a session opens exactly one
 * surface and reuses it for every frame - allocating an 8 MB Skia buffer 2,700 times
 * is the difference between a render that finishes and one that thrashes.
 */
export interface SurfaceProvider {
  create(width: number, height: number): Surface2D;
  /** Turns raw RGBA into something `drawImage` accepts. */
  createBitmap(buffer: FrameBuffer): DrawableImage;
  /**
   * Compiles SVG path data into whatever the backend's `fill`/`stroke` accept.
   *
   * `null` when the backend has no `Path2D`, in which case the painter skips the item
   * rather than drawing a wrong shape. Typed as `object` rather than `unknown` because
   * `unknown | null` collapses to `unknown` and the null case would stop being visible.
   */
  createPath(data: string): object | null;
}
