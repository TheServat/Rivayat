import { describe, expect, it } from 'vitest';
import { isErr, isOk, unwrap } from '@rv/shared-kernel';
import type { AnimationIR } from '@rv/contracts';
import { evaluate } from '@rv/anim-engine';

import { LOTTIE_CAPABILITIES, LottieExporter } from './lottie-exporter';
import { sampleLottieProperty } from './sample';
import type { LottieDocument, LottieLayer } from './types';
import type { ExportOutput } from '../port';
import { UnsupportedFeaturesError } from '../warnings';
import {
  easedMoveIr,
  hierarchyIr,
  richIr,
  shapesIr,
  skewIr,
  sparseEdgeIr,
  testMotion,
  windIr,
} from '../__fixtures__/ir';
import { partImages, rigFixture } from '../__fixtures__/rig';
import { readJson } from '../__fixtures__/read';

const exporter = new LottieExporter();
const motion = testMotion();

async function exportIr(
  ir: AnimationIR,
  options: Parameters<LottieExporter['export']>[1] = {},
): Promise<ExportOutput> {
  return unwrap(await exporter.export({ ir, motion }, options));
}

function document(output: ExportOutput): LottieDocument {
  return readJson<LottieDocument>(output, output.artifacts[0]?.path ?? '');
}

function layerFor(doc: LottieDocument, nodeId: string): LottieLayer {
  const layer = doc.layers.find((candidate) => candidate.mn === nodeId);
  expect(layer, `no layer for node ${nodeId}`).toBeDefined();
  return layer!;
}

// ── the shape lottie-web insists on ─────────────────────────────────────────

describe('the emitted document', () => {
  it('carries every top-level field a player checks before it will load the file', async () => {
    const ir = hierarchyIr();
    const doc = document(await exportIr(ir));

    expect(doc.v).toBe('5.13.0');
    expect(doc.fr).toBe(24);
    expect(doc.ip).toBe(0);
    // 1500 ms at 24 fps.
    expect(doc.op).toBe(36);
    expect(doc.w).toBe(1920);
    expect(doc.h).toBe(1080);
    expect(doc.ddd).toBe(0);
    expect(doc.nm).toBe('Hierarchy');
    expect(Array.isArray(doc.layers)).toBe(true);
    expect(Array.isArray(doc.assets)).toBe(true);
    expect(Array.isArray(doc.markers)).toBe(true);
  });

  it('gives every layer the fields a renderer dereferences without checking', async () => {
    const doc = document(await exportIr(hierarchyIr()));

    for (const layer of doc.layers) {
      expect(layer.ddd).toBe(0);
      expect(layer.sr).toBe(1);
      expect(layer.ao).toBe(0);
      expect(layer.bm).toBe(0);
      expect(layer.st).toBe(0);
      expect(layer.ip).toBe(0);
      expect(layer.op).toBe(36);
      expect([2, 3, 4, 5]).toContain(layer.ty);
      expect(typeof layer.nm).toBe('string');
      for (const channel of ['a', 'p', 's', 'r', 'o'] as const) {
        const property = layer.ks[channel];
        expect(property, `layer ${layer.nm} is missing ks.${channel}`).toBeDefined();
        expect([0, 1]).toContain(property.a);
      }
    }
  });

  it('numbers layers 1..n with no gaps and no repeats', async () => {
    const doc = document(await exportIr(hierarchyIr()));
    expect(doc.layers.map((layer) => layer.ind)).toEqual(doc.layers.map((_, index) => index + 1));
  });

  it('orders layers so the nearest node is drawn on top', async () => {
    const ir = hierarchyIr();
    const doc = document(await exportIr(ir));
    // Lottie draws index 0 on top; our renderer draws high `depth` first. `label` has
    // depth 0 (nearest) and `rig-root` has depth 10 (furthest).
    const names = doc.layers.map((layer) => layer.nm);
    expect(names.indexOf('label')).toBeLessThan(names.indexOf('rig-root'));
  });

  it('writes markers on the frame grid', async () => {
    const doc = document(await exportIr(hierarchyIr()));
    expect(doc.markers).toEqual([
      { tm: 0, cm: 'in', dr: 0 },
      { tm: 24, cm: 'settle', dr: 0 },
    ]);
  });

  it('names the file after the IR unless told otherwise', async () => {
    expect((await exportIr(windIr())).artifacts[0]?.path).toBe('wind-study.json');
    expect((await exportIr(windIr(), { lottie: { name: 'custom' } })).artifacts[0]?.path).toBe(
      'custom.json',
    );
  });
});

