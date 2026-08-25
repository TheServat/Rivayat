/**
 * The stubs, held to the one thing they promise.
 *
 * A stub that returned the wrong error kind would map to the wrong status - 500
 * instead of 501 - and a client would retry a route that will never work until the
 * package is written. A stub that did not name the package would leave whoever hit it
 * grepping the backlog. Both are cheap to get wrong and cheap to check.
 */

import type { AppError, Result } from '@rv/shared-kernel';
import { isErr } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  StubAssetProduction,
  StubNarrativeMemory,
  StubRenderEngine,
  StubStoryEngine,
  StubStyleEngine,
} from './stub.adapters';

/** Every stubbed method, paired with the package it must name. */
const CASES: readonly {
  readonly label: string;
  readonly owner: string;
  readonly call: () => Promise<Result<unknown, AppError>>;
}[] = (() => {
  const style = new StubStyleEngine();
  const story = new StubStoryEngine();
  const assets = new StubAssetProduction();
  const memory = new StubNarrativeMemory();
  const render = new StubRenderEngine();

  // The arguments are never read - the stub refuses before looking - so the casts here
  // buy real coverage of every method without building five valid domain documents.
  const anything = undefined as never;

  return [
    { label: 'style.listPresets', owner: '@rv/style-engine', call: () => style.listPresets() },
    {
      label: 'style.fromPreset',
      owner: '@rv/style-engine',
      call: () => style.fromPreset(anything),
    },
    { label: 'style.find', owner: '@rv/style-engine', call: () => style.find(anything) },
    { label: 'style.derive', owner: '@rv/style-engine', call: () => style.derive(anything) },
    { label: 'style.probe', owner: '@rv/style-engine', call: () => style.probe(anything) },
    { label: 'style.lock', owner: '@rv/style-engine', call: () => style.lock(anything) },
    {
      label: 'story.generateSeriesBible',
      owner: '@rv/story-engine',
      call: () => story.generateSeriesBible(anything, anything),
    },
    {
      label: 'story.generateWorld',
      owner: '@rv/story-engine',
      call: () => story.generateWorld(anything, anything),
    },
    {
      label: 'story.generateShotList',
      owner: '@rv/story-engine',
      call: () => story.generateShotList(anything, anything),
    },
    { label: 'assets.produce', owner: '@rv/asset-engine', call: () => assets.produce(anything) },
    {
      label: 'memory.ingestScene',
      owner: '@rv/narrative-memory',
      call: () => memory.ingestScene(anything, anything),
    },
    {
      label: 'memory.retrieve',
      owner: '@rv/narrative-memory',
      call: () => memory.retrieve(anything),
    },
    {
      label: 'memory.checkContinuity',
      owner: '@rv/narrative-memory',
      call: () => memory.checkContinuity(anything),
    },
    { label: 'render.render', owner: '@rv/render-engine', call: () => render.render(anything) },
  ];
})();

describe('the scaffolded-engine stubs', () => {
  it.each(CASES)('$label refuses as unsupported and names $owner', async ({ owner, call }) => {
    const outcome = await call();

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;

    // `unsupported` maps to 501. `internal` would map to 500 and invite a retry.
    expect(outcome.error.kind).toBe('unsupported');
    expect(outcome.error.retryable).toBe(false);
    expect(outcome.error.context.provider).toBe(owner);
    // The message points at the backlog, so the next question has an answer.
    expect(outcome.error.message).toContain('docs/03-backlog.md');
  });

  it('covers every method the five stubs expose', () => {
    const methods = [
      StubStyleEngine,
      StubStoryEngine,
      StubAssetProduction,
      StubNarrativeMemory,
      StubRenderEngine,
    ].flatMap((constructor) =>
      Object.getOwnPropertyNames(constructor.prototype).filter((name) => name !== 'constructor'),
    );
    expect(CASES).toHaveLength(methods.length);
  });
});
