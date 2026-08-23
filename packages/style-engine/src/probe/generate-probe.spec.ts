import type { ModelDescriptor } from '@rv/contracts';
import { computeStyleChecksum } from '@rv/core-domain';
import { ProviderError, isErr, isOk, stableStringify } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  FakeImagePort,
  lockedBibleFrom,
  testClock,
  unlockedBibleFrom,
} from '../__fixtures__/fakes';
import { STYLE_PRESETS } from '../presets/index';
import { GenerateStyleProbeUseCase } from './generate-probe';
import { PROBE_SUBJECTS } from './subjects';

function preset(id: string) {
  const found = STYLE_PRESETS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no preset ${id}`);
  return found;
}

const LOCKED = lockedBibleFrom(preset('paper-cutout'));

function subject(freeLane: FakeImagePort, extras: { paid?: FakeImagePort } = {}) {
  return new GenerateStyleProbeUseCase({
    imageLanes: { free: freeLane, ...(extras.paid === undefined ? {} : { paid: extras.paid }) },
    clock: testClock(),
  });
}

describe('GenerateStyleProbeUseCase, the lock guard', () => {
  it('refuses an unlocked style through the core-domain guard and calls no provider', async () => {
    // Reusing `assertUsableForGeneration` rather than writing a second lock check is the
    // whole point: two answers to "may this be drawn against" eventually disagree.
    const port = new FakeImagePort();
    const result = await subject(port).execute({ bible: unlockedBibleFrom(preset('watercolour')) });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.kind).toBe('validation');
    expect(port.requests).toHaveLength(0);
  });

  it('refuses a locked style whose content no longer matches its checksum', async () => {
    const tampered = {
      ...LOCKED,
      visual: { ...LOCKED.visual, shape: { ...LOCKED.visual.shape, detailDensity: 0.9 } },
    };
    expect(computeStyleChecksum(tampered)).not.toBe(tampered.checksum);

    const port = new FakeImagePort();
    const result = await subject(port).execute({ bible: tampered });

    expect(isErr(result)).toBe(true);
    expect(port.requests).toHaveLength(0);
  });
});

describe('GenerateStyleProbeUseCase, the free lane', () => {
  it('renders the fixed subject set and costs nothing', async () => {
    const port = new FakeImagePort({ modelRef: 'comfyui:sd1.5-lcm' });
    const result = await subject(port).execute({ bible: LOCKED });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.lane).toBe('free');
    expect(result.value.tiles.map((tile) => tile.subject.key)).toEqual(
      PROBE_SUBJECTS.map((entry) => entry.key),
    );
    // Local inference. Research §2: the free lane is free, and the ledger still gets a
    // row - a zero that is known to be zero.
    expect(result.value.totalCostNanoUsd).toBe(0);
    expect(result.value.costIsComplete).toBe(true);
    for (const tile of result.value.tiles) {
      expect(tile.costNanoUsd).toBe(0);
      expect(tile.priced).toBe(true);
    }
  });

  it('is the default lane', async () => {
    const free = new FakeImagePort();
    const paid = new FakeImagePort({ modelRef: 'openrouter:google/gemini-3-pro-image' });
    await subject(free, { paid }).execute({ bible: LOCKED });
    expect(free.requests).toHaveLength(PROBE_SUBJECTS.length);
    expect(paid.requests).toHaveLength(0);
  });

  it('sends the style clause, the subject clause and the negative list on every tile', async () => {
    const port = new FakeImagePort();
    await subject(port).execute({ bible: LOCKED });

    for (const [index, request] of port.requests.entries()) {
      const probe = PROBE_SUBJECTS[index];
      expect(probe).toBeDefined();
      expect(request.prompt).toContain(LOCKED.prompts.positive);
      expect(request.prompt).toContain(probe?.subject ?? '<<missing>>');
      expect(request.negativePrompt).toBe(LOCKED.prompts.negative);
    }
  });

  it('offsets every seed from the bible so the same candidate reproduces the same sheet', async () => {
    const first = new FakeImagePort();
    const second = new FakeImagePort();
    await subject(first).execute({ bible: LOCKED });
    await subject(second).execute({ bible: LOCKED });

    expect(first.requests.map((request) => request.seed)).toEqual(
      PROBE_SUBJECTS.map((_entry, index) => LOCKED.seed + index),
    );
    expect(stableStringify(first.requests)).toBe(stableStringify(second.requests));
  });

  it('draws at 512px unless told otherwise', async () => {
    // Research §0 measured 1.42 s at 512 and 7.59 s at 1024 on the 6 GB card, for a
    // judgement that is about style rather than resolution.
    const port = new FakeImagePort();
    await subject(port).execute({ bible: LOCKED });
    expect(port.requests[0]?.size).toEqual({ width: 512, height: 512 });

    const bigger = new FakeImagePort();
    const result = await subject(bigger).execute({
      bible: LOCKED,
      size: { width: 768, height: 768 },
    });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.size).toEqual({ width: 768, height: 768 });
  });

  it('stamps the sheet with the injected clock and the locked checksum', async () => {
    const result = await subject(new FakeImagePort()).execute({ bible: LOCKED });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.generatedAt).toBe('2025-08-24T01:46:40.000Z');
    expect(result.value.styleChecksum).toBe(LOCKED.checksum);
    expect(result.value.styleBibleId).toBe(LOCKED.id);
  });
});

describe('GenerateStyleProbeUseCase, cost reporting', () => {
  it('prices the paid lane from the catalogue', async () => {
    const paid = new FakeImagePort({ modelRef: 'openrouter:google/gemini-3.1-flash-lite-image' });
    const result = await subject(new FakeImagePort(), { paid }).execute({
      bible: LOCKED,
      lane: 'paid',
    });

    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.totalCostNanoUsd).toBeGreaterThan(0);
    expect(result.value.costIsComplete).toBe(true);
  });

  it('distinguishes "free" from "we have no price for this"', async () => {
    // A model missing from the catalogue must not be reported as costing nothing; that
    // is how a bill goes unnoticed.
    const paid = new FakeImagePort({ modelRef: 'openrouter:some/unlisted-image-model' });
    const result = await subject(new FakeImagePort(), { paid }).execute({
      bible: LOCKED,
      lane: 'paid',
    });

    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.costIsComplete).toBe(false);
    expect(result.value.tiles.every((tile) => !tile.priced)).toBe(true);
  });

  it('treats an unparseable model reference as unpriced', async () => {
    const odd = new FakeImagePort({ modelRef: 'not-a-known-provider:whatever' });
    const result = await subject(odd).execute({ bible: LOCKED });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.costIsComplete).toBe(false);
  });

  it('accepts an injected catalogue', async () => {
    const catalogue: readonly ModelDescriptor[] = [];
    const useCase = new GenerateStyleProbeUseCase({
      imageLanes: { free: new FakeImagePort() },
      clock: testClock(),
      catalogue,
    });
    const result = await useCase.execute({ bible: LOCKED });
    if (!isOk(result)) throw new Error('expected ok');
    expect(result.value.costIsComplete).toBe(false);
  });
});

describe('GenerateStyleProbeUseCase, failures', () => {
  it('reports an unwired lane by name rather than throwing on first use', async () => {
    const result = await subject(new FakeImagePort()).execute({ bible: LOCKED, lane: 'paid' });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.context).toMatchObject({ lane: 'paid' });
  });

  it('stops at the first failed tile and says what had already been spent', async () => {
    const port = new FakeImagePort({
      script: [undefined, new ProviderError({ provider: 'comfyui', message: 'out of VRAM' })],
    });
    const result = await subject(port).execute({ bible: LOCKED });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.context).toMatchObject({
      subject: 'tree',
      tilesCompleted: 1,
      spentNanoUsd: 0,
    });
    expect(port.requests).toHaveLength(2);
  });

  it('treats an empty image list as a failure rather than a blank tile', async () => {
    const port = new FakeImagePort({ script: [null] });
    const result = await subject(port).execute({ bible: LOCKED });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.context).toMatchObject({ subject: 'character' });
  });
});

describe('the probe subject set', () => {
  it('covers the four subject classes that expose different failures', () => {
    expect(PROBE_SUBJECTS.map((entry) => entry.subjectClass)).toEqual([
      'character',
      'foliage',
      'prop',
      'sky',
    ]);
    for (const entry of PROBE_SUBJECTS) {
      expect(entry.label.fa.length).toBeGreaterThan(0);
      expect(entry.label.en).toBeDefined();
    }
  });
});
