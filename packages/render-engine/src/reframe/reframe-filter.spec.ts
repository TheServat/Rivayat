import { FORMAT_PRESETS } from '@rv/contracts';
import { unwrap } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { buildReframePlan } from './reframe-plan';
import { buildReframeFilter, smoothstep, type ShotTiming } from './reframe-filter';
import type { ShotFraming } from './solve-crop';

const COMPOSITION = { width: 2400, height: 1800 };
const MASTER = COMPOSITION;
const SHOT_A = 'sht_0000000000000000000000000A';
const SHOT_B = 'sht_0000000000000000000000000B';

function framing(shotId: string, overrides: Partial<ShotFraming> = {}): ShotFraming {
  return {
    shotId,
    startMs: 0,
    durationMs: 2000,
    safeArea: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    focus: [{ timeMs: 0, region: { x: 0.46, y: 0.44, width: 0.08, height: 0.12 } }],
    priority: 'must-keep',
    ...overrides,
  };
}

const TIMINGS: readonly ShotTiming[] = [
  { shotId: SHOT_A, startMs: 0, durationMs: 2000 },
  { shotId: SHOT_B, startMs: 2000, durationMs: 3000 },
];

function planFor(shots: readonly ShotFraming[]): ReturnType<typeof buildReframePlan> {
  return buildReframePlan({ composition: COMPOSITION, shots }, FORMAT_PRESETS['shorts-9x16']);
}

describe('buildReframeFilter', () => {
  it('produces one trimmed branch per shot and concatenates them', () => {
    const plan = unwrap(
      planFor([framing(SHOT_A), framing(SHOT_B, { startMs: 2000, durationMs: 3000 })]),
    );
    const filter = unwrap(buildReframeFilter(plan, MASTER, TIMINGS));
    expect(filter.graph).toContain('trim=start=0.000000:end=2.000000');
    expect(filter.graph).toContain('trim=start=2.000000:end=5.000000');
    expect(filter.graph).toContain('concat=n=2:v=1:a=0[vout]');
    expect(filter.map).toBe('[vout]');
  });

  it("resets each branch's timestamps, so `t` runs from zero inside a shot", () => {
    // The pan expression relies on it: without `setpts=PTS-STARTPTS` the second shot's
    // `t` starts at 2 and the crop is already past its end before the shot begins.
    const plan = unwrap(planFor([framing(SHOT_A)]));
    const filter = unwrap(buildReframeFilter(plan, MASTER, [TIMINGS[0]!]));
    expect(filter.graph).toContain('setpts=PTS-STARTPTS');
  });

  it('emits constant crop coordinates for a static shot', () => {
    const plan = unwrap(planFor([framing(SHOT_A)]));
    const filter = unwrap(buildReframeFilter(plan, MASTER, [TIMINGS[0]!]));
    expect(filter.graph).toMatch(/crop=\d+:\d+:\d+:\d+/);
    expect(filter.graph).not.toContain('t/');
  });

  it('emits an even crop size, because 4:2:0 halves both dimensions', () => {
    // libx264 refuses yuv420p at an odd width outright, after the whole graph is built.
    const plan = unwrap(planFor([framing(SHOT_A)]));
    const filter = unwrap(buildReframeFilter(plan, MASTER, [TIMINGS[0]!]));
    const match = /crop=(\d+):(\d+):/.exec(filter.graph);
    expect(match).not.toBeNull();
    expect(Number(match?.[1]) % 2).toBe(0);
    expect(Number(match?.[2]) % 2).toBe(0);
  });

  it('emits a time-varying x for a pan', () => {
    const crossing = Array.from({ length: 5 }, (_unused, index) => ({
      timeMs: 500 * index,
      region: { x: 0.05 + 0.2 * index, y: 0.44, width: 0.1, height: 0.12 },
    }));
    const plan = unwrap(planFor([framing(SHOT_A, { focus: crossing })]));
    const filter = unwrap(buildReframeFilter(plan, MASTER, [TIMINGS[0]!]));
    // FFmpeg 8 removed crop's `eval` option and re-evaluates the expressions every
    // frame by default; passing the old flag now fails the whole transcode.
    expect(filter.graph).not.toContain('eval=');
    expect(filter.graph).toContain('(t/2.000000)');
  });

  it('never puts a comma inside an expression', () => {
    // FFmpeg chains filters with commas, and the escaping for one inside an expression
    // differs between the command line, a script file and -filter_complex.
    const crossing = Array.from({ length: 5 }, (_unused, index) => ({
      timeMs: 500 * index,
      region: { x: 0.05 + 0.2 * index, y: 0.44, width: 0.1, height: 0.12 },
    }));
    const plan = unwrap(planFor([framing(SHOT_A, { focus: crossing })]));
    const filter = unwrap(buildReframeFilter(plan, MASTER, [TIMINGS[0]!]));
    const expressions = filter.graph.match(/[xy]=[^:;,]*t\/[^:;,]*/g) ?? [];
    expect(expressions.length).toBeGreaterThan(0);
    for (const expression of expressions) expect(expression).not.toContain(',');
  });

  it('pads rather than crops a letterboxed shot', () => {
    const plan = unwrap(
      planFor([
        framing(SHOT_A, {
          focus: [{ timeMs: 0, region: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 } }],
        }),
      ]),
    );
    const filter = unwrap(buildReframeFilter(plan, MASTER, [TIMINGS[0]!]));
    expect(filter.graph).toContain('force_original_aspect_ratio=decrease');
    expect(filter.graph).toContain('pad=1080:1920');
    expect(filter.graph).not.toContain('crop=');
  });

  it('scales every branch to the delivery size and squares the pixels', () => {
    const plan = unwrap(planFor([framing(SHOT_A)]));
    const filter = unwrap(buildReframeFilter(plan, MASTER, [TIMINGS[0]!]));
    expect(filter.graph).toContain('scale=1080:1920');
    expect(filter.graph).toContain('setsar=1');
  });

  it('refuses a plan with a shot the timings do not cover', () => {
    const plan = unwrap(planFor([framing(SHOT_A)]));
    const result = buildReframeFilter(plan, MASTER, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context).toMatchObject({ shotId: SHOT_A });
  });
});

