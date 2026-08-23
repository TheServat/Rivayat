/**
 * The default backend: offscreen Skia, no browser, no GPU.
 *
 * ADR-0003's reasoning in one line - most shots in a paper-cutout series are flat 2D,
 * headless Chrome costs 8-15 s per 150 frames at 1080p (research §6), and almost all of
 * that is browser overhead rather than drawing. This path pays none of it.
 *
 * It is a thin composition on purpose: {@link SurfaceFrameRenderer} owns the loop and
 * {@link NapiCanvasProvider} owns Skia, so the only thing this file decides is *which
 * features the backend claims*. Getting that list wrong is the one way this backend can
 * be dangerous, so it is stated here, next to the constructor, and nowhere else.
 */

import type { AssetImagePort } from '../../ports/frame-renderer';
import { CANVAS_FEATURES } from '../selector';
import { SurfaceFrameRenderer } from '../surface-renderer';
import { NapiCanvasProvider } from './napi-surface';

export interface NapiCanvasBackendOptions {
  /** Required only for compositions that place asset instances. */
  readonly assets?: AssetImagePort;
}

export function createNapiCanvasBackend(
  options: NapiCanvasBackendOptions = {},
): SurfaceFrameRenderer {
  return new SurfaceFrameRenderer({
    id: 'napi-canvas',
    features: CANVAS_FEATURES,
    provider: new NapiCanvasProvider(),
    ...(options.assets === undefined ? {} : { assets: options.assets }),
  });
}

export { NapiCanvasProvider } from './napi-surface';
