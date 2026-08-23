import { describe, expect, it } from 'vitest';

import { StyleBible, type StyleBibleId } from '@rv/contracts';

import { styleBibleFixture, otherStyleId } from './__fixtures__/style';
import {
  assertUsableForGeneration,
  computeStyleChecksum,
  fork,
  isChecksumValid,
  isLocked,
  lock,
} from './style-lock';

const NOW = '2026-08-23T12:00:00.000Z';

describe('computeStyleChecksum', () => {
  it('is deterministic', () => {
    const bible = styleBibleFixture();
    expect(computeStyleChecksum(bible)).toBe(computeStyleChecksum(bible));
  });

  it('ignores identity and bookkeeping - renaming a style is not a restyle', () => {
    // This is what makes a rename free: the asset library is keyed on the checksum.
    const base = styleBibleFixture();
    const renamed = StyleBible.parse({
      ...base,
      name: 'A Completely Different Name',
      version: 9,
      createdAt: '2020-01-01T00:00:00.000Z',
      notes: 'some note',
    });
    expect(computeStyleChecksum(renamed)).toBe(computeStyleChecksum(base));
  });

  it('changes when the palette changes', () => {
    const base = styleBibleFixture();
    const restyled = StyleBible.parse({
      ...base,
      visual: {
        ...base.visual,
        palette: {
          ...base.visual.palette,
          colors: [
            { name: 'ash', hex: '#222222' },
            { name: 'bone', hex: '#eeeeee' },
            { name: 'rust', hex: '#8a3b12' },
          ],
        },
      },
    });
    expect(computeStyleChecksum(restyled)).not.toBe(computeStyleChecksum(base));
  });

  it('changes when the motion changes, because motion is part of the style', () => {
    const base = styleBibleFixture();
    const stepped = StyleBible.parse({ ...base, motion: { ...base.motion, stepMode: 'on-3s' } });
    expect(computeStyleChecksum(stepped)).not.toBe(computeStyleChecksum(base));
  });

  it('changes when the seed changes', () => {
    const base = styleBibleFixture();
    const reseeded = StyleBible.parse({ ...base, seed: base.seed + 1 });
    expect(computeStyleChecksum(reseeded)).not.toBe(computeStyleChecksum(base));
  });

  it('normalises defaults - omitting a sub-block equals spelling out its defaults', () => {
    const explicit = styleBibleFixture();
    const implicit = StyleBible.parse({
      ...explicit,
      visual: { ...explicit.visual, texture: undefined },
    });
    expect(computeStyleChecksum(implicit)).toBe(computeStyleChecksum(explicit));
  });
});

describe('locking', () => {
  it('starts unlocked', () => {
    expect(isLocked(styleBibleFixture())).toBe(false);
  });

  it('locks, stamping the instant and recomputing the checksum', () => {
    const bible = styleBibleFixture();
    const result = lock(bible, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lockedAt).toBe(NOW);
    expect(result.value.checksum).toBe(computeStyleChecksum(bible));
    expect(isLocked(result.value)).toBe(true);
  });

  it('overwrites a hand-set checksum rather than trusting it', () => {
    // A hand-set checksum is cache poisoning; this is the only place it is written.
    const tampered = StyleBible.parse({ ...styleBibleFixture(), checksum: 'f'.repeat(64) });
    const result = lock(tampered, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checksum).not.toBe('f'.repeat(64));
    expect(isChecksumValid(result.value)).toBe(true);
  });

  it('refuses to lock twice', () => {
    const locked = lock(styleBibleFixture(), NOW);
    expect(locked.ok).toBe(true);
    if (!locked.ok) return;
    const again = lock(locked.value, NOW);
    expect(again.ok).toBe(false);
    expect(again.ok ? '' : again.error.message).toMatch(/already locked; fork it/);
  });
});

