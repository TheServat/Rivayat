import { createRng } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { Behaviour } from '@rv/contracts';

import {
  behaviourWeight,
  evaluateBehaviour,
  parallaxFactor,
  type BehaviourContext,
} from './behaviours';

const NODE = 'nod_01J8ZQ4E7K9M2N4P6R8T0V2W4X';
const BEHAVIOUR = 'bhv_01J8ZQ4E7K9M2N4P6R8T0V2W4X';

function ctx(overrides: Partial<BehaviourContext> = {}): BehaviourContext {
  return {
    timeMs: 0,
    depth: 0,
    camera: { position: { x: 0, y: 0 }, zoom: 1 },
    rng: createRng('test'),
    ...overrides,
  };
}

function behaviour<K extends Behaviour['kind']>(
  kind: K,
  extra: Record<string, unknown> = {},
): Behaviour {
  return {
    id: BEHAVIOUR,
    nodeId: NODE,
    kind,
    enabled: true,
    seed: 12345,
    weight: 1,
    ...defaultsFor(kind),
    ...extra,
  } as Behaviour;
}

function defaultsFor(kind: Behaviour['kind']): Record<string, unknown> {
  switch (kind) {
    case 'wind':
      return { hz: 0.3, amplitude: 0.25, gustiness: 0.4, direction: 0, tipBias: 0.7 };
    case 'breathe':
      return { hz: 0.25, amplitude: 0.15 };
    case 'blink':
      return { intervalMs: 4200, varianceMs: 1800, closeDurationMs: 110 };
    case 'sway':
      return { hz: 0.5, amplitudeDeg: 4, axis: 'rotation' };
    case 'walk-cycle':
      return { stepsPerSecond: 1.6, strideLength: 60, bounce: 0.3, gait: 'walk' };
    case 'flap':
      return { hz: 4, amplitudeDeg: 50, downstrokeBias: 0.35 };
    case 'orbit':
      return { centre: { x: 0, y: 0 }, radius: { x: 10, y: 10 }, periodMs: 4000, phase: 0 };
    case 'parallax':
      return { strength: 0.5, curve: 'exponential' };
    case 'boil':
      return { amplitude: 0.15, hz: 8 };
    case 'spring':
      return { stiffness: 0.5, damping: 0.6, follows: 'position.x' };
    case 'look-at':
      return { targetNodeId: NODE, maxAngleDeg: 35, responsiveness: 0.5 };
    case 'follow-path':
      return { path: 'M0,0 L10,10', durationMs: 1000, loop: 'loop' };
    case 'lip-sync':
      return { phonemes: [{ timeMs: 0, viseme: 'aa', durationMs: 200 }], intensity: 0.8 };
  }
}

const ALL_KINDS: readonly Behaviour['kind'][] = [
  'wind',
  'breathe',
  'blink',
  'sway',
  'walk-cycle',
  'flap',
  'orbit',
  'parallax',
  'boil',
  'spring',
  'look-at',
  'follow-path',
  'lip-sync',
];

describe('every kind is handled', () => {
  it('dispatches without throwing, and returns finite numbers', () => {
    for (const kind of ALL_KINDS) {
      const deltas = evaluateBehaviour(behaviour(kind), ctx({ timeMs: 1234 }));
      for (const [channel, value] of Object.entries(deltas)) {
        expect(Number.isFinite(value), `${kind}.${channel} must be finite`).toBe(true);
      }
    }
  });

  it('rejects an unknown kind loudly rather than silently doing nothing', () => {
    const rogue = { ...behaviour('wind'), kind: 'teleport' } as unknown as Behaviour;
    expect(() => evaluateBehaviour(rogue, ctx())).toThrow(/Unhandled behaviour kind/);
  });
});

