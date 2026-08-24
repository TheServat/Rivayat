/**
 * Typed, reversible edits to an `AnimationIR`.
 *
 * RV-146 specifies this op set and puts it in `@rv/anim-engine`
 * (`src/edit/ir-ops.ts`), where it will be shared by the CLI, the API and this screen.
 * **That package does not have it yet**, and RV-211 depends on RV-146. Rather than
 * block the screen, the three ops the timeline actually issues are implemented here,
 * with RV-146's names and RV-146's central property, so that when the engine's version
 * lands this file is deleted and the store's imports move one line:
 *
 *   *every op declares its inverse, and applying an op then its inverse restores the
 *   IR byte for byte.*
 *
 * That property is what makes undo correct rather than approximate, and it is asserted
 * directly in `ir-ops.spec.ts` by round-tripping through `JSON.stringify`.
 *
 * ## Why refusals are codes and not sentences
 *
 * A keyframe dragged past its neighbour is a refusal the user has to *read*, in Persian
 * or English. A kernel `ValidationError` carries an English message written for a log.
 * So an op returns a structured `IrOpRefusal` whose `code` the screen maps to a
 * catalogue key, and whose fields the message interpolates. Tests assert on the code,
 * never on wording.
 *
 * ## What is deliberately not validated here
 *
 * The full `AnimationIR` schema, on every pointer move. Re-parsing a document with
 * hundreds of nodes at 60 Hz is the one thing that would make a drag feel bad, and the
 * refinements that matter to these three ops - keyframes strictly ordered, times inside
 * the clip, the target exists - are checked directly and cheaply. The store re-parses
 * once when the gesture ends, and the server parses again on save.
 */

import type { AnimationIR, Behaviour, Easing, Keyframe, Track } from '@rv/contracts';

// ── the ops ─────────────────────────────────────────────────────────────────

/**
 * Move one keyframe in time, in value, or both.
 *
 * One op rather than two, because dragging a keyframe in a value track is one gesture
 * that changes both axes, and splitting it would put two entries on the undo stack for
 * something the user did once.
 */
export interface MoveKeyframeOp {
  readonly kind: 'moveKeyframe';
  readonly trackId: string;
  readonly index: number;
  readonly timeMs: number;
  readonly value: number;
}

export interface SetEasingOp {
  readonly kind: 'setEasing';
  readonly trackId: string;
  readonly index: number;
  /** `undefined` clears the easing, which the IR reads as linear. */
  readonly easing: Easing | undefined;
}

export interface SetBehaviourParamOp {
  readonly kind: 'setBehaviourParam';
  readonly behaviourId: string;
  readonly param: string;
  readonly value: number | boolean;
}

export type IrOp = MoveKeyframeOp | SetEasingOp | SetBehaviourParamOp;

export type IrOpRefusalCode =
  | 'unknown-track'
  | 'unknown-keyframe'
  | 'unknown-behaviour'
  | 'unknown-param'
  | 'not-a-number'
  | 'out-of-order'
  | 'past-duration'
  | 'before-zero';

export interface IrOpRefusal {
  readonly code: IrOpRefusalCode;
  /** Enough to say *which* thing, without composing a sentence in the wrong language. */
  readonly subject: string;
}

export type IrOpResult =
  | { readonly ok: true; readonly ir: AnimationIR; readonly inverse: IrOp }
  | { readonly ok: false; readonly refusal: IrOpRefusal };

/**
 * Applies one op, returning a new IR and the op that undoes it.
 *
 * The input is never mutated: the store keeps the previous IR on the undo stack, and an
 * in-place edit would make every entry on that stack the same object.
 */
export function applyOp(ir: AnimationIR, op: IrOp): IrOpResult {
  switch (op.kind) {
    case 'moveKeyframe':
      return moveKeyframe(ir, op);
    case 'setEasing':
      return setEasing(ir, op);
    case 'setBehaviourParam':
      return setBehaviourParam(ir, op);
  }
}

// ── moveKeyframe ────────────────────────────────────────────────────────────