describe('checksum validity', () => {
  it('is valid immediately after locking', () => {
    const locked = lock(styleBibleFixture(), NOW);
    expect(locked.ok && isChecksumValid(locked.value)).toBe(true);
  });

  it('detects an in-place edit of a locked style', () => {
    const locked = lock(styleBibleFixture(), NOW);
    expect(locked.ok).toBe(true);
    if (!locked.ok) return;
    const tampered = StyleBible.parse({ ...locked.value, seed: locked.value.seed + 1 });
    expect(isChecksumValid(tampered)).toBe(false);
  });
});

describe('forking', () => {
  it('produces an unlocked child that records its parent', () => {
    const locked = lock(styleBibleFixture(), NOW);
    expect(locked.ok).toBe(true);
    if (!locked.ok) return;

    const child = fork(locked.value, { seed: 999 }, otherStyleId, NOW);
    expect(child).toMatchObject({
      id: otherStyleId,
      parentId: locked.value.id,
      origin: 'forked',
      version: locked.value.version + 1,
      lockedAt: null,
      seed: 999,
    });
  });

  it('gives the fork its own checksum', () => {
    const locked = lock(styleBibleFixture(), NOW);
    if (!locked.ok) return;
    const child = fork(locked.value, { seed: 999 }, otherStyleId, NOW);
    expect(child.checksum).not.toBe(locked.value.checksum);
    expect(isChecksumValid(child)).toBe(true);
  });

  it('a fork with no content change keeps the parent checksum, so nothing regenerates', () => {
    // Forking to rename must not fork the asset library.
    const locked = lock(styleBibleFixture(), NOW);
    if (!locked.ok) return;
    const renamed = fork(locked.value, { name: 'Season Two' }, otherStyleId, NOW);
    expect(renamed.checksum).toBe(locked.value.checksum);
  });

  it('leaves the parent untouched', () => {
    const locked = lock(styleBibleFixture(), NOW);
    if (!locked.ok) return;
    const before = structuredClone(locked.value);
    fork(locked.value, { seed: 1 }, otherStyleId, NOW);
    expect(locked.value).toEqual(before);
  });

  it('produces something the schema still accepts', () => {
    const locked = lock(styleBibleFixture(), NOW);
    if (!locked.ok) return;
    const child = fork(locked.value, { seed: 7 }, otherStyleId, NOW);
    expect(StyleBible.safeParse(child).success).toBe(true);
  });
});

describe('the generation guard', () => {
  it('refuses an unlocked style and says what to do about it', () => {
    const result = assertUsableForGeneration(styleBibleFixture());
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toMatch(/not locked.*probe sheet/s);
  });

  it('refuses a locked style whose content was edited afterwards', () => {
    const locked = lock(styleBibleFixture(), NOW);
    if (!locked.ok) return;
    const tampered = StyleBible.parse({ ...locked.value, seed: 12 });

    const result = assertUsableForGeneration(tampered);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toMatch(/modified after locking/);
    expect(result.ok ? {} : result.error.context).toHaveProperty('stored');
    expect(result.ok ? {} : result.error.context).toHaveProperty('actual');
  });

  it('returns the checksum that every asset key will embed', () => {
    const locked = lock(styleBibleFixture(), NOW);
    if (!locked.ok) return;

    const result = assertUsableForGeneration(locked.value);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : '').toBe(locked.value.checksum);
  });

  it('distinguishes the two failures - one is workflow, one is data integrity', () => {
    const unlocked = assertUsableForGeneration(styleBibleFixture());
    const locked = lock(styleBibleFixture(), NOW);
    if (!locked.ok) return;
    const stale = assertUsableForGeneration(StyleBible.parse({ ...locked.value, seed: 42 }));

    expect(unlocked.ok || stale.ok).toBe(false);
    expect(unlocked.ok ? '' : unlocked.error.message).not.toBe(stale.ok ? '' : stale.error.message);
  });
});

describe('type surface', () => {
  it('accepts a StyleBibleId where the schema expects one', () => {
    const id: StyleBibleId = otherStyleId;
    expect(typeof id).toBe('string');
  });
});