describe('the emitted filter string, pinned', () => {
  // A golden value, because the graph is a compatibility surface with another program.
  // FFmpeg 8 removing `crop`'s `eval` option was a *hard* error and therefore easy; the
  // dangerous version of that change is a silent one, and this test turns any future
  // syntax change into a diff in review rather than a surprise at render time.
  //
  // Verified against FFmpeg 8.1.2 by `deliver.spec.ts`, which feeds a graph of exactly
  // this shape to the real binary and probes the seven files that come out.
  it('is exactly this, for a static shot and a panning one', () => {
    const crossing = Array.from({ length: 3 }, (_unused, index) => ({
      timeMs: 1000 * index,
      region: { x: 0.06 + 0.39 * index, y: 0.44, width: 0.1, height: 0.12 },
    }));
    const plan = unwrap(
      planFor([
        framing(SHOT_A),
        framing(SHOT_B, { startMs: 2000, durationMs: 3000, focus: crossing }),
      ]),
    );
    const filter = unwrap(buildReframeFilter(plan, MASTER, TIMINGS));

    expect(filter.graph).toBe(
      '[0:v]trim=start=0.000000:end=2.000000,setpts=PTS-STARTPTS,' +
        'crop=1012:1800:694:0,scale=1080:1920,setsar=1[v0];' +
        '[0:v]trim=start=2.000000:end=5.000000,setpts=PTS-STARTPTS,' +
        'crop=w=1012:h=1800:x=0+(1200)*(t/3.000000)*(t/3.000000)*(3-2*(t/3.000000))' +
        ':y=0,scale=1080:1920,setsar=1[v1];' +
        '[v0][v1]concat=n=2:v=1:a=0[vout]',
    );
    expect(filter.map).toBe('[vout]');
  });
});

describe('smoothstep', () => {
  it('collapses to a constant when nothing moves', () => {
    expect(smoothstep(100, 100, 2)).toBe('100');
  });

  it('is the same curve `lerpRect` applies', () => {
    // Evaluated here the way FFmpeg would: u², 3-2u, no clamping needed because `trim`
    // already bounds t.
    const expression = smoothstep(0, 100, 2);
    const evaluate = (t: number): number => {
      const u = t / 2;
      return 0 + 100 * u * u * (3 - 2 * u);
    };
    expect(expression).toContain('(t/2.000000)');
    expect(evaluate(0)).toBe(0);
    expect(evaluate(1)).toBe(50);
    expect(evaluate(2)).toBe(100);
  });
});
