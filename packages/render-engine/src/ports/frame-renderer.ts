/**
 * The one port every backend implements: give me frame `f`, as pixels.
 *
 * The shape encodes ADR-0003's central rule - **we seek, we never play**. There is no
 * `start()`, no `tick()`, no callback the renderer drives; the caller asks for a frame
 * index and gets that frame. Everything the render engine promises downstream
 * (bit-reproducibility, resume, sharding) is a restatement of the fact that
 * `renderFrame(f)` is a pure function of `(ir, f)`.
 *
 * A session is opened once per (IR, size) pair rather than per frame because both
 * backends carry expensive per-composition state - a Skia surface, or a Chromium page
 * with the scene loaded. Opening is where an unmet capability is discovered, which is
 * the whole reason {@link FrameRenderer.capabilities} is data and not a comment: a
 * composition that a backend cannot draw must fail at `open`, loudly, rather than
 * render *almost* right.
 */

import type { AppError, Result } from '@rv/shared-kernel';
import type { AnimationIR, MotionStyle, Size } from '@rv/contracts';

import type { TextStyleTable } from '../frames/draw-list';

/** The two real backends. `auto` is a selection input, never a renderer identity. */
export type FrameBackendId = 'napi-canvas' | 'pixi-playwright';

/**
 * One decoded frame: 8-bit RGBA, row-major, non-premultiplied.
 *
 * Raw rather than PNG because the encoder pipes these straight into FFmpeg's
 * `rawvideo` demuxer. A 90-second 1080p render is 2,700 frames; encoding each to PNG
 * so FFmpeg can immediately decode it again is pure waste, and writing them to disk
 * is 2,700 files.
 */
export interface FrameBuffer {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes. */
  readonly data: Uint8Array;
}

/**
 * What a backend can draw.
 *
 * Declared per backend and checked against what a composition needs, so the divergence
 * ADR-0003 calls "a real, and nasty, class of bug" becomes an error at `open` instead
 * of a subtly different picture.
 */
export const RENDER_FEATURES = [
  /** Rectangles, ellipses, lines, polygons, SVG paths. */
  'shape',
  /** Laid-out text runs, including RTL. */
  'text',
  /** Placed asset bitmaps with transforms and alpha. */
  'image',
  /** Per-instance colour multiply. */
  'tint',
  /** `fx-emitter` nodes - particle systems. */
  'particles',
  /** Shader/WebGL filters. Nothing in the IR declares one yet; see `selector.ts`. */
  'filter',
  /** Rig-driven mesh deformation rather than whole-sprite transforms. */
  'mesh-deform',
] as const;
export type RenderFeature = (typeof RENDER_FEATURES)[number];

export interface BackendCapabilities {
  readonly features: ReadonlySet<RenderFeature>;
}

/** Everything a session needs to be reproducible. Nothing here is time-dependent. */
export interface FrameSessionSpec {
  readonly ir: AnimationIR;
  /** Output pixel size. May differ from `ir.sceneSpace`; the camera scales to fit. */
  readonly size: Size;
  /** Motion settings forwarded verbatim to `evaluate`. Part of the frame's identity. */
  readonly motion?: Pick<MotionStyle, 'stepMode' | 'easings' | 'tempo'>;
  /** Background painted before anything else. `null` leaves the frame transparent. */
  readonly background?: string | null;
  /**
   * Typography tokens `TextNode.styleName` resolves against.
   *
   * Passed in rather than looked up: the tokens live in the style bible, and a golden
   * frame test has to be able to pin the exact metrics it rendered with.
   */
  readonly textStyles?: TextStyleTable;
}

/**
 * An opened backend, bound to one composition.
 *
 * `renderFrame` takes a frame **index**, not a time: the index is the unit the
 * checkpoint, the shard and the encoder all count in, and converting to a timestamp in
 * one place ({@link module:frames/frame-clock}) is what stops two call sites
 * disagreeing about whether frame 30 is at 1000 ms or 1000.0000001 ms.
 */
export interface FrameSource {
  readonly backend: FrameBackendId;
  renderFrame(frame: number): Promise<Result<FrameBuffer, AppError>>;
  close(): Promise<void>;
}

export interface FrameRenderer {
  readonly id: FrameBackendId;
  readonly capabilities: BackendCapabilities;
  open(spec: FrameSessionSpec): Promise<Result<FrameSource, AppError>>;
}

/**
 * Where the bitmap for a placed asset comes from.
 *
 * A port rather than a filesystem read because the render engine is an application
 * layer: the content-addressed store, the sprite atlas and the test fixture are all
 * legitimate sources, and none of them belongs in the frame loop.
 *
 * Resolution happens once at `open`, not per frame. Asset references in an IR are
 * pinned (`PinnedAssetRef`), so the bitmap for a node cannot change mid-render - and
 * re-resolving per frame would make the loop's cost depend on the store's cache state.
 */
export interface AssetImagePort {
  /**
   * `null` means "this reference resolves to nothing", which is a missing asset and an
   * error at the call site - not a silent blank.
   */
  load(key: string): Promise<Result<FrameBuffer | null, AppError>>;
}
