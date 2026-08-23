/**
 * The `@napi-rs/canvas` adapter - the one file in this package that talks to Skia.
 *
 * ADR-0003 chose it as the *secondary* backend precisely because it is the right amount
 * of native surface to own: prebuilt binaries, no node-gyp, no Chromium download, and
 * no GPU. Everything above it works against {@link SurfaceProvider}, so this file is
 * replaceable and the painter has never heard of it.
 *
 * `getImageData` returns **non-premultiplied** RGBA, which is what the encoder's
 * `rawvideo` input expects and what `FrameBuffer` documents. The bytes are copied out
 * of the Skia buffer rather than referenced, because the surface is reused for every
 * frame and a retained view would alias the next one.
 */

import { type Canvas, Path2D, createCanvas } from '@napi-rs/canvas';

import type { FrameBuffer } from '../../ports/frame-renderer';
import type { CanvasContext2DLike, DrawableImage, Surface2D, SurfaceProvider } from '../surface';

class NapiSurface implements Surface2D {
  readonly width: number;
  readonly height: number;
  readonly context: CanvasContext2DLike;
  readonly #canvas: Canvas;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.#canvas = createCanvas(width, height);
    this.context = this.#canvas.getContext('2d') as unknown as CanvasContext2DLike;
  }

  read(): FrameBuffer {
    const context = this.#canvas.getContext('2d');
    const image = context.getImageData(0, 0, this.width, this.height);
    return {
      width: this.width,
      height: this.height,
      data: Uint8Array.from(image.data),
    };
  }

  dispose(): void {
    // Skia frees with the Canvas object; there is nothing to release explicitly, and
    // pretending otherwise would invite a double-free-shaped bug report.
  }
}

export class NapiCanvasProvider implements SurfaceProvider {
  create(width: number, height: number): Surface2D {
    return new NapiSurface(width, height);
  }

  /**
   * Uploads raw RGBA as a canvas, because `drawImage` takes a canvas and Skia has no
   * cheap "bitmap from bytes" primitive that survives a transform.
   */
  createBitmap(buffer: FrameBuffer): DrawableImage {
    const canvas = createCanvas(buffer.width, buffer.height);
    const context = canvas.getContext('2d');
    const image = context.createImageData(buffer.width, buffer.height);
    image.data.set(buffer.data);
    context.putImageData(image, 0, 0);
    return canvas;
  }

  createPath(data: string): object {
    return new Path2D(data);
  }
}
