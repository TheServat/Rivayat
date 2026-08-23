import { describe, expect, it } from 'vitest';

import { InternalError, ValidationError } from './errors';
import { assertDefined, assertNever, at, invariant, isDefined, must, require_ } from './guard';

describe('invariant - our own bugs', () => {
  it('passes a truthy condition through', () => {
    expect(() => invariant(1, 'never')).not.toThrow();
  });

  it('throws InternalError on a falsy condition', () => {
    expect(() => invariant(false, 'rig must have a root bone')).toThrow(InternalError);
    expect(() => invariant(0, 'x')).toThrow(/Invariant violated: x/);
  });

  it('narrows the type for the compiler', () => {
    const value: string | undefined = 'present';
    invariant(value, 'value');
    expect(value.length).toBe(7);
  });
});

describe('require_ - caller input', () => {
  it('throws ValidationError, which the API layer maps to 400 rather than 500', () => {
    expect(() => require_(false, 'fps must be positive')).toThrow(ValidationError);
    expect(() => require_(true, 'x')).not.toThrow();
  });
});

describe('isDefined / assertDefined', () => {
  it.each([
    [0, true],
    ['', true],
    [false, true],
    [Number.NaN, true],
    [null, false],
    [undefined, false],
  ])('isDefined(%s) === %s', (value, expected) => {
    expect(isDefined(value)).toBe(expected);
  });

  it('assertDefined passes on a present value and narrows it', () => {
    const value: number | null = 5;
    assertDefined(value, 'count');
    expect(value + 1).toBe(6);
  });

  it.each([null, undefined])('assertDefined throws on %s', (value) => {
    expect(() => {
      assertDefined(value, 'styleBible');
    }).toThrow(/Expected styleBible to be defined/);
  });
});

describe('assertNever - exhaustiveness', () => {
  it('throws when an unhandled variant reaches it at runtime', () => {
    const rogue = 'unexpected-kind' as never;
    expect(() => assertNever(rogue, 'behaviour kind')).toThrow(
      /Unhandled behaviour kind: "unexpected-kind"/,
    );
  });

  it('defaults the context label', () => {
    expect(() => assertNever(1 as never)).toThrow(/Unhandled value: 1/);
  });
});

describe('at - indexed access under noUncheckedIndexedAccess', () => {
  it('returns the element', () => {
    expect(at(['a', 'b'], 1)).toBe('b');
  });

  it.each([-1, 2, 99])('throws for out-of-range index %i', (index) => {
    expect(() => at(['a', 'b'], index, 'keyframe')).toThrow(/Expected keyframe at index .* of 2/);
  });

  it('throws for a hole rather than returning undefined', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => at([1, , 3] as number[], 1)).toThrow(InternalError);
  });
});

describe('must - map lookup', () => {
  const map = new Map([['a', 1]]);

  it('returns the value when present', () => {
    expect(must(map, 'a')).toBe(1);
  });

  it('throws with the missing key named', () => {
    expect(() => must(map, 'b', 'motion preset')).toThrow(/Missing motion preset: b/);
  });
});