describe('seek-safety - the property the whole engine rests on', () => {
  it('gives the same answer at t however it was reached', () => {
    for (const kind of ALL_KINDS) {
      const b = behaviour(kind);
      const cold = evaluateBehaviour(b, ctx({ timeMs: 4200 }));

      for (let ms = 0; ms <= 8000; ms += 33) evaluateBehaviour(b, ctx({ timeMs: ms }));
      for (let ms = 8000; ms >= 0; ms -= 33) evaluateBehaviour(b, ctx({ timeMs: ms }));

      expect(evaluateBehaviour(b, ctx({ timeMs: 4200 })), kind).toEqual(cold);
    }
  });

  it('depends on the seed, so two instances of the same asset do not move in lockstep', () => {
    const a = evaluateBehaviour(behaviour('wind', { seed: 1 }), ctx({ timeMs: 3000 }));
    const b = evaluateBehaviour(behaviour('wind', { seed: 2 }), ctx({ timeMs: 3000 }));
    expect(a).not.toEqual(b);
  });
});

describe('gating', () => {
  it('contributes nothing when disabled', () => {
    expect(evaluateBehaviour(behaviour('wind', { enabled: false }), ctx({ timeMs: 500 }))).toEqual(
      {},
    );
    expect(behaviourWeight(behaviour('wind', { enabled: false }), 500)).toBe(0);
  });

  it('contributes nothing outside its window, and something inside it', () => {
    const windowed = behaviour('sway', { startMs: 1000, endMs: 2000 });
    expect(evaluateBehaviour(windowed, ctx({ timeMs: 999 }))).toEqual({});
    expect(evaluateBehaviour(windowed, ctx({ timeMs: 2000 }))).toEqual({});
    expect(Object.keys(evaluateBehaviour(windowed, ctx({ timeMs: 1500 })))).not.toHaveLength(0);
  });

  it('scales its whole contribution by weight', () => {
    const full = evaluateBehaviour(behaviour('sway'), ctx({ timeMs: 700 }));
    const half = evaluateBehaviour(behaviour('sway', { weight: 0.5 }), ctx({ timeMs: 700 }));
    expect(half.rotation).toBeCloseTo((full.rotation ?? 0) / 2, 12);
  });

  it('a zero weight contributes nothing at all', () => {
    expect(evaluateBehaviour(behaviour('sway', { weight: 0 }), ctx({ timeMs: 700 }))).toEqual({});
  });
});

describe('wind', () => {
  it('varies over time rather than holding a constant', () => {
    const samples = new Set(
      Array.from(
        { length: 40 },
        (_, i) => evaluateBehaviour(behaviour('wind'), ctx({ timeMs: i * 250 })).rotation,
      ),
    );
    expect(samples.size).toBeGreaterThan(30);
  });

  it('is not a clean sine - the gust envelope is what makes it read as weather', () => {
    const gusty = Array.from(
      { length: 200 },
      (_, i) =>
        evaluateBehaviour(behaviour('wind', { gustiness: 1 }), ctx({ timeMs: i * 100 })).rotation ??
        0,
    );
    const steady = Array.from(
      { length: 200 },
      (_, i) =>
        evaluateBehaviour(behaviour('wind', { gustiness: 0 }), ctx({ timeMs: i * 100 })).rotation ??
        0,
    );
    // A pure sine revisits the same peak value; a gusty signal does not.
    const peakSpread = (xs: number[]): number => {
      const peaks = xs.filter(
        (x, i) =>
          i > 0 &&
          i < xs.length - 1 &&
          Math.abs(x) > Math.abs(xs[i - 1] ?? 0) &&
          Math.abs(x) > Math.abs(xs[i + 1] ?? 0),
      );
      return peaks.length === 0
        ? 0
        : Math.max(...peaks.map(Math.abs)) - Math.min(...peaks.map(Math.abs));
    };
    expect(peakSpread(gusty)).toBeGreaterThan(peakSpread(steady));
  });

  it('sends the sway sideways when the direction is 90 degrees', () => {
    const sideways = evaluateBehaviour(behaviour('wind', { direction: 90 }), ctx({ timeMs: 800 }));
    expect(Math.abs(sideways.rotation ?? 0)).toBeLessThan(1e-9);
    expect(Math.abs(sideways['position.x'] ?? 0)).toBeGreaterThan(0);
  });

  it('scales with amplitude and with tip bias', () => {
    const at = (extra: Record<string, unknown>): number =>
      Math.abs(evaluateBehaviour(behaviour('wind', extra), ctx({ timeMs: 800 })).rotation ?? 0);
    expect(at({ amplitude: 0.5 })).toBeGreaterThan(at({ amplitude: 0.1 }));
    expect(at({ tipBias: 1 })).toBeGreaterThan(at({ tipBias: 0.2 }));
  });
});

