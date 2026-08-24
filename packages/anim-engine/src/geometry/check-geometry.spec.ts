import { describe, expect, it } from 'vitest';
import { at } from '@rv/shared-kernel';
import type { AnimationIR, NodeId } from '@rv/contracts';

import { BIRD_EXTENTS, BIRD_NODE_IDS, brokenBird, shoulderPivotedBird } from '../__fixtures__/bird';
import { DEFAULT_EASINGS } from '../evaluate';
import { GEOMETRY_FINDING_CODES, cameraFrameExcursion, checkGeometry } from './check-geometry';
import type { GeometryFinding, GeometryFindingCode } from './check-geometry';

// ── a scene builder, so each test states only what it is about ───────────────

let sequence = 0;
function nodeId(): NodeId {
  sequence += 1;
  return `nod_01J8ZQ4E7K9M2N4P6R8T0VC${sequence.toString(36).toUpperCase().padStart(3, '0')}`;
}

interface PartSpec {
  readonly id: NodeId;
  readonly parentId: NodeId | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly shape?: 'rect' | 'ellipse';
  readonly anchorX?: number;
  readonly anchorY?: number;
  readonly visible?: boolean;
}

interface SceneSpec {
  readonly parts: readonly PartSpec[];
  readonly tracks?: readonly unknown[];
  readonly behaviours?: readonly unknown[];
  readonly durationMs?: number;
  readonly camera?: unknown;
}

function scene(spec: SceneSpec): AnimationIR {
  return {
    irVersion: 1,
    id: 'anm_01J8ZQ4E7K9M2N4P6R8T0VC99',
    name: 'scene',
    fps: 24,
    durationMs: spec.durationMs ?? 1000,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 7,
    nodes: spec.parts.map((part) => ({
      kind: 'shape',
      id: part.id,
      name: `n-${part.id.slice(-3).toLowerCase()}`,
      parentId: part.parentId,
      transform: {
        position: { x: part.x, y: part.y },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: part.anchorX ?? 0.5, y: part.anchorY ?? 0.5 },
        opacity: 1,
      },
      visible: part.visible ?? true,
      depth: 0,
      shape: part.shape ?? 'rect',
      strokeWidth: 0,
      size: { width: part.width, height: part.height },
    })),
    tracks: spec.tracks ?? [],
    behaviours: spec.behaviours ?? [],
    markers: [],
    ...(spec.camera === undefined ? {} : { camera: spec.camera }),
  } as unknown as AnimationIR;
}

function codes(findings: readonly GeometryFinding[]): readonly GeometryFindingCode[] {
  return findings.map((finding) => finding.code);
}

function only(
  findings: readonly GeometryFinding[],
  code: GeometryFindingCode,
): readonly GeometryFinding[] {
  return findings.filter((finding) => finding.code === code);
}

// ── the defect this whole module exists for ──────────────────────────────────

describe('the bird that shipped with a hole in it', () => {
  it('reports both wings as pivoting outside the body they are welded to', () => {
    const report = checkGeometry(brokenBird(), { extents: BIRD_EXTENTS });
    const pivots = only(report.findings, 'joint.pivot-outside-parent');

    expect(pivots.map((finding) => finding.nodeId)).toEqual(
      expect.arrayContaining([BIRD_NODE_IDS.wingL, BIRD_NODE_IDS.wingR]),
    );
    for (const finding of pivots) {
      expect(finding.relatedNodeId).toBe(BIRD_NODE_IDS.bird);
      expect(finding.measured).toBeGreaterThan(5);
      expect(finding.measured).toBeGreaterThan(finding.tolerance);
      expect(finding.unit).toBe('scene-px');
    }
  });

  it('goes quiet once each wing pivots at its shoulder instead of its own bottom edge', () => {
    const report = checkGeometry(shoulderPivotedBird(), { extents: BIRD_EXTENTS });
    expect(report.findings).toEqual([]);
    // The fix must not work by making the wings stop being joints.
    expect(report.joints).toBe(2);
  });

  it('measures the same two joints in both riggings, so the difference is the rig', () => {
    const broken = checkGeometry(brokenBird(), { extents: BIRD_EXTENTS });
    const fixed = checkGeometry(shoulderPivotedBird(), { extents: BIRD_EXTENTS });
    expect(broken.joints).toBe(fixed.joints);
    expect(broken.measuredNodes).toBe(fixed.measuredNodes);
    expect(broken.sampledFrames).toBe(fixed.sampledFrames);
  });

  it('catches the cause before any gap is visible: the wings never actually separate', () => {
    // The whole reason pivot containment leads. The wings sweep across the body at every
    // angle, so no pair of them is ever disjoint - the hole is enclosed by three shapes,
    // which pairwise separation cannot see and which containment predicts from frame 0.
    const report = checkGeometry(brokenBird(), { extents: BIRD_EXTENTS });
    expect(only(report.findings, 'joint.opened')).toEqual([]);
    expect(only(report.findings, 'joint.pivot-outside-parent')).toHaveLength(2);
  });
});

