/**
 * Procedural behaviours - where the cost of animation goes to zero.
 *
 * A forest of forty swaying trees is forty `wind` behaviours with different seeds, not
 * forty hand-animated tracks and certainly not forty generated video clips. Each one is
 * a **pure function of `(behaviour, context)`** where the context's only time input is
 * `timeMs`, so the whole system stays seek-safe: t=4.2s gives the same answer whether
 * you scrubbed there, played there, or resumed a sharded render there.
 *
 * Dispatch is a registry keyed by `kind`, not a `switch`, so adding a behaviour is
 * adding an entry (CLAUDE.md §2). `assertNever` in `evaluateBehaviour` keeps the union
 * exhaustive at compile time.
 */

import { assertNever, type Rng } from '@rv/shared-kernel';
import { DEPTH_FAR_PLANE, type AnimChannel, type Behaviour, type Vec2 } from '@rv/contracts';

import { fractalNoise1d, noise1d, signedNoise1d } from './noise';

/** Channel offsets a behaviour contributes. Absent means "no opinion". */
export type ChannelDeltas = Partial<Record<AnimChannel, number>>;

export interface BehaviourContext {
  readonly timeMs: number;
  /** The node's own depth, for parallax. */
  readonly depth: number;
  readonly camera: { readonly position: Vec2; readonly zoom: number };
  /** Deterministic generator, forked from the IR seed and the node id. */
  readonly rng: Rng;
}

const MS_PER_SECOND = 1000;

/** Whether the behaviour is active at this instant, and how strongly. */
export function behaviourWeight(behaviour: Behaviour, timeMs: number): number {
  if (!behaviour.enabled) return 0;
  if (behaviour.startMs !== undefined && timeMs < behaviour.startMs) return 0;
  if (behaviour.endMs !== undefined && timeMs >= behaviour.endMs) return 0;
  return behaviour.weight;
}

// ── individual behaviours ───────────────────────────────────────────────────

function wind(b: Extract<Behaviour, { kind: 'wind' }>, ctx: BehaviourContext): ChannelDeltas {
  const seconds = ctx.timeMs / MS_PER_SECOND;
  // A steady carrier plus a slower gust envelope. Wind that is one clean sine reads as
  // a metronome; the envelope is what makes it read as weather.
  const carrier = Math.sin(seconds * b.hz * Math.PI * 2);
  const gust = fractalNoise1d(b.seed, seconds * b.hz * 0.35) * b.gustiness;
  const magnitude = (carrier * (1 - b.gustiness) + gust) * b.amplitude * 30 * b.tipBias;

  const radians = (b.direction * Math.PI) / 180;
  return {
    rotation: magnitude * Math.cos(radians),
    'position.x': magnitude * Math.sin(radians) * 0.4,
  };
}

function breathe(b: Extract<Behaviour, { kind: 'breathe' }>, ctx: BehaviourContext): ChannelDeltas {
  const phase = Math.sin((ctx.timeMs / MS_PER_SECOND) * b.hz * Math.PI * 2);
  // Chest expands more than it lifts, and volume is roughly conserved, so x contracts
  // as y expands. Scaling both the same way reads as a balloon.
  return { 'scale.y': phase * b.amplitude * 0.06, 'scale.x': -phase * b.amplitude * 0.02 };
}

/**
 * Blink.
 *
 * The schedule has to be irregular - a perfectly periodic blink is uncanny - but also
 * addressable at any `t` without simulating the ones before it. So each blink slot is
 * derived from its own index: slot `n` starts at `n * interval + noise(n) * variance`.
 */
function blink(b: Extract<Behaviour, { kind: 'blink' }>, ctx: BehaviourContext): ChannelDeltas {
  const slot = Math.floor(ctx.timeMs / b.intervalMs);
  // Three slots, not one. Jitter can move a blink up to `varianceMs` in either
  // direction, so slot n's blink may begin inside slot n-1 or run into slot n+1.
  // Checking only the current slot silently drops roughly half of them.
  for (const index of [slot + 1, slot, slot - 1]) {
    if (index < 0) continue;
    const jitter = signedNoise1d(b.seed, index * 7.13) * b.varianceMs;
    const startMs = index * b.intervalMs + jitter;
    const progress = (ctx.timeMs - startMs) / b.closeDurationMs;
    if (progress >= 0 && progress <= 1) {
      // Down then up: a triangle, not a sine - eyelids snap shut and open slower.
      const closed = progress < 0.4 ? progress / 0.4 : 1 - (progress - 0.4) / 0.6;
      return { 'scale.y': -closed };
    }
  }
  return {};
}

