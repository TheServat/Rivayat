/**
 * The frame loop's engine room: evaluate, join, paint, read back.
 *
 * Written once against {@link SurfaceProvider} rather than once per backend, because
 * the sequence is not backend-specific and the sequence is where determinism lives:
 *
 * ```
 * renderFrame(f) ─► evaluate(ir, frameTimeMs(f, fps))   pure, 152 tests, @rv/anim-engine
 *                ─► buildDrawList(ir, snapshot)         pure
 *                ─► paint(surface)                      the only side effect
 *                ─► surface.read()                      RGBA out
 * ```
 *
 * Nothing here reads a clock, keeps a frame counter, or carries state between frames
 * other than the surface it reuses and the bitmaps it uploaded at `open`. That is the
 * whole of the resumability and sharding story: frame `f` does not know whether frame
 * `f - 1` ever happened.
 */

import { evaluate } from '@rv/anim-engine';
import {
  NotFoundError,
  UnsupportedCapabilityError,
  err,
  ok,
  toAppError,
  type AppError,
  type Result,
} from '@rv/shared-kernel';
import type { AnimationIR } from '@rv/contracts';

import { assetImageKey, bitmapKey, buildDrawList } from '../frames/draw-list';
import { frameTimeMs } from '../frames/frame-clock';
import type {
  AssetImagePort,
  BackendCapabilities,
  FrameBackendId,
  FrameBuffer,
  FrameRenderer,
  FrameSessionSpec,
  FrameSource,
  RenderFeature,
} from '../ports/frame-renderer';
import { paint, type BitmapTable } from './painter';
import { detectFeatures, missingFeatures } from './selector';
import type { DrawableImage, Surface2D, SurfaceProvider } from './surface';
import { applyTint } from './tint';

export interface SurfaceRendererOptions {
  readonly id: FrameBackendId;
  readonly features: ReadonlySet<RenderFeature>;
  readonly provider: SurfaceProvider;
  /** Required only when the composition places asset instances. */
  readonly assets?: AssetImagePort;
}

class SurfaceFrameSource implements FrameSource {
  readonly backend: FrameBackendId;
  readonly #ir: AnimationIR;
  readonly #spec: FrameSessionSpec;
  readonly #surface: Surface2D;
  readonly #provider: SurfaceProvider;
  readonly #bitmaps: BitmapTable;

  constructor(
    backend: FrameBackendId,
    spec: FrameSessionSpec,
    surface: Surface2D,
    provider: SurfaceProvider,
    bitmaps: BitmapTable,
  ) {
    this.backend = backend;
    this.#ir = spec.ir;
    this.#spec = spec;
    this.#surface = surface;
    this.#provider = provider;
    this.#bitmaps = bitmaps;
  }

  renderFrame(frame: number): Promise<Result<FrameBuffer, AppError>> {
    try {
      const snapshot = evaluate(
        this.#ir,
        frameTimeMs(frame, this.#ir.fps),
        this.#spec.motion === undefined ? {} : { motion: this.#spec.motion },
      );
      const list = buildDrawList(this.#ir, snapshot, {
        output: this.#spec.size,
        background: this.#spec.background ?? null,
        ...(this.#spec.textStyles === undefined ? {} : { textStyles: this.#spec.textStyles }),
      });
      paint(this.#surface.context, list, { provider: this.#provider, bitmaps: this.#bitmaps });
      return Promise.resolve(ok(this.#surface.read()));
    } catch (caught: unknown) {
      // The rasteriser is the adapter boundary: a Skia failure becomes a Result here,
      // exactly once, so the frame loop never has to hold a try/catch.
      return Promise.resolve(err(toAppError(caught, 'frame rasterisation failed')));
    }
  }

  close(): Promise<void> {
    this.#surface.dispose();
    return Promise.resolve();
  }
}

/**
 * A `FrameRenderer` over any 2D surface.
 *
 * Capability checking happens at `open`, before a single frame is drawn, and names the
 * features it refused. ADR-0003's stated nightmare is a composition that renders
 * *almost* right on the wrong backend; the cure is that the wrong backend never starts.
 */
export class SurfaceFrameRenderer implements FrameRenderer {
  readonly id: FrameBackendId;
  readonly capabilities: BackendCapabilities;
  readonly #provider: SurfaceProvider;
  readonly #assets: AssetImagePort | undefined;

  constructor(options: SurfaceRendererOptions) {
    this.id = options.id;
    this.capabilities = { features: options.features };
    this.#provider = options.provider;
    this.#assets = options.assets;
  }

  async open(spec: FrameSessionSpec): Promise<Result<FrameSource, AppError>> {
    const required = detectFeatures(spec.ir);
    const missing = missingFeatures(required, this.capabilities.features);
    if (missing.length > 0) {
      return err(new UnsupportedCapabilityError(this.id, missing.join(', ')));
    }

    const bitmaps = await this.#resolveBitmaps(spec.ir);
    if (!bitmaps.ok) return bitmaps;

    const surface = this.#provider.create(spec.size.width, spec.size.height);
    return ok(new SurfaceFrameSource(this.id, spec, surface, this.#provider, bitmaps.value));
  }

  /**
   * Every bitmap the composition needs, uploaded once and tinted once.
   *
   * Resolved eagerly so a missing asset fails the render before it starts rather than
   * 1,400 frames in. Asset references in an IR are pinned, so nothing can change under
   * the session.
   */
  async #resolveBitmaps(ir: AnimationIR): Promise<Result<BitmapTable, AppError>> {
    const table = new Map<string, DrawableImage>();
    const raw = new Map<string, FrameBuffer>();

    for (const node of ir.nodes) {
      if (node.kind !== 'asset-instance') continue;
      const key = assetImageKey(node.asset, node.clipName);
      const tinted = bitmapKey(key, node.tint ?? null);
      if (table.has(tinted)) continue;

      let source = raw.get(key);
      if (source === undefined) {
        if (this.#assets === undefined) {
          return err(
            new NotFoundError('asset image port', key, {
              context: { backend: this.id, node: node.name },
            }),
          );
        }
        const loaded = await this.#assets.load(key);
        if (!loaded.ok) return loaded;
        if (loaded.value === null) {
          return err(new NotFoundError('asset bitmap', key, { context: { node: node.name } }));
        }
        source = loaded.value;
        raw.set(key, source);
      }

      const pixels = node.tint === undefined ? source : applyTint(source, node.tint);
      table.set(tinted, this.#provider.createBitmap(pixels));
    }

    return ok(table);
  }
}
