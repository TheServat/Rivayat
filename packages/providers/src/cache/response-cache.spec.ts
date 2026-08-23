import { describe, expect, it } from 'vitest';
import { isOk, millis } from '@rv/shared-kernel';

import { fixedClock } from '../__fixtures__/support';
import { InMemoryResponseCache, cacheKey } from './response-cache';

const BASE = {
  modelRef: 'openrouter:google/gemini-2.5-flash-image',
  params: { seed: 42, size: { width: 512, height: 512 } },
  prompt: 'a brass pocket watch on dark linen',
};

describe('cacheKey', () => {
  it('is stable across key reordering in params', () => {
    // `JSON.stringify` orders by insertion, so without `stableStringify` these two
    // logically identical requests would miss and we would pay twice.
    const a = cacheKey({ ...BASE, params: { seed: 42, size: { width: 512, height: 512 } } });
    const b = cacheKey({ ...BASE, params: { size: { height: 512, width: 512 }, seed: 42 } });
    expect(a).toBe(b);
  });

  it('changes when the seed changes', () => {
    const a = cacheKey(BASE);
    const b = cacheKey({ ...BASE, params: { ...BASE.params, seed: 43 } });
    expect(a).not.toBe(b);
  });

  it('changes when the model changes, even for an identical prompt', () => {
    // The same slug through two providers bills and behaves differently.
    const a = cacheKey(BASE);
    const b = cacheKey({ ...BASE, modelRef: 'gemini:gemini-2.5-flash-image' });
    expect(a).not.toBe(b);
  });

  it('changes when the reference images change, and respects their order', () => {
    const one = cacheKey({ ...BASE, refHashes: ['aa', 'bb'] });
    const two = cacheKey({ ...BASE, refHashes: ['bb', 'aa'] });
    const none = cacheKey(BASE);
    expect(one).not.toBe(two);
    expect(one).not.toBe(none);
  });

  it('cannot be collided by shifting a boundary between components', () => {
    // The classic concatenation collision: ["ab","c"] vs ["a","bc"].
    const a = cacheKey({ modelRef: 'ab', params: {}, prompt: 'c' });
    const b = cacheKey({ modelRef: 'a', params: {}, prompt: 'bc' });
    expect(a).not.toBe(b);
  });
});

describe('InMemoryResponseCache', () => {
  it('misses, stores, then hits', async () => {
    const clock = fixedClock();
    const cache = new InMemoryResponseCache({ clock });
    const key = cacheKey(BASE);

    const miss = await cache.get<string>(key);
    expect(isOk(miss) && miss.value).toBeNull();

    await cache.set(key, { value: 'bytes', modelRef: BASE.modelRef });
    const hit = await cache.get<string>(key);

    expect(isOk(hit)).toBe(true);
    if (isOk(hit)) {
      expect(hit.value?.value).toBe('bytes');
      expect(hit.value?.modelRef).toBe(BASE.modelRef);
      expect(hit.value?.storedAt).toBe(clock.now());
    }
  });

  it('misses for the same prompt with a different seed', async () => {
    const cache = new InMemoryResponseCache({ clock: fixedClock() });
    await cache.set(cacheKey(BASE), { value: 1, modelRef: BASE.modelRef });

    const other = await cache.get(cacheKey({ ...BASE, params: { ...BASE.params, seed: 7 } }));
    expect(isOk(other) && other.value).toBeNull();
  });

  it('records the time from the injected clock, not the wall clock', async () => {
    const clock = fixedClock();
    const cache = new InMemoryResponseCache({ clock });
    clock.advance(millis(5_000));
    await cache.set(cacheKey(BASE), { value: 'x', modelRef: 'm' });

    const hit = await cache.get<string>(cacheKey(BASE));
    if (isOk(hit)) expect(hit.value?.storedAt).toBe(clock.now());
  });

  it('evicts the oldest entry past the bound', async () => {
    const cache = new InMemoryResponseCache({ clock: fixedClock(), maxEntries: 2 });
    const first = cacheKey({ ...BASE, prompt: 'one' });
    const second = cacheKey({ ...BASE, prompt: 'two' });
    const third = cacheKey({ ...BASE, prompt: 'three' });

    await cache.set(first, { value: 1, modelRef: 'm' });
    await cache.set(second, { value: 2, modelRef: 'm' });
    await cache.set(third, { value: 3, modelRef: 'm' });

    expect(cache.size()).toBe(2);
    const evicted = await cache.get(first);
    expect(isOk(evicted) && evicted.value).toBeNull();
  });

  it('moves a rewritten entry to the back of the eviction order', async () => {
    const cache = new InMemoryResponseCache({ clock: fixedClock(), maxEntries: 2 });
    const first = cacheKey({ ...BASE, prompt: 'one' });
    const second = cacheKey({ ...BASE, prompt: 'two' });
    const third = cacheKey({ ...BASE, prompt: 'three' });

    await cache.set(first, { value: 1, modelRef: 'm' });
    await cache.set(second, { value: 2, modelRef: 'm' });
    await cache.set(first, { value: 11, modelRef: 'm' });
    await cache.set(third, { value: 3, modelRef: 'm' });

    const survivor = await cache.get<number>(first);
    expect(isOk(survivor) && survivor.value?.value).toBe(11);
    const gone = await cache.get(second);
    expect(isOk(gone) && gone.value).toBeNull();
  });

  it('is a no-op when disabled - this is what `--no-cache` sets', async () => {
    const cache = new InMemoryResponseCache({ clock: fixedClock(), disabled: true });
    await cache.set(cacheKey(BASE), { value: 'x', modelRef: 'm' });

    const outcome = await cache.get(cacheKey(BASE));
    expect(isOk(outcome) && outcome.value).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('deletes and clears', async () => {
    const cache = new InMemoryResponseCache({ clock: fixedClock() });
    const key = cacheKey(BASE);
    await cache.set(key, { value: 'x', modelRef: 'm' });

    await cache.delete(key);
    expect(cache.size()).toBe(0);

    await cache.set(key, { value: 'y', modelRef: 'm' });
    await cache.clear();
    expect(cache.size()).toBe(0);
  });
});
