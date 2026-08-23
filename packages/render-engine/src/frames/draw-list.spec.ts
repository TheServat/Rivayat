import { evaluate } from '@rv/anim-engine';
import { describe, expect, it } from 'vitest';

import {
  BACKDROP_ID,
  SUBJECT_ID,
  TITLE_ID,
  assetIr,
  particlesIr,
  pure2dIr,
} from '../__fixtures__/ir';
import {
  DEFAULT_TEXT_STYLE,
  assetImageKey,
  bitmapKey,
  buildDrawList,
  normPointToScene,
  normRectCentre,
} from './draw-list';

const OUTPUT = { width: 400, height: 300 };

describe('buildDrawList', () => {
  it('paints back to front, highest depth first', () => {
    const ir = pure2dIr();
    const list = buildDrawList(ir, evaluate(ir, 0), { output: OUTPUT });
    // backdrop depth 10, subject 0, title -5.
    expect(list.items.map((item) => item.nodeId)).toEqual([BACKDROP_ID, SUBJECT_ID, TITLE_ID]);
  });

  it('breaks depth ties by authored order rather than by sort luck', () => {
    const ir = pure2dIr();
    const flattened = {
      ...ir,
      nodes: ir.nodes.map((node) => ({ ...node, depth: 0 })),
    };
    const list = buildDrawList(flattened, evaluate(flattened, 0), { output: OUTPUT });
    expect(list.items.map((item) => item.nodeId)).toEqual([BACKDROP_ID, SUBJECT_ID, TITLE_ID]);
  });

  it('drops structural nodes and invisible ones', () => {
    const ir = pure2dIr();
    const hidden = {
      ...ir,
      nodes: ir.nodes.map((node) => (node.id === TITLE_ID ? { ...node, visible: false } : node)),
    };
    const list = buildDrawList(hidden, evaluate(hidden, 0), { output: OUTPUT });
    expect(list.items.map((item) => item.nodeId)).not.toContain(TITLE_ID);
  });

  it('carries the shape fields the painter needs', () => {
    const ir = pure2dIr();
    const list = buildDrawList(ir, evaluate(ir, 0), { output: OUTPUT });
    const subject = list.items.find((item) => item.nodeId === SUBJECT_ID);
    expect(subject).toMatchObject({
      kind: 'shape',
      shape: 'ellipse',
      fill: '#ffcc33',
      stroke: '#000000',
      strokeWidth: 2,
      size: { width: 60, height: 60 },
    });
  });

  it('resolves a text style by name and lets the node override the colour', () => {
    const ir = pure2dIr();
    const list = buildDrawList(ir, evaluate(ir, 0), {
      output: OUTPUT,
      textStyles: { title: { ...DEFAULT_TEXT_STYLE, fontSizePx: 72, colour: '#ff0000' } },
    });
    const title = list.items.find((item) => item.nodeId === TITLE_ID);
    expect(title).toMatchObject({ kind: 'text', style: { fontSizePx: 72, colour: '#ffffff' } });
  });

  it('falls back to the default style for an unknown style name', () => {
    const ir = pure2dIr();
    const list = buildDrawList(ir, evaluate(ir, 0), { output: OUTPUT });
    const title = list.items.find((item) => item.nodeId === TITLE_ID);
    expect(title).toMatchObject({ style: { fontFamily: DEFAULT_TEXT_STYLE.fontFamily } });
  });

  it('emits an image item keyed by the pinned version', () => {
    const ir = assetIr({ tint: '#ff8800' });
    const list = buildDrawList(ir, evaluate(ir, 0), { output: OUTPUT });
    const item = list.items[0];
    expect(item).toMatchObject({ kind: 'image', tint: '#ff8800' });
  });

  it('emits particle items with the emitter seed, never a random one', () => {
    const ir = particlesIr();
    const list = buildDrawList(ir, evaluate(ir, 400), { output: OUTPUT });
    const sparks = list.items.find((item) => item.kind === 'particles');
    expect(sparks).toMatchObject({ effect: 'sparks', seed: 11, rate: 40 });
  });

  it('moves an item as the track moves it', () => {
    const ir = pure2dIr();
    const start = buildDrawList(ir, evaluate(ir, 0), { output: OUTPUT });
    const end = buildDrawList(ir, evaluate(ir, 4000), { output: OUTPUT });
    const at = (list: ReturnType<typeof buildDrawList>): number =>
      list.items.find((item) => item.nodeId === SUBJECT_ID)?.matrix.e ?? Number.NaN;
    expect(at(end)).toBeGreaterThan(at(start));
  });

  it('records the background as given', () => {
    const ir = pure2dIr();
    expect(
      buildDrawList(ir, evaluate(ir, 0), { output: OUTPUT, background: '#000' }).background,
    ).toBe('#000');
    expect(buildDrawList(ir, evaluate(ir, 0), { output: OUTPUT }).background).toBeNull();
  });

  it('skips a snapshot node with no IR node behind it', () => {
    const ir = pure2dIr();
    const snapshot = evaluate(ir, 0);
    const orphaned = {
      ...snapshot,
      nodes: [...snapshot.nodes, { ...snapshot.nodes[0]!, nodeId: 'nod_UNKNOWN' as never }],
    };
    const list = buildDrawList(ir, orphaned, { output: OUTPUT });
    expect(list.items).toHaveLength(3);
  });
});

describe('keys and conversions', () => {
  it('cannot collide two different asset references', () => {
    const a = assetImageKey({ versionId: 'asv_A', variantKey: 'b' }, undefined);
    const b = assetImageKey({ versionId: 'asv_A' }, 'b');
    expect(a).not.toBe(b);
  });

  it('separates a tinted bitmap from its untinted source', () => {
    expect(bitmapKey('k', null)).toBe('k');
    expect(bitmapKey('k', '#ff0000')).not.toBe('k');
  });

  it('places the scene-space origin at the centre of the canvas', () => {
    expect(normPointToScene({ x: 0.5, y: 0.5 }, { width: 400, height: 300 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(normPointToScene({ x: 0, y: 1 }, { width: 400, height: 300 })).toEqual({
      x: -200,
      y: 150,
    });
  });

  it('finds a normalised rectangle centre', () => {
    expect(normRectCentre({ x: 0.2, y: 0.4, width: 0.4, height: 0.2 })).toEqual({ x: 0.4, y: 0.5 });
  });
});
