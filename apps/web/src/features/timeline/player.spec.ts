import { cubicBezierAt, evaluate } from '@rv/anim-engine';
import { AnimationIR, projectScenePoint, type Size } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import { TERRACE_IR } from '../../api/fixtures/animations.fixture';
import { flush, mountStudio } from '../../test/harness';

import ScenePlayer from './ScenePlayer.vue';
import { buildFrame, frameFromSnapshot, type PaintItem } from './player/frame';
import { cameraMatrix, sceneRect } from './player/scene-space';

/**
 * The one property this screen exists to keep: **the preview agrees with the evaluator.**
 *
 * Every assertion below computes its expectation from `evaluate(ir, t)` and from plain
 * arithmetic over the documented scene-space convention - never by calling the player's
 * own matrix helpers back at itself. A test that asked `buildFrame` whether it agrees
 * with `buildFrame` would pass straight through the bug this file exists to catch: the
 * Lottie exporter put scene (0,0) in the corner while the renderer put it in the middle,
 * and its own fidelity metric could not see it because the metric shared the wrong
 * mapping.
 */

const OUTPUT: Size = { width: 800, height: 450 };

/** Twelve times: both ends, a keyframe exactly, and one either side of one. */
const SAMPLES = [0, 1, 250, 599, 600, 999, 1500, 2100, 3600, 4200, 5999, 6000] as const;

function itemFor(items: readonly PaintItem[], name: string): PaintItem {
  const found = items.find((item) => item.name === name);
  if (found === undefined) throw new Error(`no paint item named ${name}`);
  return found;
}

describe('the fixture IR is a real one', () => {
  it('parses against the contract schema', () => {
    // If this fails, every assertion below is about a document the renderer would have
    // refused, and the agreement they prove is worthless.
    const parsed = AnimationIR.safeParse(TERRACE_IR);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });
});

describe('the player agrees with evaluate(ir, t)', () => {
  it('places every node where the evaluator says it is, at every sampled time', () => {
    for (const timeMs of SAMPLES) {
      const snapshot = evaluate(TERRACE_IR, timeMs);
      const frame = buildFrame(TERRACE_IR, timeMs, { output: OUTPUT });

      // The convention, computed from first principles rather than from the player's
      // own `cameraMatrix`: contain fit, origin at the centre of the canvas, camera
      // position subtracted, zoom applied.
      const fit = Math.min(
        OUTPUT.width / TERRACE_IR.sceneSpace.width,
        OUTPUT.height / TERRACE_IR.sceneSpace.height,
      );
      const scale = fit * snapshot.camera.zoom;

      for (const item of frame.items) {
        const resolved = snapshot.nodes.find((node) => node.nodeId === item.nodeId);
        expect(resolved, `${item.name} at ${String(timeMs)}ms`).toBeDefined();
        if (resolved === undefined) continue;

        const world = resolved.worldTransform;
        const expectedX =
          OUTPUT.width / 2 + (world.position.x - snapshot.camera.position.x) * scale;
        const expectedY =
          OUTPUT.height / 2 + (world.position.y - snapshot.camera.position.y) * scale;

        expect(item.matrix.e, `${item.name}.x at ${String(timeMs)}ms`).toBeCloseTo(expectedX, 6);
        expect(item.matrix.f, `${item.name}.y at ${String(timeMs)}ms`).toBeCloseTo(expectedY, 6);
        expect(item.alpha, `${item.name}.alpha at ${String(timeMs)}ms`).toBe(world.opacity);
      }
    }
  });

  it('reports the evaluator own frame number, quantised time and camera', () => {
    for (const timeMs of SAMPLES) {
      const snapshot = evaluate(TERRACE_IR, timeMs);
      const frame = buildFrame(TERRACE_IR, timeMs, { output: OUTPUT });
      expect(frame.frame).toBe(snapshot.frame);
      expect(frame.timeMs).toBe(snapshot.timeMs);
      expect(frame.camera).toEqual(snapshot.camera);
    }
  });

  it('is evaluate composed with the projection, and nothing else', () => {
    for (const timeMs of SAMPLES) {
      expect(buildFrame(TERRACE_IR, timeMs, { output: OUTPUT })).toEqual(
        frameFromSnapshot(TERRACE_IR, evaluate(TERRACE_IR, timeMs), OUTPUT),
      );
    }
  });
});

