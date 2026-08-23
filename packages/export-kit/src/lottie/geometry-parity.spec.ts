/**
 * Polygon geometry: what the renderer draws is what the export writes.
 *
 * `ShapeNode.geometry` is free text - "written by hand and by models", as
 * `@rv/render-engine`'s `backends/painter.ts#parsePoints` puts it - so the two parsers
 * that read it have to agree about which strings yield vertices. They are separate
 * functions in separate packages that nothing forces to match, and when they disagree the
 * failure is silent in both directions: `node:shape` is declared `exact`, so a polygon
 * the renderer paints and the exporter drops produces a file with a missing shape and no
 * warning naming it.
 *
 * The table below is the contract. The same table is asserted against `parsePoints` in
 * `packages/render-engine/src/backends/painter.spec.ts`; a change to either parser has to
 * change both, which is the point.
 */

import { describe, expect, it } from 'vitest';
import { unwrap } from '@rv/shared-kernel';
import { AnimationIR as AnimationIRSchema, type AnimationIR } from '@rv/contracts';

import { LottieExporter } from './lottie-exporter';
import type { LottieDocument, LottieShapeItem } from './types';
import { readJson } from '../__fixtures__/read';
import { testIds } from '../__fixtures__/ids';

/**
 * `geometry` → the vertices both engines must produce.
 *
 * Written as literal expected output rather than derived from either parser, so a test
 * cannot agree with a parser that is wrong.
 */
const GEOMETRY_CASES: readonly {
  readonly geometry: string;
  readonly vertices: readonly (readonly [number, number])[];
  readonly why: string;
}[] = [
  {
    geometry: '0,0 100,0 50,80',
    vertices: [
      [0, 0],
      [100, 0],
      [50, 80],
    ],
    why: 'comma pairs',
  },
  {
    geometry: '0 0 100 0 50 80',
    vertices: [
      [0, 0],
      [100, 0],
      [50, 80],
    ],
    why: 'space pairs',
  },
  {
    geometry: '0,0 100,0 50,80 7',
    vertices: [
      [0, 0],
      [100, 0],
      [50, 80],
    ],
    why: 'a trailing unpaired number is ignored, not fatal',
  },
  {
    geometry: '0,0 100,0 50,80 x',
    vertices: [
      [0, 0],
      [100, 0],
      [50, 80],
    ],
    why: 'a trailing token nobody reads is ignored, not fatal',
  },
  {
    geometry: '0,0 abc,def',
    vertices: [],
    why: 'junk inside a consumed pair invalidates the whole geometry',
  },
  {
    geometry: '0,0 Infinity,0 10,10',
    vertices: [],
    why: 'a non-finite coordinate invalidates the whole geometry',
  },
  { geometry: '5,5', vertices: [[5, 5]], why: 'one vertex parses, though nothing can be drawn' },
];

function polygonIr(geometry: string): AnimationIR {
  const ids = testIds();
  return AnimationIRSchema.parse({
    irVersion: 1,
    id: ids.animation(),
    name: 'Polygon',
    fps: 24,
    durationMs: 200,
    sceneSpace: { width: 400, height: 400 },
    seed: 1,
    nodes: [
      {
        id: ids.node(),
        name: 'poly',
        parentId: null,
        kind: 'shape',
        shape: 'polygon',
        geometry,
        fill: '#0000ff',
      },
    ],
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * The `sh` item's vertex list, or `[]` when the exporter wrote no geometry at all.
 *
 * Walked defensively rather than cast: `LottieShapeItem` is an open bag by design, and a
 * cast here would turn "the exporter stopped writing a path" into a crash instead of into
 * the empty list the assertion is about.
 */
async function writtenVertices(geometry: string): Promise<readonly (readonly number[])[]> {
  const output = unwrap(await new LottieExporter().export({ ir: polygonIr(geometry) }, {}));
  const doc = readJson<LottieDocument>(output, output.artifacts[0]?.path ?? '');
  const group: LottieShapeItem | undefined = doc.layers[0]?.shapes?.[0];
  if (group?.ty !== 'gr' || !isUnknownArray(group.it)) return [];

  for (const item of group.it) {
    if (!isRecord(item) || item.ty !== 'sh') continue;
    const ks: unknown = item.ks;
    if (!isRecord(ks)) continue;
    const k: unknown = ks.k;
    if (!isRecord(k)) continue;
    const vertices: unknown = k.v;
    if (!isUnknownArray(vertices)) continue;
    return vertices.filter(isUnknownArray).map((point) => point.map(Number));
  }
  return [];
}

describe('polygon geometry parses the same way as the renderer parses it', () => {
  it.each(GEOMETRY_CASES.map((entry) => [entry.why, entry] as const))('%s', async (_why, entry) => {
    const written = await writtenVertices(entry.geometry);
    // Lottie needs two vertices before it has a path; below that the exporter writes no
    // geometry item, which is the same picture the renderer draws (none).
    const expected = entry.vertices.length >= 2 ? entry.vertices : [];
    expect(written.map((point) => [point[0], point[1]])).toEqual(
      expected.map((point) => [point[0], point[1]]),
    );
  });

  it('does not throw away a whole polygon over a token neither engine reads', async () => {
    // The regression, stated on its own: the renderer paints three vertices from this and
    // the exporter used to write none of them.
    expect(await writtenVertices('0,0 100,0 50,80 NaN')).toHaveLength(3);
  });
});
