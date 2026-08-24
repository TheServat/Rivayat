import type { ModelDescriptor } from '@rv/contracts';
import { computeStyleChecksum } from '@rv/core-domain';
import {
  type AppError,
  BudgetExceededError,
  ProviderError,
  type Result,
  UNIT,
  type Unit,
  err,
  isErr,
  isOk,
  ok,
  stableStringify,
} from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  FakeImagePort,
  lockedBibleFrom,
  testClock,
  unlockedBibleFrom,
} from '../__fixtures__/fakes';
import { STYLE_PRESETS } from '../presets/index';
import {
  GenerateStyleProbeUseCase,
  type ProbeSpendGuard,
  type ProbeSpendRequest,
} from './generate-probe';
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

/**
 * CLAUDE.md #3, on the one loop in this package that spends real money.
 *
 * "Cost is metered before it is spent. ... The budget guard runs *before* the call." A
 * probe sheet is four image generations, and on the paid lane every one of them is
 * billable, so the interesting assertion is not that the total is right at the end - it is
 * that the provider is never reached once the ceiling is hit.
 *
 * The guard is therefore exercised by *counting provider requests*, not by inspecting the
 * returned cost: a use-case that generated all four tiles and then reported a refusal
 * would satisfy any assertion about the result and would still have spent the money.
 */