function moveKeyframe(ir: AnimationIR, op: MoveKeyframeOp): IrOpResult {
  const found = findTrack(ir, op.trackId);
  if (found === undefined) return refuse('unknown-track', op.trackId);
  const { track, trackIndex } = found;

  const existing = track.keyframes[op.index];
  if (existing === undefined) return refuse('unknown-keyframe', String(op.index));
  if (!Number.isFinite(op.timeMs) || !Number.isFinite(op.value)) {
    return refuse('not-a-number', track.channel);
  }

  const timeMs = Math.round(op.timeMs);
  if (timeMs < 0) return refuse('before-zero', track.channel);
  if (timeMs > ir.durationMs) return refuse('past-duration', track.channel);

  // Strictly ordered by time is a schema refinement, not a nicety: the evaluator scans
  // for the bracketing pair and an out-of-order keyframe silently never plays.
  const previous = track.keyframes[op.index - 1];
  const next = track.keyframes[op.index + 1];
  if (previous !== undefined && timeMs <= previous.timeMs)
    return refuse('out-of-order', track.channel);
  if (next !== undefined && timeMs >= next.timeMs) return refuse('out-of-order', track.channel);

  const moved: Keyframe = { ...existing, timeMs, value: op.value };
  const keyframes = track.keyframes.map((keyframe, index) =>
    index === op.index ? moved : keyframe,
  );
  const tracks = ir.tracks.map((candidate, index) =>
    index === trackIndex ? { ...track, keyframes } : candidate,
  );

  return {
    ok: true,
    ir: { ...ir, tracks },
    inverse: {
      kind: 'moveKeyframe',
      trackId: op.trackId,
      index: op.index,
      timeMs: existing.timeMs,
      value: existing.value,
    },
  };
}

// ── setEasing ───────────────────────────────────────────────────────────────

function setEasing(ir: AnimationIR, op: SetEasingOp): IrOpResult {
  const found = findTrack(ir, op.trackId);
  if (found === undefined) return refuse('unknown-track', op.trackId);
  const { track, trackIndex } = found;

  const existing = track.keyframes[op.index];
  if (existing === undefined) return refuse('unknown-keyframe', String(op.index));

  // Written as a spread-or-omit rather than `{ easing: op.easing }`, because
  // `exactOptionalPropertyTypes` makes `{ easing: undefined }` a different value from
  // `{}` - and the difference survives into the JSON the undo test compares.
  const { easing: _dropped, ...withoutEasing } = existing;
  const replaced: Keyframe =
    op.easing === undefined ? withoutEasing : { ...withoutEasing, easing: op.easing };

  const keyframes = track.keyframes.map((keyframe, index) =>
    index === op.index ? replaced : keyframe,
  );
  const tracks = ir.tracks.map((candidate, index) =>
    index === trackIndex ? { ...track, keyframes } : candidate,
  );

  return {
    ok: true,
    ir: { ...ir, tracks },
    inverse: {
      kind: 'setEasing',
      trackId: op.trackId,
      index: op.index,
      easing: existing.easing,
    },
  };
}

// ── setBehaviourParam ───────────────────────────────────────────────────────

/**
 * The fields of a behaviour a slider may move.
 *
 * An allow-list rather than "any key that exists", because `kind`, `id` and `nodeId`
 * are also own properties and setting one of those through a numeric input would
 * produce a document that no longer parses and no longer names its own node.
 */
const EDITABLE_PARAMS: ReadonlySet<string> = new Set([
  'enabled',
  'weight',
  'hz',
  'amplitude',
  'amplitudeDeg',
  'gustiness',
  'direction',
  'tipBias',
  'intensity',
  'stiffness',
  'damping',
  'strength',
  'radius',
  'phase',
  'bounce',
  'strideLength',
  'stepsPerSecond',
  'downstrokeBias',
  'maxAngleDeg',
  'responsiveness',
  'periodMs',
  'intervalMs',
  'varianceMs',
  'closeDurationMs',
]);

function setBehaviourParam(ir: AnimationIR, op: SetBehaviourParamOp): IrOpResult {
  const index = ir.behaviours.findIndex((candidate) => candidate.id === op.behaviourId);
  const behaviour = ir.behaviours[index];
  if (behaviour === undefined) return refuse('unknown-behaviour', op.behaviourId);
  if (!EDITABLE_PARAMS.has(op.param)) return refuse('unknown-param', op.param);
  if (!(op.param in behaviour)) return refuse('unknown-param', op.param);
  if (typeof op.value === 'number' && !Number.isFinite(op.value)) {
    return refuse('not-a-number', op.param);
  }

  const record = behaviour as unknown as Record<string, unknown>;
  const before = record[op.param];
  if (typeof before !== typeof op.value) return refuse('unknown-param', op.param);

  const patched = { ...record, [op.param]: op.value } as unknown as Behaviour;
  const behaviours = ir.behaviours.map((candidate, position) =>
    position === index ? patched : candidate,
  );

  return {
    ok: true,
    ir: { ...ir, behaviours },
    inverse: {
      kind: 'setBehaviourParam',
      behaviourId: op.behaviourId,
      param: op.param,
      value: before as number | boolean,
    },
  };
}

// ── plumbing ────────────────────────────────────────────────────────────────

function findTrack(
  ir: AnimationIR,
  trackId: string,
): { track: Track; trackIndex: number } | undefined {
  const trackIndex = ir.tracks.findIndex((candidate) => candidate.id === trackId);
  const track = ir.tracks[trackIndex];
  return track === undefined ? undefined : { track, trackIndex };
}

function refuse(code: IrOpRefusalCode, subject: string): IrOpResult {
  return { ok: false, refusal: { code, subject } };
}