// ── the test this package exists for ────────────────────────────────────────

describe('fidelity against evaluate(ir, t)', () => {
  it('reproduces the evaluator’s world transform at every frame, within 1e-5', async () => {
    const ir = hierarchyIr();
    const output = await exportIr(ir);
    const doc = document(output);

    let worst = 0;
    for (let frame = 0; frame <= 36; frame += 1) {
      const snapshot = evaluate(ir, (frame * 1000) / ir.fps, { motion });
      for (const node of snapshot.nodes) {
        const layer = layerFor(doc, node.nodeId);
        const world = node.worldTransform;
        const declared = ir.nodes.find((candidate) => candidate.id === node.nodeId);

        const position = sampleLottieProperty(layer.ks.p, frame);
        const scale = sampleLottieProperty(layer.ks.s, frame);
        const rotation = sampleLottieProperty(layer.ks.r, frame);
        const opacity = sampleLottieProperty(layer.ks.o, frame);

        const errors = [
          Math.abs((position[0] ?? 0) - world.position.x),
          Math.abs((position[1] ?? 0) - world.position.y),
          Math.abs((scale[0] ?? 0) - world.scale.x * 100),
          Math.abs((scale[1] ?? 0) - world.scale.y * 100),
          Math.abs((rotation[0] ?? 0) - world.rotation),
          Math.abs((opacity[0] ?? 0) - (declared?.visible === false ? 0 : world.opacity * 100)),
        ];
        worst = Math.max(worst, ...errors);
      }
    }

    expect(worst).toBeLessThan(1e-5);
  });

  it('reports that error itself, measured rather than claimed', async () => {
    const output = await exportIr(hierarchyIr());
    const fidelity = output.stats.fidelity;
    expect(fidelity).toBeDefined();
    if (fidelity === undefined) return;

    expect(fidelity.samples).toBe(37 * 3);
    expect(fidelity.worst).toBeLessThan(1e-5);
    expect(fidelity.positionPx.rms).toBeLessThanOrEqual(fidelity.positionPx.max);
  });

  it('keeps the bezier handles the author wrote instead of sampling them away', async () => {
    const ir = easedMoveIr();
    const output = await exportIr(ir);
    const doc = document(output);
    const layer = layerFor(doc, ir.nodes[0]?.id ?? '');

    expect(layer.ks.p.a).toBe(1);
    if (layer.ks.p.a !== 1) return;

    // Three authored keyframes, not sixty sampled ones.
    expect(layer.ks.p.k).toHaveLength(3);
    expect(layer.ks.p.k[0]?.t).toBe(0);
    expect(layer.ks.p.k[1]?.t).toBe(30);
    expect(layer.ks.p.k[2]?.t).toBe(60);
    expect(layer.ks.p.k[0]?.o).toEqual({ x: [0.42], y: [0] });
    expect(layer.ks.p.k[0]?.i).toEqual({ x: [0.58], y: [1] });
    // The node's authored transform is folded in: position.x starts at 100, not 0.
    expect(layer.ks.p.k[0]?.s).toEqual([100, 50]);

    expect(output.stats.bakedKeyframeCount).toBe(0);
    expect(output.stats.fidelity?.worst).toBeLessThan(1e-5);
  });

  it('bakes rather than guessing when a stepped cadence quantises time', async () => {
    const ir = easedMoveIr();
    const stepped = unwrap(
      await exporter.export({ ir, motion: testMotion({ stepMode: 'on-2s' }) }, {}),
    );
    const doc = readJson<LottieDocument>(stepped, 'eased-move.json');
    const layer = layerFor(doc, ir.nodes[0]?.id ?? '');
    expect(layer.ks.p.a).toBe(1);
    expect(stepped.stats.bakedKeyframeCount).toBeGreaterThan(3);
  });

  it('bakes rather than guessing when the tracks do not share a keyframe grid', async () => {
    const ir = easedMoveIr();
    const shifted: AnimationIR = {
      ...ir,
      tracks: [
        ir.tracks[0]!,
        {
          ...ir.tracks[1]!,
          keyframes: [
            { timeMs: 0, value: 0 },
            { timeMs: 1200, value: 120 },
          ],
        },
      ],
    };
    const output = unwrap(await exporter.export({ ir: shifted, motion }, {}));
    expect(output.stats.bakedKeyframeCount).toBeGreaterThan(3);
  });
});

