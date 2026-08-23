/**
 * What each clip name *is*, mechanically.
 *
 * Fifty-odd clip names across twenty archetypes, and writing fifty bespoke builders
 * would mean fifty places for the style's motion block to be read slightly
 * differently - which is the exact failure the style bible exists to prevent. So a
 * clip name resolves to a **family** plus a few numbers, and there are seven families.
 *
 * The families are chosen by what the motion *is made of*, because that is what
 * decides which half of `MotionStyle` parameterises it: an ambient clip is driven by
 * `motion.ambient`, an impulse by `motion.principles` (anticipation, overshoot,
 * follow-through), a locomotion cycle by both plus the character's own
 * `MotionSignature`.
 */

import type { LoopMode } from '@rv/contracts';

export type ClipFamily =
  /** Always-on life: wind, breath, boil. Nothing is ever perfectly still. */
  | 'ambient'
  /** A periodic driven motion on named bones: flap, ripple, slither. */
  | 'oscillate'
  /** A gait: the body advances and the limbs counter-phase. */
  | 'locomotion'
  /** A one-shot action with anticipation and overshoot: react, strike, brake. */
  | 'impulse'
  /** A constrained rotation between two states: open, close. */
  | 'hinge'
  /** Continuous rotation: wheels. */
  | 'spin'
  /** Intensity ramps for effects and UI: emit, burst, fade, enter, exit. */
  | 'emit';

/** Which bones a clip drives. Resolved against the rig's roles, never hard-coded ids. */
export type TargetKind =
  'root' | 'all' | 'deformable' | 'limbs' | 'wings' | 'wheels' | 'panel' | 'head';

export interface ClipKind {
  readonly family: ClipFamily;
  /** Scales every amplitude the family computes. 1 is the family's natural level. */
  readonly intensity: number;
  /** Cycles inside one clip, for periodic families. Sets the duration with the tempo. */
  readonly cycles: number;
  readonly loop: LoopMode;
  readonly targets: TargetKind;
  /** Base length before the style's tempo scales it. */
  readonly baseDurationMs: number;
  /**
   * Opacity/scale multipliers the `emit` family interpolates through.
   *
   * Values are multipliers of the authored pose: 0 is gone, 1 is as drawn, 1.8 is a
   * flare. Data rather than a per-name branch, because "burst goes up then settles" is
   * the only thing that distinguishes `burst` from `fade`.
   */
  readonly ramp?: readonly number[];
}

const AMBIENT: ClipKind = {
  family: 'ambient',
  intensity: 1,
  cycles: 2,
  loop: 'loop',
  targets: 'deformable',
  baseDurationMs: 4000,
};

function oscillate(overrides: Partial<ClipKind> = {}): ClipKind {
  return {
    family: 'oscillate',
    intensity: 1,
    cycles: 4,
    loop: 'loop',
    targets: 'deformable',
    baseDurationMs: 2000,
    ...overrides,
  };
}

function locomotion(overrides: Partial<ClipKind> = {}): ClipKind {
  return {
    family: 'locomotion',
    intensity: 1,
    cycles: 2,
    loop: 'loop',
    targets: 'limbs',
    baseDurationMs: 1200,
    ...overrides,
  };
}

function impulse(overrides: Partial<ClipKind> = {}): ClipKind {
  return {
    family: 'impulse',
    intensity: 1,
    cycles: 1,
    loop: 'once',
    targets: 'root',
    baseDurationMs: 700,
    ...overrides,
  };
}

function emit(overrides: Partial<ClipKind> = {}): ClipKind {
  return {
    family: 'emit',
    intensity: 1,
    cycles: 1,
    loop: 'loop',
    targets: 'all',
    baseDurationMs: 2400,
    ramp: [0.9, 1.1, 0.9],
    ...overrides,
  };
}

/**
 * Every clip name any template can ask for.
 *
 * A lookup rather than a `switch`, and deliberately exhaustive over the names in
 * `rig/templates`: `derive-clips` asserts that every template clip name has an entry,
 * so adding a clip to a template without saying what it is fails a test rather than
 * silently producing an empty animation.
 */
