import { AnimationIR } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import { TERRACE_IR } from '../../api/fixtures/animations.fixture';

import { applyOp, type IrOp } from './ir-ops';

/**
 * RV-146's central property, asserted rather than described: **every op declares its
 * inverse, and applying an op then its inverse restores the IR byte for byte.**
 *
 * Compared through `JSON.stringify` rather than `toEqual`, because "byte for byte" is
 * the claim. `exactOptionalPropertyTypes` makes `{easing: undefined}` a different value
 * from `{}` and `toEqual` treats them as equal, which is exactly the difference an
 * easing that was cleared and restored would leave behind.
 */

const LANTERN_TRACK = TERRACE_IR.tracks[0];
const HERON_TRACK = TERRACE_IR.tracks[2];
const SWAY = TERRACE_IR.behaviours[0];

function bytes(ir: AnimationIR): string {
  return JSON.stringify(ir);
}

function applyOrThrow(ir: AnimationIR, op: IrOp): { ir: AnimationIR; inverse: IrOp } {
  const result = applyOp(ir, op);
  if (!result.ok) throw new Error(`refused: ${result.refusal.code} ${result.refusal.subject}`);
  return { ir: result.ir, inverse: result.inverse };
}

describe('the fixture the ops are applied to', () => {
  it('has the tracks and the behaviour these tests name', () => {
    expect(LANTERN_TRACK).toBeDefined();
    expect(HERON_TRACK).toBeDefined();
    expect(SWAY).toBeDefined();
  });
});

describe('every op is reversible', () => {
  const ops: readonly IrOp[] = [
    {
      kind: 'moveKeyframe',
      trackId: LANTERN_TRACK?.id ?? '',
      index: 1,
      timeMs: 2400,
      value: -0.25,
    },
    {
      kind: 'setEasing',
      trackId: LANTERN_TRACK?.id ?? '',
      index: 0,
      easing: { kind: 'stepped', at: 'end', steps: 4 },
    },
    // Clearing an easing that was set: the case where `undefined` and absent differ.
    { kind: 'setEasing', trackId: LANTERN_TRACK?.id ?? '', index: 0, easing: undefined },
    { kind: 'setBehaviourParam', behaviourId: SWAY?.id ?? '', param: 'hz', value: 1.75 },
    { kind: 'setBehaviourParam', behaviourId: SWAY?.id ?? '', param: 'enabled', value: false },
  ];

  it.each(ops.map((op) => [op.kind, op] as const))(
    'restores the document byte for byte after %s',
    (_label, op) => {
      const before = bytes(TERRACE_IR);
      const applied = applyOrThrow(TERRACE_IR, op);
      expect(bytes(applied.ir)).not.toBe(before);

      const undone = applyOrThrow(applied.ir, applied.inverse);
      expect(bytes(undone.ir)).toBe(before);
    },
  );

  it('never mutates the document it was given', () => {
    const before = bytes(TERRACE_IR);
    applyOrThrow(TERRACE_IR, {
      kind: 'moveKeyframe',
      trackId: LANTERN_TRACK?.id ?? '',
      index: 1,
      timeMs: 2000,
      value: 0,
    });
    // The undo stack keeps the previous document by reference; an in-place edit would
    // make every entry on that stack the same object.
    expect(bytes(TERRACE_IR)).toBe(before);
  });

  it('undoes a sequence in reverse and lands exactly where it started', () => {
    const before = bytes(TERRACE_IR);
    let current = TERRACE_IR;
    const inverses: IrOp[] = [];
    for (const op of ops) {
      const applied = applyOrThrow(current, op);
      current = applied.ir;
      inverses.push(applied.inverse);
    }
    for (const inverse of inverses.toReversed()) {
      current = applyOrThrow(current, inverse).ir;
    }
    expect(bytes(current)).toBe(before);
  });
});

describe('an op that would break the document is refused, and the document is unchanged', () => {
  /** Asserted on the structured code, never on the wording: the wording is translated. */
  function refusalOf(op: IrOp): string {
    const result = applyOp(TERRACE_IR, op);
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.refusal.code;
  }

  it('refuses a keyframe dragged past its neighbour', () => {
    // "Strictly ordered by time" is a schema refinement, and the evaluator scans for
    // the bracketing pair - an out-of-order keyframe silently never plays.
    expect(
      refusalOf({
        kind: 'moveKeyframe',
        trackId: LANTERN_TRACK?.id ?? '',
        index: 0,
        timeMs: 5000,
        value: -1,
      }),
    ).toBe('out-of-order');
  });

  it('refuses a time past the end of the clip', () => {
    expect(
      refusalOf({
        kind: 'moveKeyframe',
        trackId: HERON_TRACK?.id ?? '',
        index: 2,
        timeMs: 9000,
        value: 0,
      }),
    ).toBe('past-duration');
  });

  it('refuses a negative time', () => {
    expect(
      refusalOf({
        kind: 'moveKeyframe',
        trackId: LANTERN_TRACK?.id ?? '',
        index: 0,
        timeMs: -1,
        value: 0,
      }),
    ).toBe('before-zero');
  });

  it('refuses a NaN, rather than writing one into the document', () => {
    expect(
      refusalOf({
        kind: 'moveKeyframe',
        trackId: LANTERN_TRACK?.id ?? '',
        index: 0,
        timeMs: Number.NaN,
        value: 0,
      }),
    ).toBe('not-a-number');
  });

  it('refuses an unknown track, keyframe and behaviour', () => {
    expect(
      refusalOf({ kind: 'moveKeyframe', trackId: 'trk_nope', index: 0, timeMs: 0, value: 0 }),
    ).toBe('unknown-track');
    expect(
      refusalOf({
        kind: 'moveKeyframe',
        trackId: LANTERN_TRACK?.id ?? '',
        index: 99,
        timeMs: 0,
        value: 0,
      }),
    ).toBe('unknown-keyframe');
    expect(
      refusalOf({ kind: 'setBehaviourParam', behaviourId: 'bhv_nope', param: 'hz', value: 1 }),
    ).toBe('unknown-behaviour');
  });

  it('refuses to write a field that is not a parameter', () => {
    // `kind`, `id` and `nodeId` are own properties too, and a numeric input that could
    // reach one would produce a document that no longer parses and no longer names its
    // own node.
    expect(
      refusalOf({
        kind: 'setBehaviourParam',
        behaviourId: SWAY?.id ?? '',
        param: 'kind',
        value: 1,
      }),
    ).toBe('unknown-param');
    expect(
      refusalOf({
        kind: 'setBehaviourParam',
        behaviourId: SWAY?.id ?? '',
        param: 'nodeId',
        value: 1,
      }),
    ).toBe('unknown-param');
  });

  it('refuses a parameter the behaviour does not have', () => {
    // `sway` has no `gustiness`; wind does.
    expect(
      refusalOf({
        kind: 'setBehaviourParam',
        behaviourId: SWAY?.id ?? '',
        param: 'gustiness',
        value: 0.5,
      }),
    ).toBe('unknown-param');
  });

  it('leaves the document valid after every accepted op', () => {
    const applied = applyOrThrow(TERRACE_IR, {
      kind: 'moveKeyframe',
      trackId: LANTERN_TRACK?.id ?? '',
      index: 1,
      timeMs: 2400,
      value: -0.25,
    });
    // Parsed with the real contract schema, not merely inspected: an edit that produced
    // a document the renderer would refuse is a bug however good it looks on screen.
    const parsed = AnimationIR.safeParse(applied.ir);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });
});