// ── baking, and being honest about it ───────────────────────────────────────

describe('baking a procedural behaviour', () => {
  it('turns eight lines of JSON into dense keyframes and says how many', async () => {
    const ir = windIr();
    const output = await exportIr(ir);

    expect(output.stats.sampleStride).toBe(1);
    expect(output.stats.sampledFrames).toBe(91);
    expect(output.stats.bakedKeyframeCount).toBeGreaterThan(100);
    expect(output.stats.keyframeCount).toBe(output.stats.bakedKeyframeCount);
    expect(output.stats.totalBytes).toBeGreaterThan(2000);
  });

  it('reports the behaviour it baked, naming it and the node it came from', async () => {
    const ir = windIr();
    const output = await exportIr(ir);

    const warning = output.warnings.find((candidate) => candidate.feature === 'behaviour:wind');
    expect(warning).toBeDefined();
    expect(warning?.disposition).toBe('approximated');
    expect(warning?.ids).toEqual([ir.behaviours[0]?.id]);
    expect(warning?.detail).toContain('stride 1');
  });

  it('trades fidelity for size at a coarser stride, and reports both sides of the trade', async () => {
    const ir = windIr();
    const fine = await exportIr(ir, { lottie: { stride: 1 } });
    const coarse = await exportIr(ir, { lottie: { stride: 6 } });

    expect(coarse.stats.bakedKeyframeCount).toBeLessThan(fine.stats.bakedKeyframeCount);
    expect(coarse.stats.totalBytes).toBeLessThan(fine.stats.totalBytes);

    const fineWorst = fine.stats.fidelity?.worst ?? 0;
    const coarseWorst = coarse.stats.fidelity?.worst ?? 0;
    expect(fineWorst).toBeLessThan(1e-5);
    expect(coarseWorst).toBeGreaterThan(fineWorst);
    // Not merely larger - visibly larger, which is the point of offering the dial.
    expect(coarseWorst).toBeGreaterThan(0.05);
  });

  it('can be told not to measure, for a caller that does not want to pay for it', async () => {
    const output = await exportIr(windIr(), { lottie: { measureFidelity: false } });
    expect(output.stats.fidelity).toBeUndefined();
  });

  it('simplifies collinear samples within the tolerance it was given', async () => {
    const tight = await exportIr(windIr(), { lottie: { simplifyTolerance: 1e-9 } });
    const loose = await exportIr(windIr(), { lottie: { simplifyTolerance: 0.5 } });

    expect(loose.stats.keyframeCount).toBeLessThan(tight.stats.keyframeCount);
    expect(loose.stats.fidelity?.worst ?? 0).toBeGreaterThan(tight.stats.fidelity?.worst ?? 0);
  });
});

// ── layer bodies ────────────────────────────────────────────────────────────

