/**
 * Everything the asset engine needs the outside world to provide.
 *
 * The image, edit and vision ports are **not** re-declared here: they already exist in
 * `@rv/providers` as the narrow ports of architecture §5, and a second copy would be a
 * second thing to keep in step. The three declared locally are the ones no other
 * package owns - pixels, mattes and atlas packing.
 */

export type { EncodedImage, RasterPort, RgbaImage } from './raster-port';
export type {
  MatteRequest,
  MatteResult,
  MattingEngineId,
  MattingPort,
  SegmentationModel,
} from './matting-port';
