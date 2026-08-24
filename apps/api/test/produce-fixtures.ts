/**
 * A generator that costs nothing and can be counted.
 *
 * The e2e suite must not open a socket - CI opening one is not a slow test, it is a test
 * that fails on somebody else's outage - so S6 is exercised against an image port that
 * draws its pixels arithmetically. That is not a weaker test than a real one for the
 * property the suite is actually about: **"we did not spend anything" is only true if no
 * call was made**, and the only way to assert that is to count calls on a port that
 * cannot be mistaken for a provider.
 *
 * The sheet it draws is deliberately the easy case - one solid blob on a flat field -
 * because the chain's hard cases (a graded field, a collapsed sheet) are already covered
 * by `@rv/asset-engine`'s own suite against real diffusion output. What this file is for
 * is the *wiring*: does the produce stage reach the port at all, does the budget guard
 * see the total first, and does what comes back reach the registry.
 */

import { PngRaster, type ProduceLanes, type RgbaImage } from '@rv/asset-engine';
import type { Size } from '@rv/contracts';
import type {
  ImageCostQuote,
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageResult,
} from '@rv/providers';
import { NO_IMAGES } from '@rv/providers';
import { ZERO_USD, ok, sha256, unwrap, type AppError, type Result } from '@rv/shared-kernel';

const raster = new PngRaster();

/** A flat field with one opaque rectangle in the middle. The field is what gets keyed. */
export function paintBlob(size: Size): Uint8Array {
  const data = new Uint8Array(size.width * size.height * 4);
  const inset = { x: Math.floor(size.width / 4), y: Math.floor(size.height / 4) };

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const offset = (y * size.width + x) * 4;
      const inside =
        x >= inset.x && x < size.width - inset.x && y >= inset.y && y < size.height - inset.y;
      // A flat neutral field, which is what the parts-sheet prompt asks a model for and
      // what `ThresholdMatting` samples from the four corners.
      data[offset] = inside ? 20 : 200;
      data[offset + 1] = inside ? 90 : 200;
      data[offset + 2] = inside ? 40 : 200;
      data[offset + 3] = 255;
    }
  }

  const image: RgbaImage = { width: size.width, height: size.height, data };
  return unwrap(raster.encode(image)).data;
}

/**
 * Counts every call, and charges for none.
 *
 * `calls` is the assertion surface. A budget test that only checked the reported cost
 * would pass on an implementation that paid for the call and then reported zero.
 */
export class CountingImagePort implements ImageGenerationPort {
  readonly requests: ImageGenerationRequest[] = [];

  get calls(): number {
    return this.requests.length;
  }

  quoteImage(_request: { readonly size?: Size; readonly count?: number }): ImageCostQuote {
    return {
      kind: 'free',
      modelRef: 'comfyui:test-checkpoint',
      nanoUsd: ZERO_USD,
      reason: 'a local lane costs electricity, which the catalogue does not price',
    };
  }

  generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>> {
    this.requests.push(request);
    const size = request.size ?? { width: 128, height: 128 };
    const data = paintBlob(size);
    return Promise.resolve(
      ok({
        images: [
          {
            mimeType: 'image/png',
            data,
            sha256: sha256(data),
            size,
            seed: request.seed ?? 0,
          },
        ],
        modelRef: 'comfyui:test-checkpoint',
        usage: { tokens: zeroTokens(), images: NO_IMAGES, latencyMs: 0 },
      }),
    );
  }
}

/** The lane table the produce stage is given, with the counting port on the free lane. */
export function countingLanes(port: CountingImagePort): ProduceLanes {
  return {
    byLane: {
      'local-parts-sheet': {
        images: port,
        provider: 'comfyui',
        model: 'test-checkpoint',
        promptEncoder: 'clip-77',
      },
    },
  };
}

function zeroTokens(): { input: number; output: number; cached: number; reasoning: number } {
  return { input: 0, output: 0, cached: 0, reasoning: 0 };
}
