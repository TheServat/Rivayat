import { describe, expect, it } from 'vitest';
import { checkGeometry } from '@rv/anim-engine';
import { AnimationIR } from '@rv/contracts';

import { buildGroveScene, solveViewport } from './animate';

function nodeNames(ir: ReturnType<typeof buildGroveScene>['ir']): Map<string, string> {
  return new Map(ir.nodes.map((node) => [node.name, node.id]));
}

describe('the grove scene', () => {
  it('is built the same way twice, ids and all', () => {
    expect(buildGroveScene().ir).toEqual(buildGroveScene().ir);
  });

  it('draws a bird with no hole in it', () => {
    // The regression gate for the defect that started all of this: the wings used to
    // pivot at their own bottom-centre, 22 px clear of the body, and tore a triangular
    // hole through it in every frame of `workspace/demo/grove-16x9.mp4`.
    const report = checkGeometry(buildGroveScene().ir);
    expect(report.findings).toEqual([]);
  });

  it('measures every painted node, so the clean report is a claim about something', () => {
    const report = checkGeometry(buildGroveScene().ir);
    expect(report.measuredNodes).toBe(13);
    // Only the root group, which paints nothing, has no extent.
    expect(report.unmeasuredNodes).toBe(1);
    expect(report.joints).toBe(5);
  });

  it('pivots each wing inside the body, which is the property that keeps the joint shut', () => {
    const { ir } = buildGroveScene();
    const byName = nodeNames(ir);
    for (const side of ['wing-l', 'wing-r']) {
      const wing = ir.nodes.find((node) => node.id === byName.get(side));
      expect(wing?.transform.position.y).toBe(-12);
      // Anchored at the wing's inner end, at mid-height: the shoulder.
      expect(wing?.transform.anchor.y).toBe(0.5);
      expect(Math.abs(wing?.transform.position.x ?? 0)).toBe(6);
    }
  });

  it('carries its own geometry, so the linter can measure it without a paint table', () => {
    const { ir } = buildGroveScene();
    const bird = ir.nodes.find((node) => node.name === 'bird');
    expect(bird?.kind).toBe('shape');
    expect(bird?.kind === 'shape' ? bird.size : undefined).toEqual({ width: 46, height: 20 });
  });

  it('names a focus target that exists, which is what the reframer follows', () => {
    const { ir, focusNodeName } = buildGroveScene();
    expect(focusNodeName).toBe('bird');
    expect(ir.camera?.focusNodeId).toBe(nodeNames(ir).get('bird'));
  });

  /**
   * The one thing the schema still refuses, stated as a test rather than left to be
   * rediscovered.
   *
   * The two wings mirror each other by giving the right one `amplitudeDeg: -46`, and
   * `FlapBehaviour.amplitudeDeg` is `min(0)`. `flap` has no phase or mirror field and the
   * component transform model cannot conjugate a rotation through a negative scale, so
   * there is no other way to express a mirrored flap today. This asserts that it is the
   * **only** thing wrong with the document - so the day the contract grows a mirror, this
   * test fails and tells somebody to delete it.
   */
  it('validates apart from the mirrored flap the contract has no way to express', () => {
    const parsed = AnimationIR.safeParse(buildGroveScene().ir);
    expect(parsed.success).toBe(false);
    const issues = parsed.success ? [] : parsed.error.issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path.join('.')).toMatch(/^behaviours\.\d+\.amplitudeDeg$/);
  });
});

describe('solveViewport', () => {
  it('takes the whole canvas when the target matches the composition', () => {
    expect(solveViewport({ width: 1280, height: 720 }, { x: 960, y: 540 })).toEqual({
      width: 1280,
      height: 720,
      sx: 0,
      sy: 0,
      sw: 1920,
      sh: 1080,
    });
  });

  it('crops the width for a taller target, and centres it on the focus', () => {
    const view = solveViewport({ width: 720, height: 1280 }, { x: 960, y: 540 });
    expect(view.sw).toBeCloseTo(607.5, 6);
    expect(view.sh).toBe(1080);
    expect(view.sx).toBeCloseTo(960 - 607.5 / 2, 6);
  });

  it('clamps the crop inside the canvas rather than following a focus off the edge', () => {
    expect(solveViewport({ width: 720, height: 1280 }, { x: -500, y: 540 }).sx).toBe(0);
    expect(solveViewport({ width: 720, height: 1280 }, { x: 5000, y: 540 }).sx).toBeCloseTo(
      1920 - 607.5,
      6,
    );
  });

  it('crops the height for a wider target', () => {
    const view = solveViewport({ width: 1920, height: 500 }, { x: 960, y: 540 });
    expect(view.sw).toBe(1920);
    expect(view.sh).toBeCloseTo(500, 6);
    expect(view.sy).toBeCloseTo(540 - 250, 6);
  });
});