describe('layer bodies', () => {
  it('writes shapes lottie-web can draw, and skips geometry it cannot re-fit', async () => {
    const ir = shapesIr();
    const doc = document(await exportIr(ir));

    const kinds = (name: string): string[] => {
      const layer = doc.layers.find((candidate) => candidate.nm === name);
      const group = layer?.shapes?.[0] as { it?: { ty: string }[] } | undefined;
      return (group?.it ?? []).map((item) => item.ty);
    };

    expect(kinds('box')).toEqual(['rc', 'fl', 'tr']);
    expect(kinds('edge')).toEqual(['sh', 'st', 'tr']);
    expect(kinds('triangle')).toEqual(['sh', 'fl', 'tr']);
    // No size on the ellipse and unparsable points on the polygon: the layer and its
    // transform survive, the geometry does not.
    expect(kinds('blob')).toEqual(['tr']);
    expect(kinds('broken')).toEqual(['tr']);
  });

  it('closes a polygon and leaves a line open', async () => {
    const doc = document(await exportIr(shapesIr()));
    const path = (name: string): { c: boolean; v: number[][] } => {
      const layer = doc.layers.find((candidate) => candidate.nm === name);
      const group = layer?.shapes?.[0] as {
        it?: { ty: string; ks?: { k: { c: boolean; v: number[][] } } }[];
      };
      const shape = group.it?.find((item) => item.ty === 'sh');
      return shape?.ks?.k as { c: boolean; v: number[][] };
    };

    expect(path('edge')).toMatchObject({
      c: false,
      v: [
        [0, 0],
        [100, 50],
      ],
    });
    expect(path('triangle')).toMatchObject({
      c: true,
      v: [
        [0, 0],
        [50, 0],
        [25, 40],
      ],
    });
  });

  it('converts fill and stroke colour and alpha', async () => {
    const doc = document(await exportIr(shapesIr()));
    const layer = doc.layers.find((candidate) => candidate.nm === 'box');
    const group = layer?.shapes?.[0] as
      { it?: { ty: string; c?: { k: number[] }; o?: { k: number } }[] } | undefined;
    const fill = (group?.it ?? []).find((item) => item.ty === 'fl');

    expect(fill?.c?.k[0]).toBeCloseTo(1, 6);
    expect(fill?.c?.k[1]).toBeCloseTo(0, 6);
    // `#ff000080` is half-transparent, and Lottie keeps alpha on its own property.
    expect(fill?.o?.k).toBeCloseTo(50.196078, 4);
  });

  it('writes a text document and registers the font it names', async () => {
    const ir = hierarchyIr();
    const doc = document(await exportIr(ir));
    const layer = doc.layers.find((candidate) => candidate.nm === 'label');

    expect(layer?.ty).toBe(5);
    const text = layer?.t?.d.k[0]?.s;
    expect(text?.t).toBe('دِرَخت');
    expect(text?.j).toBe(1);
    expect(text?.s).toBe(36);
    expect(text?.fc).toEqual([1, 1, 1]);
    expect(doc.fonts?.list.map((font) => font.fName)).toEqual(['body']);
  });

  it('references image assets by file name and reuses one entry per pinned asset', async () => {
    const ir = richIr();
    const doc = document(await exportIr(ir));
    const instance = doc.layers.find((candidate) => candidate.nm === 'hero');

    expect(instance?.ty).toBe(2);
    expect(doc.assets).toHaveLength(1);
    const asset = doc.assets[0];
    expect(instance?.refId).toBe(asset?.id);
    expect(asset?.u).toBe('images/');
    expect(asset?.p).toMatch(
      /^ast_[0-9A-HJKMNP-TV-Z]{26}_asv_[0-9A-HJKMNP-TV-Z]{26}_winter\.png$/u,
    );
    expect(asset?.e).toBe(0);
  });

  it('emits a null layer for the node kinds it cannot draw, so the transform survives', async () => {
    const doc = document(await exportIr(richIr()));
    expect(doc.layers.find((candidate) => candidate.nm === 'snowfall')?.ty).toBe(3);
  });

  it('writes a skew axis, and reports the component it had to leave out', async () => {
    const ir = skewIr();
    const output = await exportIr(ir);
    const doc = document(output);

    const both = doc.layers.find((candidate) => candidate.nm === 'sheared');
    expect(both?.ks.sk).toEqual({ a: 0, k: 12 });
    expect(both?.ks.sa).toEqual({ a: 0, k: 0 });

    const yOnly = doc.layers.find((candidate) => candidate.nm === 'leaning');
    expect(yOnly?.ks.sk).toEqual({ a: 0, k: 9 });
    expect(yOnly?.ks.sa).toEqual({ a: 0, k: 90 });

    const warning = output.warnings.find((candidate) => candidate.feature === 'track:skew');
    expect(warning?.disposition).toBe('approximated');
    expect(warning?.ids).toEqual([ir.nodes[0]?.id]);
  });
});

// ── the camera ──────────────────────────────────────────────────────────────

