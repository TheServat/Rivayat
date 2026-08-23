import { unwrap } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { MapAssetImages, RecordingSurfaceProvider, solidFrame } from '../__fixtures__/doubles';
import { assetIr, pure2dIr } from '../__fixtures__/ir';
import { assetImageKey } from '../frames/draw-list';
import type { FrameBuffer } from '../ports/frame-renderer';
import type { Surface2D, SurfaceProvider } from './surface';
import { CANVAS_FEATURES } from './selector';
import { SurfaceFrameRenderer } from './surface-renderer';

const SIZE = { width: 40, height: 30 };

function renderer(provider: SurfaceProvider, assets?: MapAssetImages): SurfaceFrameRenderer {
  return new SurfaceFrameRenderer({
    id: 'napi-canvas',
    features: CANVAS_FEATURES,
    provider,
    ...(assets === undefined ? {} : { assets }),
  });
}

describe('SurfaceFrameRenderer', () => {
  it('opens one surface for the whole session, not one per frame', async () => {
    const provider = new RecordingSurfaceProvider();
    const source = unwrap(await renderer(provider).open({ ir: pure2dIr(), size: SIZE }));
    await source.renderFrame(0);
    await source.renderFrame(1);
    await source.renderFrame(2);
    expect(provider.surfaces).toHaveLength(1);
    await source.close();
  });

  it('disposes the surface when the session closes', async () => {
    const provider = new RecordingSurfaceProvider();
    const source = unwrap(await renderer(provider).open({ ir: pure2dIr(), size: SIZE }));
    await source.close();
    expect(provider.surfaces[0]?.disposed).toBe(true);
  });

  it('forwards the requested output size to the surface', async () => {
    const provider = new RecordingSurfaceProvider();
    await renderer(provider).open({ ir: pure2dIr(), size: { width: 320, height: 200 } });
    expect(provider.surfaces[0]).toMatchObject({ width: 320, height: 200 });
  });

  it('turns a rasteriser exception into a Result at the boundary', async () => {
    // Adapters convert exceptions to `Result` exactly once (CLAUDE.md §2), and the
    // frame loop is written on the assumption that it never has to hold a try/catch.
    const provider: SurfaceProvider = {
      create(width, height): Surface2D {
        return {
          width,
          height,
          context: new Proxy({} as never, {
            get(): never {
              throw new Error('surface lost');
            },
          }),
          read: (): FrameBuffer => solidFrame(width, height, 0),
          dispose: (): void => undefined,
        };
      },
      createBitmap: (buffer): { width: number; height: number } => buffer,
      createPath: (): object | null => null,
    };
    const source = unwrap(await renderer(provider).open({ ir: pure2dIr(), size: SIZE }));
    const result = await source.renderFrame(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('surface lost');
  });

  it('uploads one bitmap per distinct tint, and only one per source', async () => {
    const ir = assetIr({ tint: '#00ff00' });
    const node = ir.nodes[0];
    if (node?.kind !== 'asset-instance') throw new Error('fixture changed');
    const assets = new MapAssetImages(
      new Map([[assetImageKey(node.asset, node.clipName), solidFrame(4, 4, 255)]]),
    );
    const provider = new RecordingSurfaceProvider();
    const opened = await renderer(provider, assets).open({ ir, size: SIZE });
    expect(opened.ok).toBe(true);
    expect(assets.requested).toHaveLength(1);
  });

  it('propagates a load failure from the asset port', async () => {
    const failing = {
      load: (): Promise<never> =>
        Promise.resolve({
          ok: false,
          error: new (class extends Error {
            code = 'X';
          })('nope'),
        } as never),
    };
    const opened = await new SurfaceFrameRenderer({
      id: 'napi-canvas',
      features: CANVAS_FEATURES,
      provider: new RecordingSurfaceProvider(),
      assets: failing,
    }).open({ ir: assetIr(), size: SIZE });
    expect(opened.ok).toBe(false);
  });
});
