import { StyleBible } from '@rv/contracts';
import { computeStyleChecksum, fork, isChecksumValid, lock } from '@rv/core-domain';
import { isErr, isOk } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { testClock, testIds } from './__fixtures__/fakes';
import { STYLE_PRESETS } from './presets/index';
import { materialiseStyleBible } from './style-bible-factory';

const PRESET = STYLE_PRESETS[0];
if (PRESET === undefined) throw new Error('the preset library is empty');

describe('materialiseStyleBible', () => {
  it('mints an unlocked, correctly checksummed bible', () => {
    const bible = materialiseStyleBible({
      draft: PRESET.draft,
      id: testIds().styleBible(),
      clock: testClock(),
    });

    expect(() => StyleBible.parse(bible)).not.toThrow();
    expect(isChecksumValid(bible)).toBe(true);
    // Unlocked deliberately: a factory that produced locked documents would let a style
    // reach the image models before anyone had looked at a probe sheet.
    expect(bible.lockedAt).toBeNull();
    expect(bible.version).toBe(1);
    expect(bible.parentId).toBeUndefined();
  });

  it('computes the checksum rather than accepting one', () => {
    const bible = materialiseStyleBible({
      draft: PRESET.draft,
      id: testIds().styleBible(),
      clock: testClock(),
    });
    expect(bible.checksum).toBe(computeStyleChecksum(bible));
    expect(bible.checksum).not.toBe('0'.repeat(64));
  });

  it('records a parent and a version when a draft came from a fork', () => {
    const ids = testIds();
    const parentId = ids.styleBible();
    const bible = materialiseStyleBible({
      draft: { ...PRESET.draft, origin: 'forked' },
      id: ids.styleBible(),
      clock: testClock(),
      parentId,
      version: 4,
    });
    expect(bible.parentId).toBe(parentId);
    expect(bible.version).toBe(4);
  });

  it('produces a document the core-domain lock and fork accept', () => {
    // The factory is the only writer of a checksum outside `@rv/core-domain`, so the two
    // must agree; a bible this package mints and the domain refuses would be a silent
    // dead end at the end of stage S1.
    const bible = materialiseStyleBible({
      draft: PRESET.draft,
      id: testIds().styleBible(),
      clock: testClock(),
    });

    const locked = lock(bible, '2026-08-23T00:00:00.000Z');
    expect(isOk(locked)).toBe(true);
    if (!isOk(locked)) return;
    expect(isErr(lock(locked.value, '2026-08-23T00:00:01.000Z'))).toBe(true);

    const forked = fork(
      locked.value,
      { seed: 999 },
      testIds(1_900_000_000_000).styleBible(),
      '2026-08-24T00:00:00.000Z',
    );
    expect(forked.parentId).toBe(locked.value.id);
    expect(forked.checksum).not.toBe(locked.value.checksum);
    expect(isChecksumValid(forked)).toBe(true);
  });

  it('gives two different presets two different checksums', () => {
    const checksums = STYLE_PRESETS.map(
      (preset) =>
        materialiseStyleBible({
          draft: preset.draft,
          id: testIds().styleBible(),
          clock: testClock(),
        }).checksum,
    );
    expect(new Set(checksums).size).toBe(STYLE_PRESETS.length);
  });
});