describe('scene space has its origin at the centre of the canvas', () => {
  it('projects scene (0,0) to the middle of the output', () => {
    const matrix = cameraMatrix(
      { position: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
      { width: 1920, height: 1080 },
      OUTPUT,
    );
    expect(matrix.e).toBeCloseTo(OUTPUT.width / 2, 9);
    expect(matrix.f).toBeCloseTo(OUTPUT.height / 2, 9);
  });

  it('fits the whole composition and letterboxes rather than cropping', () => {
    // A 16:9 scene in a 4:3 box: full width, bars above and below.
    const stage = sceneRect({ width: 1920, height: 1080 }, { width: 800, height: 600 });
    expect(stage.width).toBeCloseTo(800, 9);
    expect(stage.height).toBeCloseTo(450, 9);
    expect(stage.x).toBeCloseTo(0, 9);
    expect(stage.y).toBeCloseTo(75, 9);
  });

  it('puts the corner of the composition at the corner of the stage, not at (0,0)', () => {
    // The exact bug the brief names. A corner-origin mapping would put the top-left of
    // the scene at the top-left of the canvas; a centre-origin one puts it at the stage
    // rect corner, which for a letterboxed fit is not (0,0).
    const output: Size = { width: 800, height: 600 };
    const scene: Size = { width: 1920, height: 1080 };
    const matrix = cameraMatrix({ position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }, scene, output);
    const corner = {
      x: matrix.a * -(scene.width / 2) + matrix.c * -(scene.height / 2) + matrix.e,
      y: matrix.b * -(scene.width / 2) + matrix.d * -(scene.height / 2) + matrix.f,
    };
    const stage = sceneRect(scene, output);
    expect(corner.x).toBeCloseTo(stage.x, 6);
    expect(corner.y).toBeCloseTo(stage.y, 6);
    expect(corner.y).not.toBeCloseTo(0, 3);
  });
});

describe('the shared bezier solver, not a preview-grade copy', () => {
  it('matches cubicBezierAt exactly between two distant keyframes', () => {
    // The lantern ramps on the opacity channel from 600ms to 3600ms, eased. Sampled at
    // a quarter of the way rather than halfway: `ease-in-out` is symmetric, so its
    // midpoint *is* the linear midpoint and a linear preview would pass there. A
    // quarter in is where the two answers differ, and it is the assertion that has
    // teeth.
    const progress = 0.25;
    const timeMs = 600 + (3600 - 600) * progress;
    // `ease-in-out` is (0.42, 0) -> (0.58, 1) in the engine's DEFAULT_EASINGS.
    const eased = cubicBezierAt(progress, 0.42, 0, 0.58, 1);
    const delta = -1 + (0 - -1) * eased;
    const expectedAlpha = Math.min(Math.max(1 * (1 + delta), 0), 1);

    const frame = buildFrame(TERRACE_IR, timeMs, { output: OUTPUT });
    expect(itemFor(frame.items, 'lamp-head').alpha).toBeCloseTo(expectedAlpha, 9);
    // And it is genuinely not the linear answer, or the assertion above proves nothing:
    // a straight line would put this at 0.25 and the real curve is well below it.
    expect(expectedAlpha).not.toBeCloseTo(progress, 2);
  });

  it('holds a stepped curve flat and then jumps, rather than sliding through it', () => {
    // A purpose-built IR with no camera, so the only thing that can move the node is
    // the track. Asserted against the terrace fixture's moon originally, which failed
    // for a reason worth writing down: the camera also moves, so the *projected* y
    // changes even while the *channel* is held. The confound was in the test, not in
    // the player - and isolating it is what makes the assertion mean what it says.
    const stepped = AnimationIR.parse({
      irVersion: 1,
      id: 'anm_4QW8ZK3TB7DR2XNH9JMC0VF4A1',
      name: 'stepped',
      fps: 24,
      durationMs: 6000,
      sceneSpace: { width: 1920, height: 1080 },
      seed: 1,
      nodes: [
        {
          kind: 'shape',
          id: 'nod_4QW8ZK5TB1DR7XNH3JMC9VF06A',
          name: 'dot',
          parentId: null,
          shape: 'ellipse',
          size: { width: 10, height: 10 },
        },
      ],
      tracks: [
        {
          id: 'trk_4QW8ZK7TB1DR5XNH9JMC2VF60A',
          nodeId: 'nod_4QW8ZK5TB1DR7XNH3JMC9VF06A',
          channel: 'position.y',
          keyframes: [
            { timeMs: 0, value: 0, easing: { kind: 'stepped', at: 'end', steps: 6 } },
            { timeMs: 6000, value: -600 },
          ],
        },
      ],
    });

    const yAt = (timeMs: number): number =>
      itemFor(buildFrame(stepped, timeMs, { output: OUTPUT }).items, 'dot').matrix.f;

    expect(yAt(100)).toBeCloseTo(yAt(900), 9);
    expect(yAt(1100)).toBeCloseTo(yAt(1900), 9);
    expect(yAt(900)).not.toBeCloseTo(yAt(1100), 3);
  });
});

describe('scrubbing to t and playing to t produce the same frame', () => {
  it('is a pure function of time, whatever order the times were asked for', () => {
    const scrubbed = buildFrame(TERRACE_IR, 4200, { output: OUTPUT });
    // "Play" through every frame up to the same instant, then ask again.
    for (let frame = 0; frame <= 100; frame += 1) {
      buildFrame(TERRACE_IR, frame * (1000 / TERRACE_IR.fps), { output: OUTPUT });
    }
    expect(buildFrame(TERRACE_IR, 4200, { output: OUTPUT })).toEqual(scrubbed);
  });

  it('gives the same answer to the same question twice', () => {
    expect(buildFrame(TERRACE_IR, 1234, { output: OUTPUT })).toEqual(
      buildFrame(TERRACE_IR, 1234, { output: OUTPUT }),
    );
  });
});

describe('paint order follows the renderer', () => {
  it('sorts by depth descending, so the sky goes down before the title', () => {
    const names = buildFrame(TERRACE_IR, 3000, { output: OUTPUT }).items.map((item) => item.name);
    expect(names.indexOf('sky')).toBeLessThan(names.indexOf('title'));
    expect(names.indexOf('sky')).toBeLessThan(names.indexOf('heron'));
  });

  it('draws nothing for structural nodes', () => {
    const frame = buildFrame(TERRACE_IR, 0, { output: OUTPUT });
    expect(frame.items.some((item) => item.name === 'stage')).toBe(false);
    expect(frame.items.some((item) => item.name === 'lamp')).toBe(false);
  });
});

describe('the component draws the frame it says it draws', () => {
  it('exposes exactly buildFrame(ir, t) for its measured output', async () => {
    const wrapper = await mountStudio(ScenePlayer, {
      locale: 'fa',
      path: '/timeline',
      props: { ir: TERRACE_IR, timeMs: 2100 },
    });
    await flush();

    const exposed = (wrapper.vm as unknown as { currentFrame: ReturnType<typeof buildFrame> })
      .currentFrame;
    expect(exposed).toEqual(buildFrame(TERRACE_IR, 2100, { output: exposed.output }));
    // And that frame is the evaluator's, not a component-local approximation of it.
    expect(exposed).toEqual(
      frameFromSnapshot(TERRACE_IR, evaluate(TERRACE_IR, 2100), exposed.output),
    );
  });

  it('renders the frame number as text, because a canvas is opaque to a screen reader', async () => {
    const wrapper = await mountStudio(ScenePlayer, {
      locale: 'en',
      path: '/timeline',
      props: { ir: TERRACE_IR, timeMs: 2000 },
    });
    await flush();

    expect(wrapper.find('[data-testid="player-position"]').text()).toContain(
      String(evaluate(TERRACE_IR, 2000).frame),
    );
  });
});

describe('projection comes from the contract, not from the player', () => {
  it('is exactly the identity under orthographic, so nothing that exists today moves', () => {
    // The contract states this as a requirement rather than an accident: a document
    // written before `projection` existed has to project to the coordinates it already
    // had. Asserted by projecting a point with a depth that would visibly displace it
    // under any non-identity basis.
    expect(projectScenePoint('orthographic', { x: 123.5, y: -80.25 }, 400)).toEqual({
      x: 123.5,
      y: -80.25,
    });
  });

  it('applies the shared projection rather than a local copy of it', () => {
    // An isometric camera on the same nodes. The expectation is computed with the
    // contract's own function - the point being that the player calls *that* one, so a
    // third opinion about scene space cannot appear here the way it did in the Lottie
    // exporter.
    const camera = TERRACE_IR.camera;
    expect(camera).toBeDefined();
    if (camera === undefined) return;
    const isometric: AnimationIR = {
      ...TERRACE_IR,
      camera: { ...camera, projection: 'isometric' },
    };

    const snapshot = evaluate(isometric, 1200);
    const frame = buildFrame(isometric, 1200, { output: OUTPUT });
    const fit = Math.min(
      OUTPUT.width / isometric.sceneSpace.width,
      OUTPUT.height / isometric.sceneSpace.height,
    );
    const scale = fit * snapshot.camera.zoom;
    const cameraAt = projectScenePoint('isometric', snapshot.camera.position);

    for (const item of frame.items) {
      const resolved = snapshot.nodes.find((node) => node.nodeId === item.nodeId);
      if (resolved === undefined) continue;
      const projected = projectScenePoint(
        'isometric',
        resolved.worldTransform.position,
        resolved.depth,
      );
      expect(item.matrix.e, item.name).toBeCloseTo(
        OUTPUT.width / 2 + (projected.x - cameraAt.x) * scale,
        6,
      );
      expect(item.matrix.f, item.name).toBeCloseTo(
        OUTPUT.height / 2 + (projected.y - cameraAt.y) * scale,
        6,
      );
    }
  });

  it('sorts by projected screen y under isometric, because depth no longer decides', () => {
    const camera = TERRACE_IR.camera;
    if (camera === undefined) return;
    const isometric: AnimationIR = {
      ...TERRACE_IR,
      camera: { ...camera, projection: 'isometric' },
    };
    const items = buildFrame(isometric, 1200, { output: OUTPUT }).items;
    // Ascending screen y: whatever lands highest is painted first.
    const ys = items.map((item) => item.matrix.f);
    expect(ys).toEqual([...ys].toSorted((left, right) => left - right));
  });
});