describe('the camera', () => {
  it('is a no-op when it is the identity, so a clip without one is unaffected', async () => {
    const ir = richIr();
    const identity: AnimationIR = {
      ...ir,
      camera: {
        keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
        shakeAmplitude: 0,
        shakeSeed: 0,
      },
    };
    const folded = document(unwrap(await exporter.export({ ir: identity, motion }, {})));
    const raw = document(
      unwrap(await exporter.export({ ir: identity, motion }, { lottie: { applyCamera: false } })),
    );

    for (const layer of folded.layers) {
      const other = raw.layers.find((candidate) => candidate.mn === layer.mn);
      expect(sampleLottieProperty(layer.ks.p, 10)).toEqual(
        sampleLottieProperty(other?.ks.p ?? layer.ks.p, 10),
      );
    }
  });

  it('is folded into the layers by default, and reported as restructured', async () => {
    const output = await exportIr(richIr());
    const warning = output.warnings.find((candidate) => candidate.feature === 'camera:track');
    expect(warning?.disposition).toBe('restructured');

    const doc = document(output);
    const layer = layerFor(doc, richIr().nodes[0]?.id ?? doc.layers[0]?.mn ?? '');
    // The camera zooms to 1.25 and pans by (120, -40), so nothing sits still.
    expect(sampleLottieProperty(layer.ks.p, 0)).not.toEqual(sampleLottieProperty(layer.ks.p, 25));
  });

  it('is reported as dropped when the caller turns the fold off', async () => {
    const output = await exportIr(richIr(), { lottie: { applyCamera: false } });
    const warning = output.warnings.find((candidate) => candidate.feature === 'camera:track');
    expect(warning?.disposition).toBe('dropped');
    expect(
      output.warnings.find((candidate) => candidate.feature === 'camera:shake')?.disposition,
    ).toBe('dropped');
  });
});

// ── the loss report ─────────────────────────────────────────────────────────

describe('the loss report', () => {
  it('names every feature the format cannot carry, with a disposition for each', async () => {
    const output = await exportIr(richIr());
    const byFeature = new Map(
      output.warnings.map((warning) => [warning.feature, warning.disposition]),
    );

    expect(byFeature.get('node:fx-emitter')).toBe('dropped');
    expect(byFeature.get('node:shape-path')).toBe('dropped');
    expect(byFeature.get('node:tint')).toBe('dropped');
    expect(byFeature.get('node:flip-x')).toBe('dropped');
    expect(byFeature.get('node:clip-playback')).toBe('dropped');
    expect(byFeature.get('track:depth')).toBe('dropped');
    expect(byFeature.get('track:anchor')).toBe('dropped');
    expect(byFeature.get('track:fx-intensity')).toBe('dropped');
    expect(byFeature.get('camera:focus-node')).toBe('dropped');
    expect(byFeature.get('behaviour:blink')).toBe('approximated');
    expect(byFeature.get('behaviour:boil')).toBe('approximated');
    expect(byFeature.get('track:stepped-easing')).toBe('approximated');
    expect(byFeature.get('node:hierarchy')).toBeUndefined();
  });

  it('says nothing at all about a document the format can carry exactly', async () => {
    expect((await exportIr(easedMoveIr())).warnings).toEqual([]);
  });

  it('reports flattening as restructured, because the picture is still exact', async () => {
    const output = await exportIr(hierarchyIr());
    const warning = output.warnings.find((candidate) => candidate.feature === 'node:hierarchy');
    expect(warning?.disposition).toBe('restructured');
    expect(warning?.ids).toHaveLength(2);
  });

  it('does not declare anything it cannot carry as exact', () => {
    for (const feature of LOTTIE_CAPABILITIES.exact) {
      expect(LOTTIE_CAPABILITIES.approximate.has(feature)).toBe(false);
    }
  });

  it('fails instead of succeeding quietly when the caller asked for strict', async () => {
    const result = await exporter.export({ ir: richIr(), motion }, { strict: true });
    expect(isErr(result)).toBe(true);
    if (isOk(result)) return;

    const error = result.error;
    expect(error).toBeInstanceOf(UnsupportedFeaturesError);
    if (!(error instanceof UnsupportedFeaturesError)) return;
    expect(error.kind).toBe('unsupported');
    expect(error.lost.map((warning) => warning.feature)).toContain('node:fx-emitter');
    // A restructured loss is not a reason to refuse: the numbers still match.
    expect(error.lost.map((warning) => warning.feature)).not.toContain('camera:track');
  });

  it('lets a flattened hierarchy through strict, since nothing numeric was lost', async () => {
    const ir = hierarchyIr();
    const trimmed: AnimationIR = { ...ir, nodes: ir.nodes.slice(0, 2) };
    const result = await exporter.export({ ir: trimmed, motion }, { strict: true });
    expect(isOk(result)).toBe(true);
  });
});

