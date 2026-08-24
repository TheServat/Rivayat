/**
 * `@rv/style-engine`'s `RasterPort`, over `@rv/asset-engine`'s pure PNG codec.
 *
 * Two packages declare a raster port because two packages need pixels, and they declare
 * *different* ports on purpose: the asset engine needs crop, composite and trim for
 * splitting and atlas baking, and the style engine needs exactly one method - decode -
 * because all it does with pixels is measure a palette. Merging them would give the style
 * engine five methods it must never call.
 *
 * So this is the adapter, and it is three lines because the shapes already agree: both
 * `RgbaImage`s are non-premultiplied 8-bit RGBA, row-major, for the same stated reason -
 * a premultiplied buffer has already blended transparent pixels toward black, which drags
 * every measured colour toward the shadow end of the palette.
 *
 * `PngRaster` rather than a `sharp` adapter because nothing here needs one: the images a
 * style is derived from are a handful of references, decoded once, and a pure decoder
 * removes a native dependency from the boot path of the whole API. The day a reference is
 * a 40-megapixel JPEG, this is the one class that changes.
 */

import { PngRaster } from '@rv/asset-engine';
import type { ImagePayload } from '@rv/providers';
import type { RasterPort, RgbaImage } from '@rv/style-engine';
import type { AppError, Result } from '@rv/shared-kernel';

export class PngStyleRaster implements RasterPort {
  readonly #raster = new PngRaster();

  /**
   * Async by the port's shape, synchronous in fact.
   *
   * The port is a promise because a `sharp`-backed implementation would be; this one
   * decodes in-process and resolves immediately. Wrapping rather than changing the port
   * keeps the door open for the codec that does need IO.
   */
  decode(image: ImagePayload): Promise<Result<RgbaImage, AppError>> {
    return Promise.resolve(this.#raster.decode({ mimeType: image.mimeType, data: image.data }));
  }
}
