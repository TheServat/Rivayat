import { describe, expect, it } from 'vitest';

import { RecordingContext, RecordingSurfaceProvider } from '../__fixtures__/doubles';
import { DEFAULT_TEXT_STYLE, bitmapKey, type DrawItem, type DrawList } from '../frames/draw-list';
import { IDENTITY } from '../frames/matrix';
import { paint, parsePoints, type PaintDeps } from './painter';

function list(items: readonly DrawItem[], background: string | null = null): DrawList {
  return { frame: 0, timeMs: 0, output: { width: 100, height: 80 }, background, items };
}

function base(overrides: Partial<DrawItem> = {}): Omit<DrawItem, 'kind'> & Record<string, unknown> {
  return {
    nodeId: 'nod_TEST',
    matrix: IDENTITY,
    alpha: 1,
    anchor: { x: 0.5, y: 0.5 },
    ...overrides,
  };
}

function deps(provider = new RecordingSurfaceProvider()): PaintDeps {
  return { provider, bitmaps: new Map() };
}

describe('paint', () => {
  it('clears the frame before anything else, under the identity transform', () => {
    const context = new RecordingContext();
    paint(context, list([]), deps());
    expect(context.calls[1]).toMatchObject({ method: 'setTransform', args: [1, 0, 0, 1, 0, 0] });
    expect(context.calls[2]).toMatchObject({ method: 'clearRect', args: [0, 0, 100, 80] });
  });

  it('fills the background when there is one', () => {
    const context = new RecordingContext();
    paint(context, list([], '#123456'), deps());
    expect(context.callsTo('fillRect')[0]?.args).toEqual([0, 0, 100, 80, '#123456', 1]);
  });

  it('saves and restores around every item, even one that throws', () => {
    // An item that throws mid-draw must not leave the next item with its transform.
    const context = new RecordingContext();
    let restored = 0;
    const exploding: typeof context = Object.assign(Object.create(null) as object, context, {
      save: (): void => undefined,
      restore: (): void => {
        restored += 1;
      },
      setTransform: (): void => undefined,
      clearRect: (): void => undefined,
      fillRect: (): void => {
        throw new Error('skia said no');
      },
    });

    const item = {
      ...base(),
      kind: 'shape',
      shape: 'rect',
      fill: '#fff',
      stroke: null,
      strokeWidth: 0,
      geometry: null,
      size: { width: 10, height: 10 },
    } as DrawItem;
    expect(() => {
      paint(exploding, list([item]), deps());
    }).toThrow('skia said no');
    // Once for the clear block, once for the item that threw.
    expect(restored).toBe(2);
  });

  it('offsets a shape by its anchor rather than by its transform', () => {
    const context = new RecordingContext();
    const item = {
      ...base({ anchor: { x: 1, y: 0.25 } }),
      kind: 'shape',
      shape: 'rect',
      fill: '#fff',
      stroke: null,
      strokeWidth: 0,
      geometry: null,
      size: { width: 40, height: 20 },
    } as DrawItem;
    paint(context, list([item]), deps());
    expect(context.callsTo('fillRect')[0]?.args.slice(0, 4)).toEqual([-40, -5, 40, 20]);
  });

  it('strokes a rect only when there is a stroke and a width', () => {
    const context = new RecordingContext();
    const withStroke = {
      ...base(),
      kind: 'shape',
      shape: 'rect',
      fill: null,
      stroke: '#000',
      strokeWidth: 3,
      geometry: null,
      size: { width: 10, height: 10 },
    } as DrawItem;
    const zeroWidth = { ...withStroke, strokeWidth: 0 } as DrawItem;
    paint(context, list([withStroke, zeroWidth]), deps());
    expect(context.callsTo('strokeRect')).toHaveLength(1);
    expect(context.callsTo('fillRect')).toHaveLength(0);
  });

  it('centres an ellipse inside its anchored bounds', () => {
    const context = new RecordingContext();
    const item = {
      ...base(),
      kind: 'shape',
      shape: 'ellipse',
      fill: '#fff',
      stroke: null,
      strokeWidth: 0,
      geometry: null,
      size: { width: 40, height: 20 },
    } as DrawItem;
    paint(context, list([item]), deps());
    expect(context.callsTo('ellipse')[0]?.args.slice(0, 4)).toEqual([0, 0, 20, 10]);
  });

  it('draws a polygon closed and a line open', () => {
    const context = new RecordingContext();
    const polygon = {
      ...base({ anchor: { x: 0, y: 0 } }),
      kind: 'shape',
      shape: 'polygon',
      fill: '#fff',
      stroke: null,
      strokeWidth: 0,
      geometry: '0,0 10,0 5,8',
      size: null,
    } as DrawItem;
    const line = {
      ...polygon,
      shape: 'line',
      fill: null,
      stroke: '#000',
      strokeWidth: 1,
    } as DrawItem;
    paint(context, list([polygon, line]), deps());
    expect(context.callsTo('closePath')).toHaveLength(1);
    expect(context.callsTo('lineTo')).toHaveLength(4);
  });

  it('skips a polygon with fewer than two points', () => {
    const context = new RecordingContext();
    const item = {
      ...base(),
      kind: 'shape',
      shape: 'polygon',
      fill: '#fff',
      stroke: null,
      strokeWidth: 0,
      geometry: '3',
      size: null,
    } as DrawItem;
    paint(context, list([item]), deps());
    expect(context.callsTo('moveTo')).toHaveLength(0);
  });

  it('fills a compiled path', () => {
    const provider = new RecordingSurfaceProvider();
    const context = new RecordingContext();
    const item = {
      ...base(),
      kind: 'shape',
      shape: 'path',
      fill: '#fff',
      stroke: '#000',
      strokeWidth: 1,
      geometry: 'M0 0 L10 10',
      size: null,
    } as DrawItem;
    paint(context, list([item]), deps(provider));
    expect(context.callsTo('fill')[0]?.args[0]).toEqual({ d: 'M0 0 L10 10' });
    expect(context.callsTo('stroke')).toHaveLength(1);
  });

  it('draws nothing rather than an approximation when the surface has no Path2D', () => {
    // A wrong shape is worse than a missing one, because it looks deliberate.
    const provider = new RecordingSurfaceProvider();
    provider.supportsPaths = false;
    const context = new RecordingContext();
    const item = {
      ...base(),
      kind: 'shape',
      shape: 'path',
      fill: '#fff',
      stroke: null,
      strokeWidth: 0,
      geometry: 'M0 0',
      size: null,
    } as DrawItem;
    paint(context, list([item]), deps(provider));
    expect(context.callsTo('fill')).toHaveLength(0);
  });

  it('skips a path item with no geometry', () => {
    const context = new RecordingContext();
    const item = {
      ...base(),
      kind: 'shape',
      shape: 'path',
      fill: '#fff',
      stroke: null,
      strokeWidth: 0,
      geometry: null,
      size: null,
    } as DrawItem;
    paint(context, list([item]), deps());
    expect(context.callsTo('fill')).toHaveLength(0);
  });

  it('lays text out itself instead of delegating alignment to the canvas', () => {
    const context = new RecordingContext();
    const item = {
      ...base({ anchor: { x: 0, y: 0 } }),
      kind: 'text',
      text: 'ab\ncdef',
      style: DEFAULT_TEXT_STYLE,
      align: 'end',
      direction: 'ltr',
      maxWidth: null,
    } as DrawItem;
    paint(context, list([item]), deps());
    expect(context.textAlign).toBe('left');
    const calls = context.callsTo('fillText');
    expect(calls.map((call) => call.args[0])).toEqual(['ab', 'cdef']);
    // Block width is the widest line (4 chars = 40); "ab" is 20 wide, so end-aligned
    // puts it at x = 20.
    expect(calls[0]?.args[1]).toBe(20);
    expect(calls[1]?.args[1]).toBe(0);
  });

  it('passes an explicit direction to the context and leaves auto to inherit', () => {
    const context = new RecordingContext();
    const rtl = {
      ...base(),
      kind: 'text',
      text: 'x',
      style: DEFAULT_TEXT_STYLE,
      align: 'start',
      direction: 'rtl',
      maxWidth: null,
    } as DrawItem;
    paint(context, list([rtl]), deps());
    expect(context.direction).toBe('rtl');
    const auto = { ...rtl, direction: 'auto' } as DrawItem;
    paint(context, list([auto]), deps());
    expect(context.direction).toBe('inherit');
  });

  it('draws a resolved bitmap at its anchor', () => {
    const context = new RecordingContext();
    const bitmap = { width: 20, height: 10 };
    const item = { ...base(), kind: 'image', imageKey: 'k', tint: null } as DrawItem;
    paint(context, list([item]), {
      provider: new RecordingSurfaceProvider(),
      bitmaps: new Map([['k', bitmap]]),
    });
    expect(context.callsTo('drawImage')[0]?.args).toEqual([bitmap, -10, -5]);
  });

  it('looks a tinted bitmap up under its tinted key', () => {
    const context = new RecordingContext();
    const bitmap = { width: 2, height: 2 };
    const item = { ...base(), kind: 'image', imageKey: 'k', tint: '#ff0000' } as DrawItem;
    paint(context, list([item]), {
      provider: new RecordingSurfaceProvider(),
      bitmaps: new Map([[bitmapKey('k', '#ff0000'), bitmap]]),
    });
    expect(context.callsTo('drawImage')).toHaveLength(1);
  });

  it('draws nothing for a bitmap the table does not hold', () => {
    const context = new RecordingContext();
    const item = { ...base(), kind: 'image', imageKey: 'missing', tint: null } as DrawItem;
    paint(context, list([item]), deps());
    expect(context.callsTo('drawImage')).toHaveLength(0);
  });

  it('draws the same particles for the same frame time, and different ones for another', () => {
    // The determinism that a `Math.random()` particle system silently destroys.
    const at = (timeMs: number): unknown[] => {
      const context = new RecordingContext();
      const item = {
        ...base(),
        kind: 'particles',
        effect: 'dust',
        rate: 40,
        area: { width: 50, height: 50 },
        seed: 5,
        intensity: 0.5,
        timeMs,
      } as DrawItem;
      paint(context, list([item]), deps());
      return context.callsTo('ellipse').map((call) => call.args.slice(0, 2));
    };
    expect(at(1000)).toEqual(at(1000));
    expect(at(1000)).not.toEqual(at(2000));
    expect(at(1000).length).toBeGreaterThan(0);
  });

  it('draws no particles when the emitter is off', () => {
    const context = new RecordingContext();
    const item = {
      ...base(),
      kind: 'particles',
      effect: 'dust',
      rate: 0,
      area: { width: 4, height: 4 },
      seed: 1,
      intensity: 0,
      timeMs: 0,
    } as DrawItem;
    paint(context, list([item]), deps());
    expect(context.callsTo('ellipse')).toHaveLength(0);
  });
});

describe('parsePoints', () => {
  it('accepts comma-separated and space-separated pairs alike', () => {
    expect(parsePoints('0,0 10,5')).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
    ]);
    expect(parsePoints('0 0 10 5')).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
    ]);
  });

  it('drops a trailing unpaired coordinate', () => {
    expect(parsePoints('0,0 10,5 7')).toHaveLength(2);
  });

  it('returns nothing for null or for junk', () => {
    expect(parsePoints(null)).toEqual([]);
    expect(parsePoints('a,b')).toEqual([]);
  });
});