// ── the sparse/baked decision, edge by edge ─────────────────────────────────

describe('choosing between authored keyframes and baked samples', () => {
  const sparse = (layer: LottieLayer, channel: 'p' | 's' | 'o'): boolean => {
    const property = layer.ks[channel];
    // Three authored keys at most in this fixture; anything baked lands on the frame grid.
    return (
      property.a === 1 && property.k.length <= 3 && property.k.every((key) => key.t % 10 === 0)
    );
  };

  it('still matches the evaluator on every node, whichever side of the rule it fell', async () => {
    const ir = sparseEdgeIr();
    const output = await exportIr(ir);
    expect(output.stats.fidelity?.worst ?? 1).toBeLessThan(1e-5);
  });

  it('bakes a track the evaluator folds before the keyframes mean anything', async () => {
    const ir = sparseEdgeIr();
    const doc = document(await exportIr(ir));
    const byName = (name: string): LottieLayer => doc.layers.find((layer) => layer.nm === name)!;

    // additive, looped and multi-step tracks all stop being "the authored keyframes".
    expect(byName('additive').ks.p.a).toBe(1);
    expect(sparse(byName('looped'), 'p')).toBe(false);
    expect(sparse(byName('stepped'), 'p')).toBe(false);
    // Two tracks on one channel: the fold is the answer, not either track.
    expect(sparse(byName('two-x'), 'p')).toBe(false);
    // x and y easing differently cannot share one position property's handles.
    expect(sparse(byName('mixed-ease'), 'p')).toBe(false);
    expect(sparse(byName('hold-mix'), 'p')).toBe(false);
  });

  it('writes authored keys, holds included, when it provably can', async () => {
    const doc = document(await exportIr(sparseEdgeIr()));
    const held = doc.layers.find((layer) => layer.nm === 'held');

    expect(held?.ks.p.a).toBe(1);
    if (held?.ks.p.a !== 1) return;
    expect(held.ks.p.k).toHaveLength(2);
    expect(held.ks.p.k[0]?.h).toBe(1);
  });

  it('keeps an opacity fade sparse, and bakes one the evaluator would clamp', async () => {
    const doc = document(await exportIr(sparseEdgeIr()));
    const byName = (name: string): LottieLayer => doc.layers.find((layer) => layer.nm === name)!;

    const fader = byName('fader').ks.o;
    expect(fader.a).toBe(1);
    if (fader.a === 1) expect(fader.k).toHaveLength(3);

    // 0.8 × 1.5 leaves the 0..1 band, so the clamp engages and the affine shortcut is off.
    expect(sparse(byName('clamped'), 'o')).toBe(false);
    // An overshooting curve leaves the band between its own keyframes.
    expect(sparse(byName('overshoot-fade'), 'o')).toBe(false);
  });

  it('folds the untracked component of a vector property from the authored transform', async () => {
    const doc = document(await exportIr(sparseEdgeIr()));
    const pulse = doc.layers.find((layer) => layer.nm === 'pulse');

    expect(pulse?.ks.s.a).toBe(1);
    if (pulse?.ks.s.a !== 1) return;
    // scale.x is keyed 1 → 1.5; scale.y has no track and stays at the node's own 100 %.
    expect(pulse.ks.s.k[0]?.s).toEqual([100, 100]);
    expect(pulse.ks.s.k.at(-1)?.s).toEqual([150, 100]);
  });

  it('writes an invisible node as fully transparent rather than omitting the layer', async () => {
    const doc = document(await exportIr(sparseEdgeIr()));
    const ghost = doc.layers.find((layer) => layer.nm === 'ghost');
    expect(ghost).toBeDefined();
    expect(ghost?.ks.o).toEqual({ a: 0, k: 0 });
  });

  it('handles short hex, missing geometry and colourless text', async () => {
    const doc = document(await exportIr(sparseEdgeIr()));
    const items = (name: string): string[] => {
      const layer = doc.layers.find((candidate) => candidate.nm === name);
      const group = layer?.shapes?.[0] as
        { it?: { ty: string; c?: { k: number[] } }[] } | undefined;
      return (group?.it ?? []).map((item) => item.ty);
    };

    expect(items('sizeless')).toEqual(['tr']);
    expect(items('bare-line')).toEqual(['tr']);

    const shortHex = doc.layers.find((candidate) => candidate.nm === 'short-hex');
    const group = shortHex?.shapes?.[0] as
      { it?: { ty: string; c?: { k: number[] } }[] } | undefined;
    expect(group?.it?.find((item) => item.ty === 'fl')?.c?.k).toEqual([1, 0, 0]);

    const caption = doc.layers.find((candidate) => candidate.nm === 'caption-one');
    expect(caption?.t?.d.k[0]?.s.fc).toEqual([0, 0, 0]);
    // Both captions name the same typography token, so one font entry serves both.
    expect(doc.fonts?.list).toHaveLength(1);
  });

  it('names an unvarianted asset without a trailing variant suffix', async () => {
    const doc = document(await exportIr(sparseEdgeIr()));
    expect(doc.assets[0]?.p).toMatch(
      /^ast_[0-9A-HJKMNP-TV-Z]{26}_asv_[0-9A-HJKMNP-TV-Z]{26}\.png$/u,
    );
  });

  it('sizes image layers from the supplied parts when it has them', async () => {
    const ir = sparseEdgeIr();
    const { parts } = rigFixture();
    const withParts = unwrap(
      await exporter.export(
        { ir, motion, parts: partImages(parts) },
        { lottie: { measureFidelity: false } },
      ),
    );
    const withoutParts = await exportIr(ir, { lottie: { measureFidelity: false } });

    // The parts' bounds reach (130, 320); the scene is 1920 × 1080.
    expect(document(withParts).assets[0]).toMatchObject({ w: 130, h: 320 });
    expect(document(withoutParts).assets[0]).toMatchObject({ w: 1920, h: 1080 });
  });
});

