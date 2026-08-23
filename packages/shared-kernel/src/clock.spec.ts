import { describe, expect, it } from 'vitest';

import {
  FixedClock,
  SystemClock,
  addMillis,
  fromIso,
  instant,
  millis,
  since,
  toIso,
} from './clock';

describe('conversions', () => {
  it('round-trips through ISO-8601', () => {
    const iso = '2026-08-23T11:44:05.123Z';
    expect(toIso(fromIso(iso))).toBe(iso);
  });

  it('rejects an unparseable string rather than producing NaN', () => {
    expect(() => fromIso('not a date')).toThrow(TypeError);
  });

  it('adds a duration and measures an interval', () => {
    const start = instant(1_000);
    const end = addMillis(start, millis(250));
    expect(end).toBe(1_250);
    expect(since(start, end)).toBe(250);
  });

  it('measures a negative interval when the arguments are reversed', () => {
    expect(since(instant(1_250), instant(1_000))).toBe(-250);
  });
});

describe('SystemClock', () => {
  it('reports the current wall-clock time', () => {
    const before = Date.now();
    const now = new SystemClock().now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe('FixedClock', () => {
  it('does not move on its own', () => {
    const clock = new FixedClock(instant(500));
    expect(clock.now()).toBe(500);
    expect(clock.now()).toBe(500);
  });

  it('defaults to the epoch', () => {
    expect(new FixedClock().now()).toBe(0);
  });

  it('accepts an ISO string for readability in tests', () => {
    expect(toIso(new FixedClock('2026-01-01T00:00:00.000Z').now())).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('advances by the requested amount and returns the new instant', () => {
    const clock = new FixedClock(instant(100));
    expect(clock.advance(50)).toBe(150);
    expect(clock.advance(millis(25))).toBe(175);
    expect(clock.now()).toBe(175);
  });

  it('can be set to an arbitrary instant', () => {
    const clock = new FixedClock(instant(100));
    clock.set(instant(9_000));
    expect(clock.now()).toBe(9_000);
  });
});