describe('breathe', () => {
  it('conserves rough volume: x contracts as y expands', () => {
    const deltas = evaluateBehaviour(behaviour('breathe'), ctx({ timeMs: 1000 }));
    expect(Math.sign(deltas['scale.y'] ?? 0)).toBe(-Math.sign(deltas['scale.x'] ?? 0));
  });

  it('is periodic at its own frequency', () => {
    const period = 1000 / 0.25;
    const a = evaluateBehaviour(behaviour('breathe'), ctx({ timeMs: 300 }));
    const b = evaluateBehaviour(behaviour('breathe'), ctx({ timeMs: 300 + period }));
    expect(b['scale.y']).toBeCloseTo(a['scale.y'] ?? 0, 9);
  });
});

describe('blink', () => {
  it('is closed only briefly, and open most of the time', () => {
    let closedSamples = 0;
    const total = 2000;
    for (let i = 0; i < total; i += 1) {
      const deltas = evaluateBehaviour(behaviour('blink'), ctx({ timeMs: i * 10 }));
      if ((deltas['scale.y'] ?? 0) !== 0) closedSamples += 1;
    }
    expect(closedSamples).toBeGreaterThan(0);
    expect(closedSamples / total).toBeLessThan(0.1);
  });

  it('is irregular - a perfectly periodic blink is uncanny', () => {
    const starts: number[] = [];
    let wasClosed = false;
    for (let ms = 0; ms < 60_000; ms += 5) {
      const closed =
        (evaluateBehaviour(behaviour('blink'), ctx({ timeMs: ms }))['scale.y'] ?? 0) !== 0;
      if (closed && !wasClosed) starts.push(ms);
      wasClosed = closed;
    }
    expect(starts.length).toBeGreaterThan(5);
    const gaps = starts.slice(1).map((s, i) => s - (starts[i] ?? 0));
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it('is addressable at any t without simulating the blinks before it', () => {
    // Slot n is derived from n, so a cold seek deep into the clip is exact.
    const b = behaviour('blink');
    expect(evaluateBehaviour(b, ctx({ timeMs: 500_000 }))).toEqual(
      evaluateBehaviour(b, ctx({ timeMs: 500_000 })),
    );
  });
});

describe('walk-cycle', () => {
  it('bounces twice per stride - once per foot', () => {
    const stepMs = 1000 / 1.6;
    const at = (ms: number): number =>
      evaluateBehaviour(behaviour('walk-cycle'), ctx({ timeMs: ms }))['position.y'] ?? 0;
    expect(at(0)).toBeCloseTo(0, 9);
    expect(at(stepMs / 2)).toBeLessThan(0);
    expect(at(stepMs)).toBeCloseTo(0, 9);
  });

  it('carries the body forward at the stride rate', () => {
    const a = evaluateBehaviour(behaviour('walk-cycle'), ctx({ timeMs: 1000 }))['position.x'] ?? 0;
    const b = evaluateBehaviour(behaviour('walk-cycle'), ctx({ timeMs: 2000 }))['position.x'] ?? 0;
    expect(b - a).toBeCloseTo(1.6 * 60, 9);
  });

  it('gives every gait its own posture, and a limp its asymmetry', () => {
    const leans = new Map(
      (['walk', 'run', 'sneak', 'limp', 'march', 'shuffle', 'skip'] as const).map((gait) => [
        gait,
        evaluateBehaviour(behaviour('walk-cycle', { gait }), ctx({ timeMs: 0 })).rotation ?? 0,
      ]),
    );
    expect(new Set(leans.values()).size).toBeGreaterThan(5);

    // A limp is a gait, not a bug: the two halves of the stride differ.
    const stepMs = 1000 / 1.6;
    const first =
      evaluateBehaviour(behaviour('walk-cycle', { gait: 'limp' }), ctx({ timeMs: stepMs * 0.5 }))
        .rotation ?? 0;
    const second =
      evaluateBehaviour(behaviour('walk-cycle', { gait: 'limp' }), ctx({ timeMs: stepMs * 1.5 }))
        .rotation ?? 0;
    expect(first).not.toBeCloseTo(second, 6);
  });
});

describe('flap', () => {
  it('is asymmetric - the downstroke is faster than the recovery', () => {
    // Symmetric flapping is a pair of scissors, not a bird.
    const period = 1000 / 4;
    const samples = Array.from({ length: 200 }, (_, i) => {
      const ms = (i / 200) * period;
      return { ms, value: evaluateBehaviour(behaviour('flap'), ctx({ timeMs: ms })).rotation ?? 0 };
    });
    const peakAt = samples.reduce((best, s) => (s.value > best.value ? s : best), samples[0]!);
    const troughAt = samples.reduce((worst, s) => (s.value < worst.value ? s : worst), samples[0]!);
    const rise = peakAt.ms;
    const fall = Math.abs(troughAt.ms - peakAt.ms);
    expect(Math.abs(rise - fall)).toBeGreaterThan(period * 0.05);
  });

  it('mirrors on a negative amplitude, which is how a pair of wings is one behaviour', () => {
    // The far wing of a bird rotates the opposite way, and the cheapest way to say that
    // is the same behaviour with the sign flipped. `AnimationIR` used to require a
    // non-negative angle here, which made the mirrored half unrepresentable - and the one
    // scene in the repo that actually flaps was writing -46 and never being validated
    // against the schema, so nothing noticed until it was posted to a store.
    for (let ms = 0; ms < 1000; ms += 13) {
      const near = evaluateBehaviour(behaviour('flap', { amplitudeDeg: 46 }), ctx({ timeMs: ms }));
      const far = evaluateBehaviour(behaviour('flap', { amplitudeDeg: -46 }), ctx({ timeMs: ms }));
      expect(far.rotation ?? 0).toBeCloseTo(-(near.rotation ?? 0), 9);
    }
  });

  it('stays within its amplitude', () => {
    for (let ms = 0; ms < 2000; ms += 7) {
      const value = evaluateBehaviour(behaviour('flap'), ctx({ timeMs: ms })).rotation ?? 0;
      expect(Math.abs(value)).toBeLessThanOrEqual(50 + 1e-9);
    }
  });
});

describe('orbit', () => {
  it('traces an ellipse of the requested radii', () => {
    const b = behaviour('orbit', { centre: { x: 100, y: 50 }, radius: { x: 20, y: 10 } });
    for (let ms = 0; ms < 4000; ms += 61) {
      const d = evaluateBehaviour(b, ctx({ timeMs: ms }));
      const nx = ((d['position.x'] ?? 0) - 100) / 20;
      const ny = ((d['position.y'] ?? 0) - 50) / 10;
      expect(nx * nx + ny * ny).toBeCloseTo(1, 9);
    }
  });

  it('completes exactly one revolution per period', () => {
    const b = behaviour('orbit');
    expect(evaluateBehaviour(b, ctx({ timeMs: 4000 }))).toEqual(
      evaluateBehaviour(b, ctx({ timeMs: 0 })),
    );
  });
});

describe('walk cycle', () => {
  function riseAt(strideLength: number, timeMs: number): number {
    const deltas = evaluateBehaviour(
      behaviour('walk-cycle', { strideLength, bounce: 0.5, stepsPerSecond: 2 }),
      ctx({ timeMs }),
    );
    return -(deltas['position.y'] ?? 0);
  }

  it('rises by a fraction of the stride, so a bigger character does not crouch', () => {
    // It used to rise by a literal eight pixels at full amplitude, on every rig. A
    // character twice the size then bounced the same absolute distance - which reads as
    // a crouch - and retargeting could not fix it, because `bounce` is a `Unit01` weight
    // with nothing to scale. `strideLength` is the one real distance here and the one
    // retargeting already rescales.
    expect(riseAt(120, 125)).toBeCloseTo(riseAt(60, 125) * 2, 9);
    expect(riseAt(30, 125)).toBeCloseTo(riseAt(60, 125) / 2, 9);
  });

  it('never pushes the body downwards, so the feet cannot be driven through the floor', () => {
    for (let timeMs = 0; timeMs <= 2000; timeMs += 17) {
      expect(riseAt(60, timeMs), `t=${String(timeMs)}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('carries the body forward at the stride it was given', () => {
    const deltas = evaluateBehaviour(
      behaviour('walk-cycle', { strideLength: 60, stepsPerSecond: 2 }),
      ctx({ timeMs: 1000 }),
    );
    expect(deltas['position.x']).toBeCloseTo(120, 9);
  });
});

describe('parallax', () => {
  it('leaves the camera plane alone and lags what is behind it', () => {
    const camera = { position: { x: 100, y: 0 }, zoom: 1 };
    const near = evaluateBehaviour(behaviour('parallax'), ctx({ depth: 0, camera }));
    const far = evaluateBehaviour(behaviour('parallax'), ctx({ depth: 100, camera }));
    expect(near['position.x']).toBeCloseTo(0, 9);
    expect(Math.abs(far['position.x'] ?? 0)).toBeGreaterThan(0);
  });

  it('pushes a layer *with* the camera, so the camera transform cancels part of the pan', () => {
    // The sign, asserted rather than absolute-valued. The delta is defined against a
    // camera transform that has already subtracted the camera position, so pushing the
    // layer the same way is what makes the composed displacement smaller than the pan.
    // Negating it subtracts twice and inverts depth - see `parallax-composition.spec.ts`,
    // which measures the thing a viewer actually sees.
    const camera = { position: { x: 100, y: -60 }, zoom: 1 };
    const far = evaluateBehaviour(behaviour('parallax'), ctx({ depth: 100, camera }));
    expect(far['position.x'] ?? 0).toBeGreaterThan(0);
    expect(far['position.y'] ?? 0).toBeLessThan(0);
  });

  it('lags more the further back a layer sits, on every curve', () => {
    for (const curve of ['linear', 'exponential', 'logarithmic'] as const) {
      expect(parallaxFactor(80, curve)).toBeGreaterThan(parallaxFactor(20, curve));
      expect(parallaxFactor(0, curve)).toBeCloseTo(0, 9);
    }
  });

  it('reads depth as a signed distance, so a layer in front of the plane over-travels', () => {
    // This used to clamp to 0, and the clamp was the bug. Something between the camera
    // and the focal plane genuinely sweeps faster than the plane - a fence post at the
    // roadside against the field behind it - and `ParallaxDepth` in `story/shot.ts` has
    // always promised it ("below 1 is nearer and over-travels"). With the clamp there was
    // no depth that could express it, so the promise was unkeepable.
    expect(parallaxFactor(-50, 'linear')).toBe(-0.5);
    expect(parallaxFactor(-100, 'linear')).toBe(-1);
    expect(parallaxFactor(50, 'linear')).toBe(0.5);
  });

  it('is odd about the camera plane, inside the far plane where no clamp applies', () => {
    // Mirroring a layer through the camera plane mirrors its travel. Only asserted inside
    // the far plane, because the saturation beyond it is deliberately one-sided and would
    // break the symmetry there - which is the point of the next test.
    for (const curve of ['linear', 'exponential', 'logarithmic'] as const) {
      for (const depth of [1, 10, 40, 99]) {
        expect(parallaxFactor(-depth, curve), `${curve}@${String(depth)}`).toBeCloseTo(
          -parallaxFactor(depth, curve),
          12,
        );
      }
    }
  });

  it('saturates behind the plane and not in front of it', () => {
    // One-sided on purpose. Behind the far plane a layer is pinned to the camera and must
    // not start travelling backwards, so the fall-off caps at 1. In front there is nothing
    // to cap - the nearer a thing is the faster it sweeps - and capping there is what made
    // `ParallaxDepth < 1` unrepresentable.
    expect(parallaxFactor(1000, 'linear')).toBe(1);
    expect(parallaxFactor(1000, 'logarithmic')).toBe(1);
    expect(parallaxFactor(-1000, 'linear')).toBe(-10);
    expect(parallaxFactor(-9900, 'linear')).toBe(-99);
  });

  it('pushes a near layer against the camera, so it outruns the pan on screen', () => {
    const camera = { position: { x: 100, y: 0 }, zoom: 1 };
    const near = evaluateBehaviour(behaviour('parallax'), ctx({ depth: -100, camera }));
    // Negative delta, so `world - camera` grows past the pan rather than shrinking below it.
    expect(near['position.x'] ?? 0).toBeLessThan(0);
  });
});

describe('spring and boil', () => {
  it('a spring settles rather than ringing forever', () => {
    const early = Math.abs(
      evaluateBehaviour(behaviour('spring'), ctx({ timeMs: 100 }))['position.x'] ?? 0,
    );
    const late = Math.abs(
      evaluateBehaviour(behaviour('spring'), ctx({ timeMs: 5000 }))['position.x'] ?? 0,
    );
    expect(late).toBeLessThan(early);
  });

  it('a spring drives whichever channel it follows', () => {
    const deltas = evaluateBehaviour(
      behaviour('spring', { follows: 'rotation' }),
      ctx({ timeMs: 50 }),
    );
    expect(deltas.rotation).toBeDefined();
    expect(deltas['position.x']).toBeUndefined();
  });

  it('boil holds each jitter for a whole redraw tick rather than sliding', () => {
    // 8 Hz means a new drawing every 125 ms; within one tick nothing moves.
    const b = behaviour('boil');
    const a = evaluateBehaviour(b, ctx({ timeMs: 10 }));
    const stillSameTick = evaluateBehaviour(b, ctx({ timeMs: 100 }));
    const nextTick = evaluateBehaviour(b, ctx({ timeMs: 130 }));
    expect(stillSameTick).toEqual(a);
    expect(nextTick).not.toEqual(a);
  });
});

describe('lip-sync', () => {
  it('reports the index of the active viseme, with an envelope', () => {
    const b = behaviour('lip-sync', {
      phonemes: [
        { timeMs: 0, viseme: 'aa', durationMs: 100 },
        { timeMs: 100, viseme: 'oh', durationMs: 100 },
      ],
    });
    expect(evaluateBehaviour(b, ctx({ timeMs: 50 }))['text.reveal']).toBe(0);
    expect(evaluateBehaviour(b, ctx({ timeMs: 150 }))['text.reveal']).toBe(1);
  });

  it('closes the mouth between and after phonemes', () => {
    const b = behaviour('lip-sync', {
      phonemes: [{ timeMs: 0, viseme: 'aa', durationMs: 100 }],
    });
    expect(evaluateBehaviour(b, ctx({ timeMs: 500 }))['fx.intensity']).toBe(0);
    expect(evaluateBehaviour(b, ctx({ timeMs: 500 }))['text.reveal']).toBeUndefined();
  });

  it('opens and closes within a phoneme rather than popping', () => {
    const b = behaviour('lip-sync');
    const edge = evaluateBehaviour(b, ctx({ timeMs: 1 }))['fx.intensity'] ?? 0;
    const middle = evaluateBehaviour(b, ctx({ timeMs: 100 }))['fx.intensity'] ?? 0;
    expect(middle).toBeGreaterThan(edge);
  });
});

describe('deferred behaviours', () => {
  it('contribute nothing in this pass - they need other nodes resolved first', () => {
    expect(evaluateBehaviour(behaviour('look-at'), ctx({ timeMs: 100 }))).toEqual({});
    expect(evaluateBehaviour(behaviour('follow-path'), ctx({ timeMs: 100 }))).toEqual({});
  });
});