function sway(b: Extract<Behaviour, { kind: 'sway' }>, ctx: BehaviourContext): ChannelDeltas {
  const phase = Math.sin((ctx.timeMs / MS_PER_SECOND) * b.hz * Math.PI * 2 + b.seed * 0.001);
  return { [b.axis]: phase * b.amplitudeDeg };
}

/**
 * Walk cycle.
 *
 * Emits the *body* motion only - the vertical bounce and the forward carry. Limb
 * rotation comes from the rig's own clip; this is the part that must stay in phase with
 * the ground, and it is where a mismatched stride shows up as sliding feet.
 *
 * ## The bounce is a fraction of the stride, not a number of pixels
 *
 * It used to be `bounce * 8` - eight literal pixels at full amplitude, on every rig. So
 * a character twice the size bounced the same absolute distance and read as crouching,
 * and there was nothing retargeting could do about it: `bounce` is a `Unit01` weight, so
 * scaling it is both out of range and meaningless.
 *
 * `strideLength` is the one real distance the behaviour carries and the one retargeting
 * already rescales, so expressing the rise as a fraction of it makes the whole behaviour
 * proportional for free - and ties the two halves of a gait together, which is how they
 * work: a longer stride is a bigger rise, because the body is vaulting over a straighter
 * leg. {@link BOUNCE_PER_STRIDE} is the constant of proportionality at full amplitude.
 */
function walkCycle(
  b: Extract<Behaviour, { kind: 'walk-cycle' }>,
  ctx: BehaviourContext,
): ChannelDeltas {
  const seconds = ctx.timeMs / MS_PER_SECOND;
  const stepPhase = seconds * b.stepsPerSecond;

  // The body rises twice per stride - once per foot - so the bounce is at 2x.
  const bounce =
    Math.abs(Math.sin(stepPhase * Math.PI)) * b.bounce * b.strideLength * BOUNCE_PER_STRIDE;
  const lean = GAIT_LEAN[b.gait];
  // A limp is a gait, not a bug: asymmetry between the two halves of the stride.
  // Period 2 in stride phase, and antisymmetric: one leg carries more than the other.
  // At PI/2 the two half-strides evaluate identically, which is a symmetric limp -
  // that is to say, not a limp.
  const limpBias = b.gait === 'limp' ? Math.sin(stepPhase * Math.PI) * 3 : 0;

  return {
    'position.y': -bounce,
    'position.x': stepPhase * b.strideLength,
    rotation: lean + limpBias,
  };
}

/**
 * Vertical rise at `bounce: 1`, as a fraction of the stride.
 *
 * 15 % is the stylised end of the range - a real human's centre of mass rises around 3 %
 * of a stride - because `bounce` is an animation knob and 1 should mean "as bouncy as
 * this system goes", not "as bouncy as a person".
 */
const BOUNCE_PER_STRIDE = 0.15;

const GAIT_LEAN: Readonly<Record<Extract<Behaviour, { kind: 'walk-cycle' }>['gait'], number>> = {
  walk: 0,
  run: -8,
  sneak: 6,
  limp: 2,
  march: -2,
  shuffle: 4,
  skip: -3,
};

/**
 * Wing flap.
 *
 * The downstroke is faster than the recovery. That asymmetry is the entire difference
 * between a bird and a pair of scissors, so `downstrokeBias` reshapes the phase rather
 * than scaling a symmetric sine.
 */
function flap(b: Extract<Behaviour, { kind: 'flap' }>, ctx: BehaviourContext): ChannelDeltas {
  const cycle = ((ctx.timeMs / MS_PER_SECOND) * b.hz) % 1;
  const down = b.downstrokeBias;
  const reshaped = cycle < down ? (cycle / down) * 0.5 : 0.5 + ((cycle - down) / (1 - down)) * 0.5;
  return { rotation: Math.sin(reshaped * Math.PI * 2) * b.amplitudeDeg };
}

function orbit(b: Extract<Behaviour, { kind: 'orbit' }>, ctx: BehaviourContext): ChannelDeltas {
  const angle = ((ctx.timeMs / b.periodMs + b.phase) % 1) * Math.PI * 2;
  return {
    'position.x': b.centre.x + Math.cos(angle) * b.radius.x,
    'position.y': b.centre.y + Math.sin(angle) * b.radius.y,
  };
}