describe('GenerateStyleProbeUseCase, the budget guard', () => {
  /** A model the catalogue has a price for, so the running spend is non-zero. */
  const PRICED_IMAGE_MODEL = 'openrouter:google/gemini-3.1-flash-lite-image';

  /** Records every question asked, and answers `allow` of them before refusing. */
  class CountingGuard implements ProbeSpendGuard {
    readonly asked: ProbeSpendRequest[] = [];
    readonly #allow: number;

    constructor(allow: number) {
      this.#allow = allow;
    }

    check(request: ProbeSpendRequest): Result<Unit, AppError> {
      this.asked.push(request);
      return this.asked.length <= this.#allow
        ? ok(UNIT)
        : err(new BudgetExceededError('run', 5, 6));
    }
  }

  function guarded(port: FakeImagePort, budget: ProbeSpendGuard): GenerateStyleProbeUseCase {
    return new GenerateStyleProbeUseCase({
      imageLanes: { paid: port },
      clock: testClock(),
      budget,
    });
  }

  it('touches no provider at all when the first tile is already over the ceiling', async () => {
    const port = new FakeImagePort({ modelRef: PRICED_IMAGE_MODEL });
    const guard = new CountingGuard(0);

    const result = await guarded(port, guard).execute({ bible: LOCKED, lane: 'paid' });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    // The guard's own typed refusal, not a wrapper: a caller has to be able to branch on
    // "budget" and on "not retryable".
    expect(result.error.kind).toBe('budget');
    expect(result.error.retryable).toBe(false);
    expect(port.requests).toHaveLength(0);
    expect(guard.asked).toHaveLength(1);
  });

  it('stops the loop at the ceiling instead of finishing the sheet and reporting it', async () => {
    const port = new FakeImagePort({ modelRef: PRICED_IMAGE_MODEL });
    const guard = new CountingGuard(2);

    const result = await guarded(port, guard).execute({ bible: LOCKED, lane: 'paid' });

    expect(isErr(result)).toBe(true);
    expect(port.requests).toHaveLength(2);
    // Asked three times: twice allowed, once refused. The third question came before the
    // third generation, which is the whole property.
    expect(guard.asked).toHaveLength(3);
    expect(guard.asked.map((entry) => entry.tileIndex)).toEqual([0, 1, 2]);
  });

  it('asks once per tile, before that tile, and never after the last one', async () => {
    const port = new FakeImagePort({ modelRef: PRICED_IMAGE_MODEL });
    const guard = new CountingGuard(Number.POSITIVE_INFINITY);

    const result = await guarded(port, guard).execute({ bible: LOCKED, lane: 'paid' });

    expect(isOk(result)).toBe(true);
    expect(guard.asked).toHaveLength(PROBE_SUBJECTS.length);
    expect(port.requests).toHaveLength(PROBE_SUBJECTS.length);
    for (const entry of guard.asked) {
      expect(entry.lane).toBe('paid');
      expect(entry.images).toBe(1);
    }
  });

  it('shows the guard what the sheet has cost so far, so a ceiling can be cumulative', async () => {
    // A guard that is only ever told "one more image" cannot enforce a per-run ceiling;
    // it has to be able to add the projection to what has already gone.
    const port = new FakeImagePort({ modelRef: PRICED_IMAGE_MODEL });
    const guard = new CountingGuard(Number.POSITIVE_INFINITY);

    const result = await guarded(port, guard).execute({ bible: LOCKED, lane: 'paid' });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const spend = guard.asked.map((entry) => entry.spentNanoUsd);
    expect(spend[0]).toBe(0);
    // Non-decreasing, and the last question knew about every tile but its own.
    expect(spend).toEqual([...spend].sort((left, right) => left - right));
    expect(spend[spend.length - 1]).toBeLessThan(result.value.totalCostNanoUsd);
    expect(spend[spend.length - 1]).toBeGreaterThan(0);
  });

  it('prices each tile from the port it is about to pay, before it pays it', async () => {
    // The estimate and the invoice have to come from one table. Quoting from anywhere
    // else - a number the composition root looked up, a constant in this use-case - is how
    // a guard ends up enforcing a ceiling against a price nobody is actually charged.
    const port = new FakeImagePort({ modelRef: PRICED_IMAGE_MODEL });
    const guard = new CountingGuard(Number.POSITIVE_INFINITY);

    const result = await guarded(port, guard).execute({ bible: LOCKED, lane: 'paid' });
    expect(isOk(result)).toBe(true);

    // One quote per generation, and the quote describes the call that follows it.
    expect(port.quotes).toHaveLength(PROBE_SUBJECTS.length);
    for (const [index, quoted] of port.quotes.entries()) {
      expect(quoted.count).toBe(1);
      expect(quoted.size).toEqual(port.requests[index]?.size);
    }

    for (const asked of guard.asked) {
      expect(asked.quote.kind).toBe('estimated');
      expect(asked.projectedNanoUsd).not.toBeNull();
      expect(asked.projectedNanoUsd ?? 0).toBeGreaterThan(0);
      expect(asked.quote.modelRef).toBe(PRICED_IMAGE_MODEL);
    }
  });

  it('tells the guard a model has no price rather than quoting it at zero', async () => {
    // The most expensive possible way to be wrong is for an unknown price to read as
    // free. `projectedNanoUsd` is null and the guard decides the policy; it is not this
    // use-case's business to assume an unpriced call is affordable.
    const port = new FakeImagePort({ modelRef: 'openrouter:some/unlisted-image-model' });
    const guard = new CountingGuard(Number.POSITIVE_INFINITY);

    const result = await guarded(port, guard).execute({ bible: LOCKED, lane: 'paid' });
    expect(isOk(result)).toBe(true);

    for (const asked of guard.asked) {
      expect(asked.quote.kind).toBe('unpriced');
      expect(asked.projectedNanoUsd).toBeNull();
    }
  });

  it('lets a guard refuse an unpriced model without ever calling the provider', async () => {
    // The policy the null exists to enable, exercised end to end.
    const port = new FakeImagePort({ modelRef: 'openrouter:some/unlisted-image-model' });
    const refuseUnpriced: ProbeSpendGuard = {
      check: (request) =>
        request.projectedNanoUsd === null
          ? err(new BudgetExceededError('project', 0, 0))
          : ok(UNIT),
    };

    const result = await guarded(port, refuseUnpriced).execute({ bible: LOCKED, lane: 'paid' });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.kind).toBe('budget');
    expect(port.requests).toHaveLength(0);
    // Quoting is free; generating is not. The quote happened, the generation did not.
    expect(port.quotes).toHaveLength(1);
  });

  it('quotes the free lane as free, with a reason rather than an empty price', async () => {
    const port = new FakeImagePort({ modelRef: 'comfyui:sd1.5-lcm' });
    const guard = new CountingGuard(Number.POSITIVE_INFINITY);
    const result = await new GenerateStyleProbeUseCase({
      imageLanes: { free: port },
      clock: testClock(),
      budget: guard,
    }).execute({ bible: LOCKED });

    expect(isOk(result)).toBe(true);
    for (const asked of guard.asked) {
      expect(asked.lane).toBe('free');
      expect(asked.quote.kind).toBe('free');
      expect(asked.projectedNanoUsd).toBe(0);
    }
  });

  it('generates exactly as before when no guard is wired, so the free lane is unaffected', async () => {
    const port = new FakeImagePort();
    const result = await subject(port).execute({ bible: LOCKED });

    expect(isOk(result)).toBe(true);
    expect(port.requests).toHaveLength(PROBE_SUBJECTS.length);
  });
});
