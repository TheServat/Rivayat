/**
 * The only test in the package that draws real pixels.
 *
 * Everything else in `backends/` is exercised through the surface port with a recording
 * double, which is right for asserting *decisions*. This file asserts that the
 * decisions survive contact with Skia: that a frame comes back the size it was asked
 * for, that the pixels are where the transform said they would be, and - the one that
 * matters - that the same frame index produces the same bytes every time.
 */

import { unwrap } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { MapAssetImages, solidFrame } from '../../__fixtures__/doubles';
import { assetIr, particlesIr, pure2dIr } from '../../__fixtures__/ir';
import { hashFrame } from '../../frames/frame-hash';
import type { FrameBuffer, FrameSource } from '../../ports/frame-renderer';
import { assetImageKey } from '../../frames/draw-list';
import { createNapiCanvasBackend } from './napi-canvas-backend';

const SIZE = { width: 160, height: 120 };

async function open(
  ir: ReturnType<typeof pure2dIr>,
  assets?: MapAssetImages,
): Promise<FrameSource> {
  const backend = createNapiCanvasBackend(assets === undefined ? {} : { assets });
  const session = await backend.open({ ir, size: SIZE, background: '#000000' });
  return unwrap(session);
}

function pixelAt(frame: FrameBuffer, x: number, y: number): readonly number[] {
  const offset = (y * frame.width + x) * 4;
  return [...frame.data.slice(offset, offset + 4)];
}

describe('napi-canvas backend', () => {
  it('produces a frame at the requested size, four bytes per pixel', async () => {
    const source = await open(pure2dIr());
    const frame = unwrap(await source.renderFrame(0));
    expect(frame.width).toBe(SIZE.width);
    expect(frame.height).toBe(SIZE.height);
    expect(frame.data.length).toBe(SIZE.width * SIZE.height * 4);
    await source.close();
  });

  it('draws the backdrop, so the frame is not blank', async () => {
    const source = await open(pure2dIr());
    const frame = unwrap(await source.renderFrame(0));
    // #204060, opaque, at the centre of a fixture whose backdrop covers the canvas.
    expect(pixelAt(frame, 80, 40)).toEqual([0x20, 0x40, 0x60, 255]);
    await source.close();
  });

  it('renders the same frame index to the same bytes, every time', async () => {
    const first = await open(pure2dIr());
    const a = hashFrame(unwrap(await first.renderFrame(12)));
    await first.close();

    const second = await open(pure2dIr());
    const b = hashFrame(unwrap(await second.renderFrame(12)));
    await second.close();

    expect(a).toBe(b);
  });

  it('renders different frames differently, so the hash test is not vacuous', async () => {
    const source = await open(pure2dIr());
    const a = hashFrame(unwrap(await source.renderFrame(0)));
    const b = hashFrame(unwrap(await source.renderFrame(60)));
    await source.close();
    expect(a).not.toBe(b);
  });

  it('moves the subject as the timeline advances', async () => {
    const source = await open(pure2dIr());
    const start = unwrap(await source.renderFrame(0));
    const end = unwrap(await source.renderFrame(99));
    await source.close();

    // The subject is a yellow ellipse crossing left to right. Find its leading edge by
    // scanning the row it sits on for a non-backdrop pixel.
    const leadingEdge = (frame: FrameBuffer): number => {
      for (let x = frame.width - 1; x >= 0; x -= 1) {
        const [r, g] = pixelAt(frame, x, 60);
        if ((r ?? 0) > 0x60 && (g ?? 0) > 0x60) return x;
      }
      return -1;
    };
    expect(leadingEdge(end)).toBeGreaterThan(leadingEdge(start));
  });

  it('refuses a composition it cannot draw, before drawing anything', async () => {
    // ADR-0003's stated nightmare is a composition that renders *almost* right on the
    // wrong backend. The cure is that the wrong backend never starts.
    const backend = createNapiCanvasBackend();
    const session = await backend.open({ ir: particlesIr(), size: SIZE });
    expect(session.ok).toBe(false);
    if (session.ok) return;
    expect(session.error.kind).toBe('unsupported');
    expect(session.error.message).toContain('particles');
  });

  it('resolves an asset bitmap once and reuses it', async () => {
    const ir = assetIr();
    const node = ir.nodes[0];
    if (node?.kind !== 'asset-instance') throw new Error('fixture changed');
    const key = assetImageKey(node.asset, node.clipName);
    const assets = new MapAssetImages(new Map([[key, solidFrame(20, 20, 200)]]));

    const source = await open(ir, assets);
    unwrap(await source.renderFrame(0));
    unwrap(await source.renderFrame(1));
    await source.close();

    expect(assets.requested).toEqual([key]);
  });

  it('bakes a tint into the bitmap rather than compositing it per frame', async () => {
    const ir = assetIr({ tint: '#ff0000' });
    const node = ir.nodes[0];
    if (node?.kind !== 'asset-instance') throw new Error('fixture changed');
    const white = solidFrame(40, 40, 255);
    const assets = new MapAssetImages(new Map([[assetImageKey(node.asset, node.clipName), white]]));

    const source = await open(ir, assets);
    const frame = unwrap(await source.renderFrame(0));
    await source.close();

    // The instance is centred, so the middle pixel is the tinted bitmap: red survives,
    // green and blue are multiplied away.
    const [r, g, b] = pixelAt(frame, 80, 60);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it('fails the session when an asset cannot be resolved', async () => {
    const backend = createNapiCanvasBackend({ assets: new MapAssetImages(new Map()) });
    const session = await backend.open({ ir: assetIr(), size: SIZE });
    expect(session.ok).toBe(false);
    if (session.ok) return;
    expect(session.error.kind).toBe('not-found');
  });

  it('fails the session when there is no asset port at all', async () => {
    const backend = createNapiCanvasBackend();
    const session = await backend.open({ ir: assetIr(), size: SIZE });
    expect(session.ok).toBe(false);
  });

  it('disposes the surface on close', async () => {
    const source = await open(pure2dIr());
    await source.close();
    // A second close must not throw: the job's `finally` runs it unconditionally.
    await expect(source.close()).resolves.toBeUndefined();
  });
});