/**
 * Parallax.
 *
 * Reads the node's own depth and the camera, so a foreground element can opt out simply
 * by not carrying the behaviour - which is what a UI overlay must do.
 *
 * ## The sign, which was wrong
 *
 * The delta is **positive**: the layer is pushed *with* the camera, not against it. That
 * reads backwards until you remember that the camera transform has already subtracted
 * the camera position downstream (`cameraMatrix` in `@rv/render-engine`), so the screen
 * displacement of a layer is
 *
 *     screen = (world + delta) - camera = -pan * (1 - factor)
 *
 * A far layer therefore moves *less* than the camera plane, which is what parallax is.
 * Negating here subtracted the pan twice and gave `-pan * (1 + factor)`: on a 400 px pan
 * the far plane swept 746 px while the camera plane swept 400, so the sky raced past the
 * foreground at 1.86x - depth inverted, at speed.
 *
 * It survived because the only tests were on the delta in isolation, where the sign is
 * unobservable: `Math.abs` on one value, and `parallaxFactor` monotonicity, neither of
 * which composes the delta with the camera it is defined against. `parallax-composition.spec.ts`
 * asserts the composed screen displacement instead, which is the number a viewer sees.
 */
function parallax(
  b: Extract<Behaviour, { kind: 'parallax' }>,
  ctx: BehaviourContext,
): ChannelDeltas {
  const factor = parallaxFactor(ctx.depth, b.curve) * b.strength;
  return {
    'position.x': ctx.camera.position.x * factor,
    'position.y': ctx.camera.position.y * factor,
  };
}

/**
 * How much of the camera's pan a layer at `depth` absorbs.
 *
 * **Depth is a signed distance from the camera plane.** 0 is the plane itself and moves
 * with the camera exactly; positive is behind it and lags; **negative is in front of it
 * and over-travels**, which is what something between the camera and the focal plane
 * genuinely does - a fence post at the roadside sweeps past faster than the field behind
 * it. That is not an edge case, it is a cinematic effect a director asks for by name.
 *
 * It used to be `Math.max(0, depth)`, which clamped the whole near half to the camera
 * plane. The clamp was the bug, not the negative: it made `ParallaxDepth < 1` -
 * documented in `story/shot.ts` as "nearer and over-travels" - impossible to represent
 * in an IR at all, so a shot compiler would have had to drop it silently or invent a
 * mapping. A signed distance is also the more honest shape: it says "in front" and
 * "behind" instead of pretending the camera sits at the near limit of the world.
 *
 * The saturation is deliberately **one-sided**. Behind the plane the fall-off is capped
 * at 1, because a layer at or past the far plane is pinned to the camera and must not
 * come back the other way. In front of it there is no limit to cap: the nearer a thing
 * is, the faster it sweeps, without bound, and capping there is exactly what made the
 * conversion lossy. See `irDepthFor` in `story/shot.ts` for the mapping this admits.
 */
function parallaxFactor(
  depth: number,
  curve: Extract<Behaviour, { kind: 'parallax' }>['curve'],
): number {
  // The far plane is `DEPTH_FAR_PLANE` from `@rv/contracts` rather than a local literal:
  // 2.5D layer separation places layers on the same scale, and one definition of "far"
  // beats two that happen to agree today.
  const normalised = depth / DEPTH_FAR_PLANE;
  const magnitude = fallOff(Math.abs(normalised), curve);
  return normalised < 0 ? -magnitude : Math.min(1, magnitude);
}

/** The shape of the fall-off, over a non-negative normalised distance. */
function fallOff(
  normalised: number,
  curve: Extract<Behaviour, { kind: 'parallax' }>['curve'],
): number {
  switch (curve) {
    case 'linear':
      return normalised;
    case 'exponential':
      return 1 - Math.exp(-normalised * 2);
    case 'logarithmic':
      return Math.log1p(normalised * 9) / Math.log(10);
  }
}

/** The low-amplitude jitter of a redrawn line. Noise, not a sine - a sine is a wobble. */
function boil(b: Extract<Behaviour, { kind: 'boil' }>, ctx: BehaviourContext): ChannelDeltas {
  const tick = Math.floor((ctx.timeMs / MS_PER_SECOND) * b.hz);
  return {
    'position.x': signedNoise1d(b.seed, tick) * b.amplitude * 2,
    'position.y': signedNoise1d(b.seed + 1, tick) * b.amplitude * 2,
    rotation: signedNoise1d(b.seed + 2, tick) * b.amplitude * 1.5,
  };
}