export const CLIP_KINDS: Readonly<Record<string, ClipKind>> = {
  // ambient
  idle: AMBIENT,
  sway: { ...AMBIENT, cycles: 2, baseDurationMs: 5000 },
  drift: { ...AMBIENT, intensity: 0.7, baseDurationMs: 7000, targets: 'all' },
  murmur: { ...AMBIENT, intensity: 0.5, targets: 'all' },
  'parallax-drift': { ...AMBIENT, intensity: 0.35, baseDurationMs: 9000, targets: 'all' },
  flicker: { ...AMBIENT, intensity: 1.4, cycles: 8, baseDurationMs: 1200, targets: 'all' },
  lap: { ...AMBIENT, intensity: 0.8, cycles: 3, baseDurationMs: 4200, targets: 'all' },
  ripple: oscillate({ cycles: 3, baseDurationMs: 2600, intensity: 0.8 }),

  // oscillate
  flap: oscillate({ targets: 'wings', cycles: 4, baseDurationMs: 1000, intensity: 1.3 }),
  glide: oscillate({ targets: 'wings', cycles: 1, baseDurationMs: 3600, intensity: 0.3 }),
  hop: oscillate({ targets: 'limbs', cycles: 2, baseDurationMs: 900, intensity: 0.9 }),
  slither: oscillate({ targets: 'all', cycles: 2, baseDurationMs: 2200, intensity: 1.1 }),
  coil: oscillate({
    targets: 'all',
    cycles: 1,
    baseDurationMs: 2600,
    intensity: 0.6,
    loop: 'ping-pong',
  }),
  scuttle: oscillate({ targets: 'limbs', cycles: 6, baseDurationMs: 1100, intensity: 1.2 }),
  billow: oscillate({ targets: 'deformable', cycles: 2, baseDurationMs: 3400, intensity: 1.2 }),
  articulate: oscillate({
    targets: 'all',
    cycles: 1,
    baseDurationMs: 2000,
    intensity: 0.7,
    loop: 'ping-pong',
  }),
  bob: oscillate({ targets: 'root', cycles: 2, baseDurationMs: 2400, intensity: 0.5 }),
  bounce: oscillate({ targets: 'root', cycles: 3, baseDurationMs: 1400, intensity: 0.9 }),
  pulse: oscillate({ targets: 'all', cycles: 2, baseDurationMs: 1600, intensity: 0.6 }),
  talk: oscillate({ targets: 'head', cycles: 4, baseDurationMs: 2000, intensity: 0.5 }),
  gesture: oscillate({ targets: 'limbs', cycles: 2, baseDurationMs: 2200, intensity: 0.8 }),
  graze: oscillate({ targets: 'head', cycles: 1, baseDurationMs: 3600, intensity: 0.7 }),
  'wind-gust': oscillate({
    targets: 'deformable',
    cycles: 2,
    baseDurationMs: 2800,
    intensity: 1.6,
    loop: 'once',
  }),
  storm: oscillate({ targets: 'deformable', cycles: 6, baseDurationMs: 4000, intensity: 2.2 }),
  trample: oscillate({
    targets: 'deformable',
    cycles: 2,
    baseDurationMs: 1400,
    intensity: 1.8,
    loop: 'once',
  }),

  // locomotion
  walk: locomotion(),
  run: locomotion({ cycles: 3, baseDurationMs: 800, intensity: 1.5 }),
  trot: locomotion({ cycles: 2, baseDurationMs: 900, intensity: 1.2 }),
  roll: {
    family: 'spin',
    intensity: 1,
    cycles: 1,
    loop: 'loop',
    targets: 'wheels',
    baseDurationMs: 1200,
  },

  // impulse
  react: impulse(),
  turn: impulse({ baseDurationMs: 600, targets: 'root' }),
  alert: impulse({ baseDurationMs: 500, targets: 'head' }),
  strike: impulse({ baseDurationMs: 450, targets: 'head', intensity: 1.6 }),
  rear: impulse({ baseDurationMs: 900, targets: 'root', intensity: 1.4 }),
  grasp: impulse({ baseDurationMs: 700, targets: 'limbs' }),
  'take-off': impulse({ baseDurationMs: 900, targets: 'wings', intensity: 1.5 }),
  land: impulse({ baseDurationMs: 800, targets: 'wings' }),
  'hit-react': impulse({ baseDurationMs: 450, intensity: 1.4 }),
  brake: impulse({ baseDurationMs: 700, targets: 'root', intensity: 1.2 }),
  slam: impulse({ baseDurationMs: 400, targets: 'panel', intensity: 1.8 }),
  surge: impulse({ baseDurationMs: 1200, targets: 'all', intensity: 1.3 }),
  settle: impulse({ baseDurationMs: 1600, targets: 'deformable', intensity: 0.5 }),
  extend: impulse({ baseDurationMs: 1200, targets: 'all', intensity: 0.9 }),
  retract: impulse({ baseDurationMs: 1200, targets: 'all', intensity: 0.9 }),
  gutter: impulse({ baseDurationMs: 1800, targets: 'all', intensity: 0.8 }),

  // hinge
  open: {
    family: 'hinge',
    intensity: 1,
    cycles: 1,
    loop: 'hold-last',
    targets: 'panel',
    baseDurationMs: 900,
  },
  close: {
    family: 'hinge',
    intensity: -1,
    cycles: 1,
    loop: 'hold-last',
    targets: 'panel',
    baseDurationMs: 800,
  },

  // emit
  emit: emit(),
  burst: emit({ loop: 'once', baseDurationMs: 900, intensity: 1.8, ramp: [0, 1.6, 0.9] }),
  fade: emit({ loop: 'hold-last', baseDurationMs: 1600, intensity: 0.4, ramp: [1, 0] }),
  dissipate: emit({ loop: 'hold-last', baseDurationMs: 3000, intensity: 0.5, ramp: [1, 0.6, 0] }),
  flare: emit({ loop: 'once', baseDurationMs: 1100, intensity: 1.7, ramp: [0.6, 1.8, 1] }),
  enter: emit({ loop: 'hold-last', baseDurationMs: 700, intensity: 1.2, ramp: [0, 1] }),
  exit: emit({ loop: 'hold-last', baseDurationMs: 700, intensity: 1.2, ramp: [1, 0] }),
};

/** Roles a target kind selects, matched on the template's role names. */
export const TARGET_PATTERNS: Readonly<
  Record<Exclude<TargetKind, 'root' | 'all' | 'deformable'>, RegExp>
> = {
  limbs: /^(leg|arm|paw|foot|hand|limb)/,
  wings: /^wing/,
  wheels: /^wheel/,
  panel: /^(panel|leaf|header)/,
  head: /^(head|neck)/,
};
