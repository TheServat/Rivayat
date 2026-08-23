import { describe, expect, it, vi } from 'vitest';

import { InternalError, ValidationError } from './errors';
import {
  UNIT,
  all,
  andThen,
  err,
  fromPromise,
  fromThrowable,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  orElse,
  partition,
  tap,
  tapErr,
  unwrap,
  unwrapOr,
  unwrapOrElse,
  type Result,
} from './result';

describe('construction and narrowing', () => {
  it('ok() with no argument carries the unit value', () => {
    const result = ok();
    expect(result).toEqual({ ok: true, value: UNIT });
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
  });

  it('ok(value) carries the value', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('err(error) carries the error', () => {
    const error = new ValidationError({ message: 'bad' });
    const result = err(error);
    expect(isErr(result)).toBe(true);
    expect(result.error).toBe(error);
  });

  it('narrows the union so the payload is reachable without a cast', () => {
    const result: Result<number, ValidationError> = ok(1);
    if (isOk(result)) {
      expect(result.value + 1).toBe(2);
    } else {
      expect.unreachable('expected Ok');
    }
  });
});

describe('transformation', () => {
  it('map applies on Ok and passes Err through untouched', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual({ ok: true, value: 6 });

    const failure = err(new ValidationError({ message: 'x' }));
    const fn = vi.fn();
    expect(map(failure, fn)).toBe(failure);
    expect(fn).not.toHaveBeenCalled();
  });

  it('mapErr applies on Err and passes Ok through untouched', () => {
    const mapped = mapErr(err('low'), (e) => `${e}-high`);
    expect(mapped).toEqual({ ok: false, error: 'low-high' });

    const success = ok(1);
    expect(mapErr(success, () => 'never')).toBe(success);
  });

  it('andThen chains a fallible step and short-circuits on the first failure', () => {
    const double = (n: number): Result<number, string> => ok(n * 2);
    const fail = (): Result<number, string> => err('boom');

    expect(andThen(ok(3), double)).toEqual({ ok: true, value: 6 });
    expect(andThen(ok(3), fail)).toEqual({ ok: false, error: 'boom' });

    const upstream = err('earlier');
    const later = vi.fn(double);
    expect(andThen(upstream, later)).toBe(upstream);
    expect(later).not.toHaveBeenCalled();
  });

  it('orElse recovers from a failure only', () => {
    expect(orElse(err('boom'), () => ok('recovered'))).toEqual({ ok: true, value: 'recovered' });

    const success = ok('kept');
    expect(orElse(success, () => ok('replaced'))).toBe(success);
  });

  it('tap and tapErr run a side effect on the matching branch only', () => {
    const onOk = vi.fn();
    const onErr = vi.fn();

    tap(ok(5), onOk);
    tap(err('e'), onOk);
    tapErr(err('e'), onErr);
    tapErr(ok(5), onErr);

    expect(onOk).toHaveBeenCalledExactlyOnceWith(5);
    expect(onErr).toHaveBeenCalledExactlyOnceWith('e');
  });
});

describe('extraction', () => {
  it('unwrapOr / unwrapOrElse fall back only on Err', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err('e'), 9)).toBe(9);
    expect(unwrapOrElse(err('boom'), (e) => e.length)).toBe(4);
  });

  it('unwrap returns the value on Ok', () => {
    expect(unwrap(ok('v'))).toBe('v');
  });

  it('unwrap rethrows the original error instance when it is an Error', () => {
    const error = new InternalError({ message: 'nope' });
    expect(() => unwrap(err(error))).toThrow(error);
  });

  it('unwrap wraps a non-Error payload rather than throwing a bare value', () => {
    expect(() => unwrap(err({ code: 7 }))).toThrowError(/Called unwrap on an Err.*"code":7/s);
  });
});

describe('combination', () => {
  it('all collects every value when nothing failed', () => {
    expect(all([ok(1), ok(2), ok(3)])).toEqual({ ok: true, value: [1, 2, 3] });
    expect(all([])).toEqual({ ok: true, value: [] });
  });

  it('all returns the first failure and stops', () => {
    expect(all([ok(1), err('first'), err('second')])).toEqual({ ok: false, error: 'first' });
  });

  it('partition keeps both sides, which is what batch asset generation needs', () => {
    const results: Result<number, string>[] = [ok(1), err('a'), ok(2), err('b')];
    expect(partition(results)).toEqual({ values: [1, 2], errors: ['a', 'b'] });
  });
});

describe('interop with throwing code', () => {
  it('fromThrowable converts a throw into Err via the mapper', () => {
    const result = fromThrowable(
      () => {
        throw new Error('kaboom');
      },
      (caught) => (caught as Error).message,
    );
    expect(result).toEqual({ ok: false, error: 'kaboom' });
  });

  it('fromThrowable passes a successful value through', () => {
    expect(fromThrowable(() => 7, String)).toEqual({ ok: true, value: 7 });
  });

  it('fromPromise converts a rejection into Err', async () => {
    await expect(
      fromPromise(Promise.reject(new Error('net')), (c) => (c as Error).message),
    ).resolves.toEqual({ ok: false, error: 'net' });
  });

  it('fromPromise passes a resolution through', async () => {
    await expect(fromPromise(Promise.resolve('v'), String)).resolves.toEqual({
      ok: true,
      value: 'v',
    });
  });
});