// ── joints ───────────────────────────────────────────────────────────────────

describe('joint detection', () => {
  it('treats two related nodes that share ink at rest as a joint, and others as unrelated', () => {
    const body = nodeId();
    const welded = nodeId();
    const floating = nodeId();
    const report = checkGeometry(
      scene({
        parts: [
          { id: body, parentId: null, x: 0, y: 0, width: 100, height: 100 },
          { id: welded, parentId: body, x: 40, y: 0, width: 40, height: 20 },
          { id: floating, parentId: body, x: 400, y: 0, width: 40, height: 20 },
        ],
      }),
    );
    expect(report.joints).toBe(1);
  });

  it('does not call a node a joint with a parent whose size nobody knows', () => {
    const invisibleParent = nodeId();
    const child = nodeId();
    const ir = scene({
      parts: [
        { id: invisibleParent, parentId: null, x: 0, y: 0, width: 100, height: 100 },
        { id: child, parentId: invisibleParent, x: 0, y: 0, width: 40, height: 20 },
      ],
    });
    // Strip the parent's size, as an asset-instance node would arrive.
    const stripped = {
      ...ir,
      nodes: ir.nodes.map((node) =>
        node.id === invisibleParent ? { ...node, size: undefined } : node,
      ),
    } as AnimationIR;

    const report = checkGeometry(stripped);
    expect(report.joints).toBe(0);
    expect(report.measuredNodes).toBe(1);
    expect(report.unmeasuredNodes).toBe(1);
  });

  it('never treats a root node as a joint, however large it is', () => {
    const root = nodeId();
    const report = checkGeometry(
      scene({ parts: [{ id: root, parentId: null, x: 0, y: 0, width: 100, height: 100 }] }),
    );
    expect(report.joints).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it('reports a part that swings off its parent, with the frame it happened on', () => {
    const body = nodeId();
    const limb = nodeId();
    const report = checkGeometry(
      scene({
        durationMs: 1000,
        parts: [
          { id: body, parentId: null, x: 0, y: 0, width: 100, height: 100 },
          { id: limb, parentId: body, x: 40, y: 0, width: 40, height: 20 },
        ],
        tracks: [
          {
            id: 'trk_01J8ZQ4E7K9M2N4P6R8T0VC01',
            nodeId: limb,
            channel: 'position.x',
            // Offsets from the authored pose: a non-additive track replaces the
            // behaviour layer, and `evaluate` still folds the result onto the node's own
            // transform.
            keyframes: [
              { timeMs: 0, value: 0 },
              { timeMs: 1000, value: 360 },
            ],
            before: 'hold',
            after: 'hold',
            additive: false,
          },
        ],
      }),
    );

    const opened = only(report.findings, 'joint.opened');
    expect(opened).toHaveLength(1);
    const finding = at(opened, 0);
    expect(finding.nodeId).toBe(limb);
    expect(finding.relatedNodeId).toBe(body);
    // Worst at the end of the travel: the limb's near edge at 40 + 345 - 20 = 365,
    // against a body that ends at 50.
    expect(finding.frame).toBe(23);
    expect(finding.measured).toBeCloseTo(315, 6);
  });

  it('keeps the worst sample rather than the first or the last one it saw', () => {
    const body = nodeId();
    const limb = nodeId();
    const report = checkGeometry(
      scene({
        durationMs: 1000,
        parts: [
          { id: body, parentId: null, x: 0, y: 0, width: 100, height: 100 },
          { id: limb, parentId: body, x: 40, y: 0, width: 40, height: 20 },
        ],
        tracks: [
          {
            id: 'trk_01J8ZQ4E7K9M2N4P6R8T0VC02',
            nodeId: limb,
            channel: 'position.x',
            keyframes: [
              { timeMs: 0, value: 0 },
              { timeMs: 500, value: 360 },
              { timeMs: 1000, value: 5 },
            ],
            before: 'hold',
            after: 'hold',
            additive: false,
          },
        ],
      }),
    );
    const opened = only(report.findings, 'joint.opened');
    expect(opened).toHaveLength(1);
    const finding = at(opened, 0);
    // Halfway, not at either end.
    expect(finding.frame).toBe(12);
    expect(finding.measured).toBeCloseTo(330, 6);
  });
});

// ── containment in the scene, and in frame ───────────────────────────────────

describe('staying in the picture', () => {
  const centred = { x: -960, y: -540, width: 1920, height: 1080 };

  it('says nothing about an oversized layer nobody asked it to contain', () => {
    const sky = nodeId();
    const report = checkGeometry(
      scene({ parts: [{ id: sky, parentId: null, x: 0, y: 0, width: 4000, height: 2400 }] }),
    );
    expect(report.findings).toEqual([]);
  });

  it('reports how far a node declared as contained reaches outside the scene box', () => {
    const prop = nodeId();
    const report = checkGeometry(
      scene({ parts: [{ id: prop, parentId: null, x: 1000, y: 0, width: 100, height: 100 }] }),
      { containedNodeIds: [prop] },
    );
    const out = only(report.findings, 'scene.out-of-bounds');
    expect(out).toHaveLength(1);
    // 1000 + 50 past a canvas that ends at 960.
    expect(at(out, 0).measured).toBeCloseTo(90, 6);
    expect(at(out, 0).nodeId).toBe(prop);
  });

  it('defaults the scene box to the canvas centred on the origin', () => {
    const prop = nodeId();
    const ir = scene({
      parts: [{ id: prop, parentId: null, x: 900, y: 0, width: 100, height: 100 }],
    });
    const byDefault = checkGeometry(ir, { containedNodeIds: [prop] });
    const explicit = checkGeometry(ir, { containedNodeIds: [prop], sceneBounds: centred });
    expect(byDefault.findings).toEqual(explicit.findings);
  });

  it('honours a scene box the caller supplies instead of the default one', () => {
    const prop = nodeId();
    const ir = scene({
      parts: [{ id: prop, parentId: null, x: 0, y: 0, width: 100, height: 100 }],
    });
    const report = checkGeometry(ir, {
      containedNodeIds: [prop],
      sceneBounds: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(codes(report.findings)).toEqual(['scene.out-of-bounds']);
  });

  it('quietly skips a contained node it has no extent for, rather than inventing one', () => {
    const prop = nodeId();
    const report = checkGeometry(
      scene({ parts: [{ id: prop, parentId: null, x: 0, y: 0, width: 100, height: 100 }] }),
      { containedNodeIds: ['nod_01J8ZQ4E7K9M2N4P6R8T0VCZZZ'] },
    );
    expect(report.findings).toEqual([]);
  });

  it('reports a focus target the camera has lost, in scene pixels', () => {
    const subject = nodeId();
    const report = checkGeometry(
      scene({
        parts: [{ id: subject, parentId: null, x: 1500, y: 0, width: 40, height: 40 }],
        camera: {
          keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
          focusNodeId: subject,
          shakeAmplitude: 0,
          shakeSeed: 0,
          projection: 'orthographic',
        },
      }),
      { checkCameraFocus: true },
    );
    const lost = only(report.findings, 'camera.focus-out-of-frame');
    expect(lost).toHaveLength(1);
    expect(at(lost, 0).measured).toBeCloseTo(540, 6);
  });

  it('leaves the focus alone unless asked, because most clips reframe around it anyway', () => {
    const subject = nodeId();
    const report = checkGeometry(
      scene({
        parts: [{ id: subject, parentId: null, x: 1500, y: 0, width: 40, height: 40 }],
        camera: {
          keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
          focusNodeId: subject,
          shakeAmplitude: 0,
          shakeSeed: 0,
          projection: 'orthographic',
        },
      }),
    );
    expect(report.findings).toEqual([]);
  });

  it('has nothing to say about a focus target when the clip has no camera at all', () => {
    const subject = nodeId();
    const report = checkGeometry(
      scene({ parts: [{ id: subject, parentId: null, x: 5000, y: 0, width: 40, height: 40 }] }),
      { checkCameraFocus: true },
    );
    expect(report.findings).toEqual([]);
  });

  it('skips a focus target whose size it does not know', () => {
    const subject = nodeId();
    const ir = scene({
      parts: [{ id: subject, parentId: null, x: 5000, y: 0, width: 40, height: 40 }],
      camera: {
        keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
        focusNodeId: subject,
        shakeAmplitude: 0,
        shakeSeed: 0,
        projection: 'orthographic',
      },
    });
    const stripped = {
      ...ir,
      nodes: ir.nodes.map((node) => ({ ...node, size: undefined })),
    } as AnimationIR;
    expect(checkGeometry(stripped, { checkCameraFocus: true }).findings).toEqual([]);
  });

  it('tightens with the safe area, so a platform overlay can be respected', () => {
    const subject = nodeId();
    const ir = scene({
      parts: [{ id: subject, parentId: null, x: 700, y: 0, width: 40, height: 40 }],
      camera: {
        keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
        focusNodeId: subject,
        shakeAmplitude: 0,
        shakeSeed: 0,
        projection: 'orthographic',
      },
    });
    expect(checkGeometry(ir, { checkCameraFocus: true }).findings).toEqual([]);
    expect(
      checkGeometry(ir, { checkCameraFocus: true, safeAreaFraction: 0.5 }).findings,
    ).toHaveLength(1);
  });
});

describe('cameraFrameExcursion', () => {
  const canvas = { width: 1920, height: 1080 };
  const still = { position: { x: 0, y: 0 }, zoom: 1, rotation: 0 };

  it('is zero anywhere inside the frame and grows with the distance outside it', () => {
    expect(cameraFrameExcursion({ x: 0, y: 0 }, still, canvas, 1)).toBe(0);
    expect(cameraFrameExcursion({ x: 1000, y: 0 }, still, canvas, 1)).toBeCloseTo(40, 9);
  });

  it('shrinks the frame as the camera pushes in, which is what loses a subject', () => {
    const pushedIn = { ...still, zoom: 2 };
    expect(cameraFrameExcursion({ x: 600, y: 0 }, still, canvas, 1)).toBe(0);
    expect(cameraFrameExcursion({ x: 600, y: 0 }, pushedIn, canvas, 1)).toBeCloseTo(120, 9);
  });

  it('follows the camera when it pans, rather than measuring against the canvas', () => {
    const panned = { ...still, position: { x: 1000, y: 0 } };
    expect(cameraFrameExcursion({ x: 1000, y: 0 }, panned, canvas, 1)).toBe(0);
  });

  it('rolls with the camera, so a rotated frame is judged in the frame’s own axes', () => {
    const rolled = { ...still, rotation: 90 };
    // 700 to the right is inside a level frame and outside one rolled a quarter turn,
    // because the frame's short axis now points along scene x.
    expect(cameraFrameExcursion({ x: 700, y: 0 }, still, canvas, 1)).toBe(0);
    expect(cameraFrameExcursion({ x: 700, y: 0 }, rolled, canvas, 1)).toBeCloseTo(160, 6);
  });
});

// ── popping and vanishing ────────────────────────────────────────────────────

function opacityStep(target: NodeId, id: string): unknown {
  return {
    id,
    nodeId: target,
    channel: 'opacity',
    keyframes: [
      { timeMs: 0, value: 0 },
      { timeMs: 500, value: 0 },
      { timeMs: 501, value: -1 },
    ],
    before: 'hold',
    after: 'hold',
    additive: false,
  };
}

describe('silhouette continuity', () => {
  it('reports a part that vanishes between two frames', () => {
    const part = nodeId();
    const report = checkGeometry(
      scene({
        durationMs: 1000,
        parts: [{ id: part, parentId: null, x: 0, y: 0, width: 100, height: 100 }],
        tracks: [opacityStep(part, 'trk_01J8ZQ4E7K9M2N4P6R8T0VC10')],
      }),
    );
    const popped = only(report.findings, 'silhouette.area-discontinuity');
    expect(popped).toHaveLength(1);
    const finding = at(popped, 0);
    expect(finding.nodeId).toBe(part);
    expect(finding.frame).toBe(13);
    expect(finding.unit).toBe('ratio');
    expect(finding.measured).toBeGreaterThan(finding.tolerance);
  });

  it('reports every part that pops on the same frame, not just the first one', () => {
    const a = nodeId();
    const b = nodeId();
    const report = checkGeometry(
      scene({
        durationMs: 1000,
        parts: [
          { id: a, parentId: null, x: 0, y: 0, width: 100, height: 100 },
          { id: b, parentId: null, x: 300, y: 0, width: 100, height: 100 },
        ],
        tracks: [
          opacityStep(a, 'trk_01J8ZQ4E7K9M2N4P6R8T0VC11'),
          opacityStep(b, 'trk_01J8ZQ4E7K9M2N4P6R8T0VC12'),
        ],
      }),
    );
    expect(only(report.findings, 'silhouette.area-discontinuity')).toHaveLength(2);
  });

  it('does not call a blink a pop, though it closes an eyelid inside a single frame', () => {
    const lid = nodeId();
    const report = checkGeometry(
      scene({
        durationMs: 5000,
        parts: [{ id: lid, parentId: null, x: 0, y: 0, width: 40, height: 20 }],
        behaviours: [
          {
            id: 'bhv_01J8ZQ4E7K9M2N4P6R8T0VC20',
            kind: 'blink',
            nodeId: lid,
            enabled: true,
            seed: 3,
            weight: 1,
            intervalMs: 4200,
            varianceMs: 0,
            closeDurationMs: 110,
          },
        ],
      }),
    );
    expect(report.findings).toEqual([]);
  });

  it('does not call a flapping wing a pop, because rigid motion does not change area', () => {
    const report = checkGeometry(brokenBird(), { extents: BIRD_EXTENTS });
    expect(only(report.findings, 'silhouette.area-discontinuity')).toEqual([]);
  });

  it('does not blame a clip rendered on 2s for its own cadence', () => {
    const part = nodeId();
    const report = checkGeometry(
      scene({
        durationMs: 500,
        parts: [{ id: part, parentId: null, x: 0, y: 0, width: 100, height: 100 }],
        tracks: [
          {
            id: 'trk_01J8ZQ4E7K9M2N4P6R8T0VC13',
            nodeId: part,
            channel: 'scale.x',
            keyframes: [
              { timeMs: 0, value: -1 },
              { timeMs: 20, value: 0 },
            ],
            before: 'hold',
            after: 'hold',
            additive: false,
          },
        ],
      }),
      { motion: { stepMode: 'on-2s', easings: [...DEFAULT_EASINGS], tempo: 1 } },
    );
    expect(only(report.findings, 'silhouette.area-discontinuity')).toEqual([]);
  });

  it('says nothing about a part that lays down no ink at all', () => {
    const hidden = nodeId();
    const report = checkGeometry(
      scene({
        parts: [
          { id: hidden, parentId: null, x: 0, y: 0, width: 100, height: 100, visible: false },
        ],
      }),
    );
    expect(report.findings).toEqual([]);
  });
});

// ── the gate's own honesty ───────────────────────────────────────────────────

describe('the report itself', () => {
  it('says how much it measured, so a gate that measured nothing cannot look clean', () => {
    const ir = brokenBird();
    const blind = checkGeometry(ir);
    expect(blind.measuredNodes).toBe(0);
    expect(blind.unmeasuredNodes).toBe(4);
    expect(blind.joints).toBe(0);
    expect(blind.findings).toEqual([]);

    const sighted = checkGeometry(ir, { extents: BIRD_EXTENTS });
    expect(sighted.measuredNodes).toBe(3);
    expect(sighted.findings.length).toBeGreaterThan(0);
  });

  it('records the tolerance it judged against, so a finding can be argued with', () => {
    const report = checkGeometry(brokenBird(), { extents: BIRD_EXTENTS });
    expect(report.toleranceScenePx).toBeCloseTo(0.5, 12);
    for (const finding of report.findings) expect(finding.tolerance).toBe(report.toleranceScenePx);
  });

  it('honours a tolerance the caller sets, and forgives the defect when it is loose enough', () => {
    const report = checkGeometry(brokenBird(), {
      extents: BIRD_EXTENTS,
      toleranceScenePx: 50,
    });
    expect(report.findings).toEqual([]);
    expect(report.toleranceScenePx).toBe(50);
  });

  it('samples the clip at its own frame rate unless told otherwise', () => {
    const ir = brokenBird();
    expect(checkGeometry(ir, { extents: BIRD_EXTENTS }).sampledFrames).toBe(144);
    expect(checkGeometry(ir, { extents: BIRD_EXTENTS, sampleFps: 4 }).sampledFrames).toBe(24);
  });

  it('always looks at at least one frame, even for a clip shorter than a frame', () => {
    const part = nodeId();
    const ir = scene({
      durationMs: 1,
      parts: [{ id: part, parentId: null, x: 0, y: 0, width: 10, height: 10 }],
    });
    expect(checkGeometry(ir).sampledFrames).toBe(1);
  });

  it('refuses to sample at a rate that would produce no frames', () => {
    expect(() => checkGeometry(brokenBird(), { sampleFps: 0 })).toThrow(/sampleFps/);
  });

  it('refuses a refinement too coarse to tell a jump from a slope', () => {
    expect(() => checkGeometry(brokenBird(), { extents: BIRD_EXTENTS, areaSubSamples: 1 })).toThrow(
      /areaSubSamples/,
    );
  });

  it('returns the same report twice, because a gate that drifts cannot be a gate', () => {
    const first = checkGeometry(brokenBird(), { extents: BIRD_EXTENTS });
    const second = checkGeometry(brokenBird(), { extents: BIRD_EXTENTS });
    expect(second).toEqual(first);
  });

  it('orders findings worst first, so the top of the list is where to look', () => {
    const prop = nodeId();
    const report = checkGeometry(
      scene({
        parts: [{ id: prop, parentId: null, x: 3000, y: 0, width: 100, height: 100 }],
        camera: {
          keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
          focusNodeId: prop,
          shakeAmplitude: 0,
          shakeSeed: 0,
          projection: 'orthographic',
        },
      }),
      { containedNodeIds: [prop], checkCameraFocus: true },
    );
    expect(report.findings.length).toBeGreaterThan(1);
    const measured = report.findings.map((finding) => finding.measured);
    expect([...measured].sort((left, right) => right - left)).toEqual(measured);
  });

  it('judges the frames that will ship, so a motion style changes what it measures', () => {
    const body = nodeId();
    const limb = nodeId();
    const ir = scene({
      durationMs: 1000,
      parts: [
        { id: body, parentId: null, x: 0, y: 0, width: 100, height: 100 },
        { id: limb, parentId: body, x: 40, y: 0, width: 40, height: 20 },
      ],
      tracks: [
        {
          id: 'trk_01J8ZQ4E7K9M2N4P6R8T0VC14',
          nodeId: limb,
          channel: 'position.x',
          keyframes: [
            { timeMs: 0, value: 0 },
            { timeMs: 1000, value: 360 },
          ],
          before: 'hold',
          after: 'hold',
          additive: false,
        },
      ],
    });

    const atTempo = (tempo: number): number => {
      const found = only(
        checkGeometry(ir, { motion: { stepMode: 'smooth', easings: [...DEFAULT_EASINGS], tempo } })
          .findings,
        'joint.opened',
      );
      return at(found, 0).measured;
    };

    // A quarter-speed style only gets the limb a quarter of the way out in the same clip.
    expect(atTempo(0.25)).toBeLessThan(atTempo(1));
  });

  it('takes a coarser silhouette when told to, and still finds the same defect', () => {
    const coarse = checkGeometry(brokenBird(), { extents: BIRD_EXTENTS, ellipseSegments: 8 });
    expect(only(coarse.findings, 'joint.pivot-outside-parent')).toHaveLength(2);
  });

  it('only ever emits codes it declares', () => {
    const report = checkGeometry(brokenBird(), { extents: BIRD_EXTENTS });
    for (const finding of report.findings) {
      expect(GEOMETRY_FINDING_CODES).toContain(finding.code);
    }
  });
});
