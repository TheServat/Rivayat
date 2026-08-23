import { describe, expect, it } from 'vitest';

import { FixedClock, instant } from './clock';
import { ValidationError } from './errors';
import { IdGenerator, isPrefixedId, prefixOf, timestampOf } from './id';

/** A byte source that never repeats, so monotonic behaviour is observable. */
function countingBytes(): (size: number) => Uint8Array {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, i) => (counter + i) & 0xff);
  };
}

describe('shape', () => {
  it('produces <prefix>_<26 base32 chars>', () => {
    const id = new IdGenerator().next('chr');
    expect(id).toMatch(/^chr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isPrefixedId(id)).toBe(true);
  });

  it('uses Crockford base32, excluding the ambiguous letters I L O U', () => {
    const generator = new IdGenerator();
    const body = Array.from({ length: 200 }, () => generator.ulid()).join('');
    expect(body).not.toMatch(/[ILOU]/);
  });

  it('rejects a malformed prefix', () => {
    const generator = new IdGenerator();
    for (const bad of ['', 'A', 'x', 'has_underscore', 'toolongprefix', '1st', 'UPPER']) {
      expect(() => generator.next(bad)).toThrow(ValidationError);
    }
  });

  it('accepts a well-formed prefix', () => {
    const generator = new IdGenerator();
    for (const good of ['ch', 'chr', 'asset', 'ep1', 'shot123456']) {
      expect(() => generator.next(good)).not.toThrow();
    }
  });
});

describe('sortability', () => {
  it('orders lexicographically by creation time', () => {
    const clock = new FixedClock(instant(1_000_000_000_000));
    const generator = new IdGenerator(clock);

    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      ids.push(generator.next('sh'));
      clock.advance(1);
    }

    expect([...ids].sort()).toEqual(ids);
  });

  it('stays monotonic for ids minted within the same millisecond', () => {
    // A whole shot list is created in one tick; those ids must still sort in order.
    const generator = new IdGenerator(new FixedClock(instant(1_700_000_000_000)), countingBytes());
    const ids = Array.from({ length: 50 }, () => generator.next('sh'));

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it('carries the timestamp over the millisecond boundary correctly', () => {
    const clock = new FixedClock(instant(1_699_999_999_999));
    const generator = new IdGenerator(clock);
    const before = generator.next('sh');
    clock.advance(1);
    const after = generator.next('sh');
    expect(after > before).toBe(true);
  });
});

describe('parsing', () => {
  it('recovers the prefix', () => {
    expect(prefixOf(new IdGenerator().next('asset'))).toBe('asset');
  });

  it('recovers the creation instant from a prefixed id', () => {
    const when = instant(1_724_400_000_000);
    const id = new IdGenerator(new FixedClock(when)).next('ep');
    expect(timestampOf(id)).toBe(when);
  });

  it('recovers the creation instant from a bare ULID', () => {
    const when = instant(1_724_400_000_000);
    const generator = new IdGenerator(new FixedClock(when));
    expect(timestampOf(generator.ulid())).toBe(when);
  });

  it('rejects a malformed time component', () => {
    expect(() => timestampOf('bad_!!!!!!!!!!!!!!!!!!!!!!!!!!' as never)).toThrow(ValidationError);
  });

  it('isPrefixedId rejects non-ids', () => {
    for (const value of ['', 'nope', 42, null, 'chr_short', 'chr_' + 'A'.repeat(27)]) {
      expect(isPrefixedId(value)).toBe(false);
    }
  });
});

describe('uniqueness', () => {
  it('does not collide across a large batch on a real clock', () => {
    const generator = new IdGenerator();
    const ids = new Set(Array.from({ length: 20_000 }, () => generator.next('ast')));
    expect(ids.size).toBe(20_000);
  });
});