/**
 * Spring.
 *
 * A real spring integrates over its own history, which a seek-safe evaluator cannot do:
 * arriving at t=4.2s by scrubbing has no history to integrate. So this is the
 * **analytic** response of a damped oscillator to a step - exact for the impulse case,
 * an approximation for arbitrary driving input, and identical at every t regardless of
 * how it was reached. Determinism is worth more here than the last few percent of
 * physical fidelity.
 */
function spring(b: Extract<Behaviour, { kind: 'spring' }>, ctx: BehaviourContext): ChannelDeltas {
  const seconds = ctx.timeMs / MS_PER_SECOND;
  const omega = 2 + b.stiffness * 20;
  const zeta = 0.1 + b.damping * 0.9;
  const decay = Math.exp(-zeta * omega * seconds);
  const damped = omega * Math.sqrt(Math.max(0, 1 - zeta * zeta));
  const displacement = decay * Math.cos(damped * seconds);
  return { [b.follows]: displacement * 4 };
}

/**
 * Lip sync.
 *
 * Emits a viseme index rather than a mouth shape: the rig owns which drawing each
 * viseme maps to, so the same phoneme track drives a paper-cutout mouth and a painted
 * one without change.
 */
function lipSync(
  b: Extract<Behaviour, { kind: 'lip-sync' }>,
  ctx: BehaviourContext,
): ChannelDeltas {
  for (const [index, phoneme] of b.phonemes.entries()) {
    const end = phoneme.timeMs + phoneme.durationMs;
    if (ctx.timeMs >= phoneme.timeMs && ctx.timeMs < end) {
      // Open on entry, close on exit, so consecutive visemes do not pop.
      const progress = (ctx.timeMs - phoneme.timeMs) / phoneme.durationMs;
      const envelope = Math.sin(progress * Math.PI);
      return { 'text.reveal': index, 'fx.intensity': envelope * b.intensity };
    }
  }
  return { 'fx.intensity': 0 };
}

/**
 * Look-at and follow-path both need information this pass does not have - the target
 * node's resolved world position, and a sampled path. They are resolved in a second
 * pass in `evaluate`, after every node has a world transform.
 */
const DEFERRED: ChannelDeltas = {};

// ── dispatch ────────────────────────────────────────────────────────────────

/**
 * Evaluates one behaviour.
 *
 * `assertNever` in the default keeps the union exhaustive: adding a behaviour kind to
 * the contract without implementing it here is a compile error, not a silent no-op.
 */
export function evaluateBehaviour(behaviour: Behaviour, ctx: BehaviourContext): ChannelDeltas {
  const weight = behaviourWeight(behaviour, ctx.timeMs);
  if (weight === 0) return {};

  const raw = dispatch(behaviour, ctx);
  if (weight === 1) return raw;

  const scaled: ChannelDeltas = {};
  for (const [channel, value] of Object.entries(raw)) {
    scaled[channel as AnimChannel] = value * weight;
  }
  return scaled;
}

function dispatch(behaviour: Behaviour, ctx: BehaviourContext): ChannelDeltas {
  switch (behaviour.kind) {
    case 'wind':
      return wind(behaviour, ctx);
    case 'breathe':
      return breathe(behaviour, ctx);
    case 'blink':
      return blink(behaviour, ctx);
    case 'sway':
      return sway(behaviour, ctx);
    case 'walk-cycle':
      return walkCycle(behaviour, ctx);
    case 'flap':
      return flap(behaviour, ctx);
    case 'orbit':
      return orbit(behaviour, ctx);
    case 'parallax':
      return parallax(behaviour, ctx);
    case 'boil':
      return boil(behaviour, ctx);
    case 'spring':
      return spring(behaviour, ctx);
    case 'look-at':
    case 'follow-path':
      return DEFERRED;
    case 'lip-sync':
      return lipSync(behaviour, ctx);
    default:
      return assertNever(behaviour, 'behaviour kind');
  }
}

/** Exposed for the noise tests and for tuning tools. */
export { noise1d, signedNoise1d, fractalNoise1d, parallaxFactor };