// ── option validation ───────────────────────────────────────────────────────

describe('options', () => {
  it('rejects a stride that is not a positive whole number of frames', async () => {
    for (const stride of [0, -1, 1.5]) {
      const result = await exporter.export({ ir: windIr(), motion }, { lottie: { stride } });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) continue;
      expect(result.error.kind).toBe('validation');
    }
  });

  it('rejects an unusable precision', async () => {
    const result = await exporter.export({ ir: windIr(), motion }, { lottie: { precision: 40 } });
    expect(isErr(result)).toBe(true);
  });

  it('honours the declared schema version and image directory', async () => {
    const output = await exportIr(richIr(), {
      lottie: { version: '5.9.0', imageDir: 'assets/img/' },
    });
    const doc = document(output);
    expect(doc.v).toBe('5.9.0');
    expect(doc.assets[0]?.u).toBe('assets/img/');
  });

  it('resolves a named curve against the evaluator’s own fallback when no style is supplied', async () => {
    // `easedMoveIr` names `ease-in-out`, and with no style bible in the input both the
    // exporter and `evaluate` have to resolve it against `DEFAULT_EASINGS` from
    // `@rv/anim-engine`. A second local copy of those control points would show up here
    // as a fidelity failure rather than as a file that merely looks slightly wrong.
    const eased = unwrap(await exporter.export({ ir: easedMoveIr() }, {}));
    expect(eased.stats.fidelity?.worst ?? 1).toBeLessThan(1e-9);

    // And the same for a baked hierarchy, where the curve reaches the file through the
    // sampled values rather than through the handles.
    const baked = unwrap(await exporter.export({ ir: hierarchyIr() }, {}));
    expect(baked.stats.fidelity?.worst ?? 1).toBeLessThan(1e-5);
  });

  it('produces byte-identical output with and without an equivalent style supplied', async () => {
    // `testMotion()` restates the evaluator's fallback curves plus `back-out`. Naming
    // them explicitly must change nothing for a clip that only uses the shared two.
    const withStyle = unwrap(await exporter.export({ ir: easedMoveIr(), motion }, {}));
    const without = unwrap(await exporter.export({ ir: easedMoveIr() }, {}));
    expect(without.artifacts[0]?.sha256).toBe(withStyle.artifacts[0]?.sha256);
  });

  it('declares that it requires nothing beyond the IR', () => {
    expect(exporter.requires).toEqual([]);
    expect(exporter.id).toBe('lottie');
    expect(exporter.formatSpec).toContain('lottie-web 5.13');
  });
});
