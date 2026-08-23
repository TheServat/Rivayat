/**
 * Deterministic ids.
 *
 * Every fixture in this package feeds an exporter whose output is compared byte-for-byte
 * across runs, so a random ULID would make the determinism tests fail for the wrong
 * reason. `IdGenerator` already takes a `Clock` and a byte source; supplying fixed ones
 * makes the ids reproducible without any special path in the production code.
 */

import { FixedClock, IdGenerator, instant } from '@rv/shared-kernel';
import { Ids } from '@rv/contracts';

export const FIXED_INSTANT_MS = 1_724_400_000_000;

export function testIds(startMs = FIXED_INSTANT_MS): Ids {
  let counter = 0;
  return new Ids(
    new IdGenerator(new FixedClock(instant(startMs)), (size) => {
      counter += 1;
      return Uint8Array.from({ length: size }, (_, index) => (counter * 31 + index * 17) & 0xff);
    }),
  );
}

export function testClock(): FixedClock {
  return new FixedClock('2026-08-23T00:00:00.000Z');
}
