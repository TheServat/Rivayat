/**
 * RV-130's tests are about the seam, not about the links.
 *
 * Every stage this orchestrates has its own spec file already, so nothing here
 * re-asserts that connected components finds three blobs. What is asserted is what
 * only exists once they are joined: that nothing is spent before the estimate is
 * approved, that a killed run resumes to the same bytes, that three failures out of
 * five leave two registered, that a cancelled run is not a failed one, and that the
 * money burned on a take the gate refused is still in the ledger.
 *
 * The registry is **real** throughout - `ResolveAssetDemandUseCase` and
 * `RegisterAssetVersionUseCase` over an in-memory repository - because "no asset is
 * generated twice" is the invariant most worth exercising and a stubbed registrar
 * would assert nothing about it. Only the image provider and the vision model are
 * doubles, and both count their calls, because most of the assertions here are
 * negative.
 */

import { describe, expect, it } from 'vitest';
import {
  type AppError,
  BudgetExceededError,
  ProviderError,
  type Result,
  UNIT,
  type Unit,
  ZERO_USD,
  err,
  isErr,
  isOk,
  nanoUsd,
  ok,
  unwrap,
} from '@rv/shared-kernel';
import { type AssetSpec, AssetSpec as AssetSpecSchema, type RunId } from '@rv/contracts';
import {
  FlatRateAssetCostEstimator,
  RegisterAssetVersionUseCase,
  ResolveAssetDemandUseCase,
} from '@rv/asset-registry';
import type {
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageResult,
  VisionScore,
  VisionScoringPort,
  VisionScoringRequest,
  VisionScoringResult,
} from '@rv/providers';
import { toImageArtifact } from '@rv/providers';

import {
  FailingMatting,
  FlatPricer,
  InMemoryAssetRepository,
  InMemoryBlobStore,
  InMemoryCheckpoints,
  RecordingLedger,
} from '../__fixtures__/doubles';
import { specFor, styleBible, testClock, testIds, threeBlobSpec } from '../__fixtures__/builders';
import { NEUTRAL_FIELD, paintSheet } from '../__fixtures__/images';
import { FREE_LANE_POLICY } from '../generate/decomposition-policy';
import { ChainedMatting } from '../matte/chained-matting';
import { ThresholdMatting } from '../matte/threshold-matting';
import { PngRaster } from '../raster/png-raster';
import { PRODUCE_STEPS, stepInputHash } from './checkpoints';
import { resolveLane } from './lanes';
import { GenerateRecord, STEP_RECORD_KIND, readRecord, writeRecord } from './records';
import {
  DEFAULT_CONCURRENCY,
  type ProduceAssetsDeps,
  type ProduceAssetsInput,
  ProduceAssetsUseCase,
} from './produce-assets';

const raster = new PngRaster();
const RUN_ID = 'run_01J0000000000000000000000A' as RunId;
const STYLE = styleBible();

/** The three-blob sheet the lantern spec's attach hints were written against. */
async function lanternSheet(): Promise<Uint8Array> {
  const sheet = await paintSheet(
    120,
    120,
    [
      { x: 10, y: 10, width: 30, height: 30, color: { r: 200, g: 40, b: 40 } },
      { x: 78, y: 10, width: 30, height: 30, color: { r: 40, g: 200, b: 40 } },
      { x: 10, y: 78, width: 30, height: 30, color: { r: 40, g: 40, b: 200 } },
    ],
    NEUTRAL_FIELD,
  );
  return sheet.data;
}

/** One blob in the middle: the single-layer case, for a spec that plans one part. */
async function singleBlobSheet(): Promise<Uint8Array> {
  const sheet = await paintSheet(
    120,
    120,
    [{ x: 30, y: 30, width: 60, height: 60, color: { r: 30, g: 120, b: 60 } }],
    NEUTRAL_FIELD,
  );
  return sheet.data;
}

/**
 * An image port that answers per request and counts what it is doing.
 *
 * `maxInflight` is the only way to observe the concurrency bound: the number of
 * simultaneous calls is not visible from the outside afterwards, so it is recorded as
 * it happens.
 */
class ScriptedImages implements ImageGenerationPort {
  readonly requests: ImageGenerationRequest[] = [];
  maxInflight = 0;
  #inflight = 0;

  constructor(
    private readonly answer: (
      request: ImageGenerationRequest,
      call: number,
    ) => Uint8Array | AppError,
  ) {}

  get callCount(): number {
    return this.requests.length;
  }

  async generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>> {
    this.requests.push(request);
    this.#inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.#inflight);
    // A real generation is not synchronous, and a synchronous double would let every
    // worker finish before the next one starts - which makes any concurrency
    // assertion vacuous.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.#inflight -= 1;

    const answered = this.answer(request, this.requests.length);
    if (!(answered instanceof Uint8Array)) return err(answered);
    return ok({
      modelRef: 'comfyui:dreamshaper_8.safetensors',
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 1, resolution: request.size ?? null },
        latencyMs: 1,
      },
      images: [
        toImageArtifact(
          { mimeType: 'image/png', data: answered },
          { seed: request.seed ?? null, size: request.size ?? null },
        ),
      ],
    });
  }
}

/** A vision model whose verdict changes between calls, so the repair loop is reachable. */
class ScriptedVision implements VisionScoringPort {
  calls = 0;

  constructor(private readonly styleMatchByCall: readonly number[]) {}

  score(request: VisionScoringRequest): Promise<Result<VisionScoringResult, AppError>> {
    this.calls += 1;
    const value = this.styleMatchByCall[this.calls - 1] ?? 0.95;
    const scores: VisionScore[] = request.rubric.map((criterion) => ({
      key: criterion.key,
      score: value,
      reason: 'scripted',
    }));
    return Promise.resolve(
      ok({
        modelRef: 'fake:vision',
        usage: {
          tokens: { input: 1, output: 1, cached: 0, reasoning: 0 },
          images: { count: 1, resolution: null },
          latencyMs: 1,
        },
        scores,
        overall: value,
      }),
    );
  }
}

interface Harness {
  readonly deps: ProduceAssetsDeps;
  readonly repository: InMemoryAssetRepository;
  readonly blobs: InMemoryBlobStore;
  readonly checkpoints: InMemoryCheckpoints;
  readonly images: ScriptedImages;
  readonly ledger: RecordingLedger;
}

function harness(
  images: ScriptedImages,
  overrides: Partial<ProduceAssetsDeps> = {},
  shared: { repository?: InMemoryAssetRepository; blobs?: InMemoryBlobStore } = {},
): Harness {
  const repository = shared.repository ?? new InMemoryAssetRepository();
  const blobs = shared.blobs ?? new InMemoryBlobStore();
  const checkpoints = new InMemoryCheckpoints();
  const ledger = new RecordingLedger();
  const clock = testClock();
  const ids = testIds();

  const deps: ProduceAssetsDeps = {
    resolver: new ResolveAssetDemandUseCase({
      repository,
      estimator: new FlatRateAssetCostEstimator(),
    }),
    registrar: new RegisterAssetVersionUseCase({ repository, ids, clock }),
    budget: { check: () => ok(UNIT) },
    lanes: {
      byLane: {
        'local-parts-sheet': {
          images,
          provider: 'comfyui',
          model: 'dreamshaper_8.safetensors',
        },
      },
    },
    raster,
    matting: new ChainedMatting([new ThresholdMatting()]),
    blobs,
    ids,
    clock,
    checkpoints,
    ledger,
    pricer: new FlatPricer(2_000_000),
    ...overrides,
  };

  return { deps, repository, blobs, checkpoints, images, ledger };
}

function request(specs: readonly AssetSpec[], overrides: Partial<ProduceAssetsInput> = {}) {
  return {
    specs,
    style: STYLE,
    runId: RUN_ID,
    approved: true,
    bake: { clips: ['idle'], settings: { frames: 4 } },
    ...overrides,
  } satisfies ProduceAssetsInput;
}

/** A one-part spec, so the single-layer branch of the router is reachable. */
function slabSpec(): AssetSpec {
  return specFor('rigid-prop', {
    semanticKey: 'prop/stone-slab/plain',
    subjectClass: 'prop',
    label: 'Stone slab',
    description: 'A flat slab of quarried stone.',
    canvas: { width: 120, height: 120 },
    quality: 'draft',
  });
}

function lantern(semanticKey = 'prop/lantern/base'): AssetSpec {
  return threeBlobSpec({ semanticKey });
}

// ── resolve first, spend second ─────────────────────────────────────────────

describe('the estimate comes before the spend', () => {
  it('shows the plan and calls no provider when the spend has not been approved', async () => {
    const images = new ScriptedImages(() => new Uint8Array());
    const { deps } = harness(images);

    const outcome = await new ProduceAssetsUseCase(deps).execute(
      request([lantern()], { approved: false }),
    );

    const produced = unwrap(outcome);
    expect(produced.status).toBe('awaiting-approval');
    expect(produced.plan.missCount).toBe(1);
    expect(produced.plan.totalEstimatedNanoUsd).toBeGreaterThan(0);
    expect(produced.registered).toHaveLength(0);
    // The whole claim: the number was produced without touching the provider.
    expect(images.callCount).toBe(0);
  });

  it('refuses on the budget guard before the first provider call', async () => {
    const images = new ScriptedImages(() => new Uint8Array());
    const { deps } = harness(images, {
      budget: {
        check: (): Result<Unit, BudgetExceededError> =>
          err(new BudgetExceededError('run', 0.5, 1.5)),
      },
    });

    const outcome = await new ProduceAssetsUseCase(deps).execute(request([lantern()]));

    expect(isErr(outcome)).toBe(true);
    expect(isErr(outcome) && outcome.error.code).toBe('BUDGET_EXCEEDED');
    expect(images.callCount).toBe(0);
  });

  it('lists a spec the plan blocked on budget as a failure rather than generating it', async () => {
    const images = new ScriptedImages(() => new Uint8Array());
    const { deps } = harness(images);

    const outcome = await new ProduceAssetsUseCase(deps).execute(
      request([lantern()], { budgetNanoUsd: nanoUsd(1) }),
    );

    const produced = unwrap(outcome);
    expect(produced.failed.map((failure) => failure.step)).toEqual(['plan']);
    expect(images.callCount).toBe(0);
  });

  it('costs nothing and writes nothing the second time the same specs are produced', async () => {
    const sheet = await lanternSheet();
    const repository = new InMemoryAssetRepository();
    const blobs = new InMemoryBlobStore();

    const first = harness(new ScriptedImages(() => sheet), {}, { repository, blobs });
    const firstRun = unwrap(
      await new ProduceAssetsUseCase(first.deps).execute(request([lantern()])),
    );
    expect(firstRun.registered).toHaveLength(1);

    const secondImages = new ScriptedImages(() => sheet);
    const second = harness(secondImages, {}, { repository, blobs });
    const secondRun = unwrap(
      await new ProduceAssetsUseCase(second.deps).execute(request([lantern()])),
    );

    expect(secondRun.reused).toHaveLength(1);
    expect(secondRun.registered).toHaveLength(0);
    expect(secondRun.plan.hitCount).toBe(1);
    // Zero calls, not "zero cost": a hit that still made the call would be free and
    // still wrong.
    expect(secondImages.callCount).toBe(0);
    expect(repository.assetCount).toBe(1);
  });
});

// ── the chain itself ────────────────────────────────────────────────────────

describe('the chain, end to end', () => {
  it('turns one spec into a registered version with parts, a rig, clips and a sheet', async () => {
    const sheet = await lanternSheet();
    const { deps, repository, blobs } = harness(new ScriptedImages(() => sheet));

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(request([lantern()])));

    expect(produced.status).toBe('produced');
    expect(produced.failed).toEqual([]);
    const asset = produced.registered[0];
    expect(asset).toBeDefined();
    if (asset === undefined) return;

    expect(asset.lane).toBe('local-parts-sheet');
    expect(asset.decomposition).toBe('parts-sheet');
    expect(asset.plannedParts).toBe(3);
    expect(asset.foundParts).toBe(3);
    expect(asset.unfilled).toEqual([]);
    expect(asset.parts.map((part) => part.role)).toEqual(['base', 'segment-1', 'segment-2']);
    // The rig is fitted to the parts that came back, by role, with no matching pass.
    expect(asset.rig.bones.map((bone) => bone.role)).toContain('segment-1');
    expect(asset.clips.length).toBeGreaterThan(0);
    expect(asset.sheets).toHaveLength(1);
    expect(asset.sheets[0]?.frameCount).toBe(4);
    expect(asset.matteEngine).toBe('threshold-key');

    // Registered through the real registry, and addressable afterwards.
    expect(repository.assetCount).toBe(1);
    const stored = unwrap(await repository.findById(asset.assetId));
    expect(stored?.versions[0]?.parts).toHaveLength(3);
    expect(stored?.versions[0]?.rig?.id).toBe(asset.rig.id);
    // Every part's pixels are in the content store under the hash the part names.
    for (const part of asset.parts) {
      expect(unwrap(await blobs.has(part.imageHash))).toBe(true);
    }
  });

  it('routes a one-part spec to the single-layer strategy and still rigs it', async () => {
    const sheet = await singleBlobSheet();
    const { deps } = harness(new ScriptedImages(() => sheet));

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(request([slabSpec()])));

    const asset = produced.registered[0];
    expect(asset?.decomposition).toBe('single-layer');
    expect(asset?.parts).toHaveLength(1);
    expect(asset?.rig.bones).toHaveLength(1);
  });

  it('bakes nothing when asked for no clips, and still registers', async () => {
    const sheet = await lanternSheet();
    const { deps } = harness(new ScriptedImages(() => sheet));

    const produced = unwrap(
      await new ProduceAssetsUseCase(deps).execute(request([lantern()], { bake: { clips: [] } })),
    );

    expect(produced.registered[0]?.sheets).toEqual([]);
    expect(produced.registered[0]?.clips.length).toBeGreaterThan(0);
  });

  it("bakes the archetype's whole clip set when asked for 'all'", async () => {
    const sheet = await lanternSheet();
    const { deps } = harness(new ScriptedImages(() => sheet));

    const produced = unwrap(
      await new ProduceAssetsUseCase(deps).execute(
        request([lantern()], { bake: { clips: 'all', settings: { frames: 2 } } }),
      ),
    );

    const asset = produced.registered[0];
    expect(asset?.sheets.length).toBe(asset?.clips.length);
    // Every baked page names the clip it came from, so the version can point at it.
    expect(new Set(asset?.sheets.map((sheet) => sheet.clipName)).size).toBe(asset?.clips.length);
  });
});

// ── partial success ─────────────────────────────────────────────────────────

describe('partial success is the normal case', () => {
  it('registers the good ones and names the bad ones precisely', async () => {
    const sheet = await lanternSheet();
    // A marker rather than the name: the layout clause the composer writes already
    // contains the words "no two components touching", and matching on "two" quietly
    // sabotaged all five.
    const doomed = ['sabotage-two', 'sabotage-four'];
    const images = new ScriptedImages((requested) =>
      doomed.some((marker) => requested.prompt.includes(marker))
        ? new ProviderError({ message: 'the sampler fell over', provider: 'comfyui' })
        : sheet,
    );
    const { deps } = harness(images);

    const specs = ['one', 'two', 'three', 'four', 'five'].map((name) =>
      threeBlobSpec({
        semanticKey: `prop/lantern/${name}`,
        // The marker has to reach the prompt, which is built from the description,
        // so the double can decide per spec.
        description: `A dented brass lantern in three pieces, sabotage-${name}.`,
      }),
    );

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(request(specs)));

    expect(produced.registered).toHaveLength(3);
    expect(produced.failed).toHaveLength(2);
    expect(produced.failed.map((failure) => failure.semanticKey).sort()).toEqual([
      'prop/lantern/four',
      'prop/lantern/two',
    ]);
    expect(produced.failed.every((failure) => failure.step === 'generate')).toBe(true);
    expect(produced.status).toBe('produced');
  });

  it('reports the step a mid-chain failure happened at', async () => {
    const sheet = await lanternSheet();
    const { deps } = harness(new ScriptedImages(() => sheet), {
      matting: new FailingMatting(
        new ProviderError({ message: 'no matte for you', provider: 'comfyui' }),
      ),
    });

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(request([lantern()])));

    expect(produced.registered).toEqual([]);
    expect(produced.failed[0]?.step).toBe('matte');
  });

  it('names the lane when a subject routes somewhere nothing is bound', async () => {
    const images = new ScriptedImages(() => new Uint8Array());
    const { deps } = harness(images);
    const character = threeBlobSpec({
      semanticKey: 'character/kael/base',
      subjectClass: 'character',
    });

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(request([character])));

    expect(produced.failed[0]?.error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(produced.failed[0]?.error.message).toContain('cloud-multi-reference');
    expect(images.callCount).toBe(0);
  });

  it('sends a character down the local lane when the policy says to', async () => {
    const sheet = await lanternSheet();
    const images = new ScriptedImages(() => sheet);
    const { deps } = harness(images);
    const character = threeBlobSpec({
      semanticKey: 'character/kael/base',
      subjectClass: 'character',
    });

    const produced = unwrap(
      await new ProduceAssetsUseCase({
        ...deps,
        lanes: { ...deps.lanes, policy: FREE_LANE_POLICY },
      }).execute(request([character])),
    );

    expect(produced.registered[0]?.lane).toBe('local-parts-sheet');
    expect(images.callCount).toBe(1);
  });
});

// ── resumability ────────────────────────────────────────────────────────────

describe('a killed run resumes', () => {
  it('skips completed steps and produces the same result', async () => {
    const sheet = await lanternSheet();
    const repository = new InMemoryAssetRepository();
    const blobs = new InMemoryBlobStore();
    const checkpoints = new InMemoryCheckpoints();

    // Run one dies at the last step. Everything before it is already checkpointed.
    const firstImages = new ScriptedImages(() => sheet);
    const first = harness(
      firstImages,
      {
        checkpoints,
        registrar: {
          execute: () =>
            Promise.resolve(err(new ProviderError({ message: 'db gone', provider: 'comfyui' }))),
        },
      },
      { repository, blobs },
    );
    const crashed = unwrap(
      await new ProduceAssetsUseCase(first.deps).execute(request([lantern()])),
    );
    expect(crashed.failed[0]?.step).toBe('register');
    expect(firstImages.callCount).toBe(1);

    // What the first run got as far as, read back off its own checkpoints.
    const key = crashed.failed[0]?.key;
    expect(key).toBeDefined();
    if (key === undefined) return;
    const splitCheckpoint = unwrap(
      await checkpoints.read({ runId: RUN_ID, assetKey: key, step: 'split', attempt: 0 }),
    );
    const firstPartHashes = (splitCheckpoint?.outputs ?? [])
      .filter((output) => output.kind === 'asset-part')
      .map((output) => output.contentHash);
    const generateCheckpoint = unwrap(
      await checkpoints.read({ runId: RUN_ID, assetKey: key, step: 'generate', attempt: 0 }),
    );
    const firstSourceHash = (generateCheckpoint?.outputs ?? []).find(
      (output) => output.kind === 'asset-source-image',
    )?.contentHash;
    expect(firstPartHashes).toHaveLength(3);

    // Run two, same checkpoints and same store, with a working registrar.
    const secondImages = new ScriptedImages(() => sheet);
    const second = harness(secondImages, { checkpoints }, { repository, blobs });
    const resumed = unwrap(
      await new ProduceAssetsUseCase(second.deps).execute(request([lantern()])),
    );

    const asset = resumed.registered[0];
    expect(asset).toBeDefined();
    expect(asset?.resumed).toEqual(['generate', 'matte', 'split', 'rig', 'clips', 'bake']);
    // Nothing was regenerated, and the asset is the one the first run had built.
    expect(secondImages.callCount).toBe(0);
    expect(asset?.sourceImageHash).toBe(firstSourceHash);
    expect(asset?.parts.map((part) => part.imageHash)).toEqual(firstPartHashes);
    // The money the first run spent is carried forward rather than counted again.
    expect(resumed.ledger.spentNanoUsd).toBe(0);
    expect(resumed.ledger.resumedNanoUsd).toBeGreaterThan(0);
  });

  it('ignores a checkpoint whose inputs no longer hash the same', async () => {
    const sheet = await lanternSheet();
    const checkpoints = new InMemoryCheckpoints();
    const spec = lantern();
    const { deps } = harness(new ScriptedImages(() => sheet), { checkpoints });

    // A checkpoint that claims generate is done, against inputs that are not these.
    const plan = unwrap(
      await deps.resolver.execute({
        specs: [spec],
        styleBibleId: STYLE.id,
        styleChecksum: STYLE.checksum,
      }),
    );
    const key = plan.resolutions[0]?.key;
    expect(key).toBeDefined();
    if (key === undefined) return;

    unwrap(
      await checkpoints.write(
        { runId: RUN_ID, assetKey: key, step: 'generate', attempt: 0 },
        {
          stage: 'produce',
          inputHash: stepInputHash('generate', key, 0, { something: 'else' }),
          outputs: [],
          jobIds: [],
          costNanoUsd: 0,
          completedAt: '2026-08-23T00:00:00.000Z',
        },
      ),
    );

    const images = new ScriptedImages(() => sheet);
    const rerun = harness(images, { checkpoints });
    const produced = unwrap(await new ProduceAssetsUseCase(rerun.deps).execute(request([spec])));

    // "Already ran" is not enough; "already ran on this" is.
    expect(images.callCount).toBe(1);
    expect(produced.registered[0]?.resumed).toEqual([]);
  });

  it('re-runs a checkpointed step whose record has vanished from the store', async () => {
    const sheet = await lanternSheet();
    const checkpoints = new InMemoryCheckpoints();
    const spec = lantern();

    const first = harness(new ScriptedImages(() => sheet), { checkpoints });
    unwrap(await new ProduceAssetsUseCase(first.deps).execute(request([spec])));

    // Same checkpoints, empty blob store, fresh registry: the checkpoints match but
    // nothing they point at exists any more.
    const images = new ScriptedImages(() => sheet);
    const second = harness(images, { checkpoints }, { blobs: new InMemoryBlobStore() });
    const produced = unwrap(await new ProduceAssetsUseCase(second.deps).execute(request([spec])));

    expect(images.callCount).toBe(1);
    expect(produced.registered).toHaveLength(1);
  });

  it('produces a stage checkpoint the run itself can carry', async () => {
    const sheet = await lanternSheet();
    const { deps } = harness(new ScriptedImages(() => sheet));

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(request([lantern()])));

    expect(produced.checkpoint.stage).toBe('produce');
    expect(produced.checkpoint.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(produced.checkpoint.outputs.map((output) => output.kind)).toEqual(['asset-version']);
  });

  it('carries on when the checkpoint store refuses to write', async () => {
    const sheet = await lanternSheet();
    const checkpoints = new InMemoryCheckpoints();
    checkpoints.failWritesWith(new ProviderError({ message: 'disk full', provider: 'comfyui' }));
    const { deps } = harness(new ScriptedImages(() => sheet), { checkpoints });

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(request([lantern()])));

    // A checkpoint that could not be written costs a re-run next time and nothing else.
    expect(produced.registered).toHaveLength(1);
  });

  it('runs every step when there is no checkpoint store at all', async () => {
    const sheet = await lanternSheet();
    const { deps } = harness(new ScriptedImages(() => sheet));
    const { checkpoints: _dropped, ...withoutStore } = deps;

    const produced = unwrap(
      await new ProduceAssetsUseCase(withoutStore).execute(request([lantern()])),
    );

    expect(produced.registered[0]?.resumed).toEqual([]);
  });
});

// ── concurrency and cancellation ────────────────────────────────────────────

describe('bounded concurrency and cancellation', () => {
  it('never has more generations in flight than the bound allows', async () => {
    const sheet = await lanternSheet();
    const images = new ScriptedImages(() => sheet);
    const { deps } = harness(images);
    const specs = Array.from({ length: 6 }, (_, index) =>
      threeBlobSpec({ semanticKey: `prop/lantern/n${String(index)}` }),
    );

    unwrap(await new ProduceAssetsUseCase(deps).execute(request(specs, { concurrency: 2 })));

    expect(images.maxInflight).toBeLessThanOrEqual(2);
    expect(images.callCount).toBe(6);
    expect(DEFAULT_CONCURRENCY).toBe(2);
  });

  it('stops between steps when the signal aborts, and says cancelled rather than failed', async () => {
    const sheet = await lanternSheet();
    const controller = new AbortController();
    const images = new ScriptedImages((_request, call) => {
      if (call >= 1) controller.abort();
      return sheet;
    });
    const { deps } = harness(images);
    const specs = Array.from({ length: 4 }, (_, index) =>
      threeBlobSpec({ semanticKey: `prop/lantern/c${String(index)}` }),
    );

    const produced = unwrap(
      await new ProduceAssetsUseCase(deps).execute(
        request(specs, { concurrency: 1, signal: controller.signal }),
      ),
    );

    expect(produced.status).toBe('cancelled');
    expect(produced.skipped.length).toBeGreaterThan(0);
    expect(produced.skipped.map((asset) => asset.reason)).toContain('cancelled');
    // The distinction that matters: nothing here is an error.
    expect(produced.failed).toEqual([]);
  });

  it('skips every asset when the signal is already aborted', async () => {
    const images = new ScriptedImages(() => new Uint8Array());
    const { deps } = harness(images);

    const produced = unwrap(
      await new ProduceAssetsUseCase(deps).execute(
        request([lantern()], { signal: AbortSignal.abort() }),
      ),
    );

    expect(produced.status).toBe('cancelled');
    expect(produced.skipped).toHaveLength(1);
    expect(images.callCount).toBe(0);
  });
});

// ── the quality gate and the ledger ─────────────────────────────────────────

describe('metering, including what was thrown away', () => {
  it('registers a take the gate accepted, with its scores', async () => {
    const sheet = await lanternSheet();
    const { deps } = harness(new ScriptedImages(() => sheet), {
      vision: new ScriptedVision([0.95]),
      visionBinding: { provider: 'ollama', model: 'gemma4:26b' },
    });

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(request([lantern()])));

    expect(produced.registered[0]?.scores?.overall).toBeGreaterThan(0.7);
    expect(produced.rejected).toEqual([]);
  });

  it('does not register a rejected take, and still counts what it cost', async () => {
    const sheet = await lanternSheet();
    const { deps, repository, ledger } = harness(new ScriptedImages(() => sheet), {
      vision: new ScriptedVision([0.05]),
      visionBinding: { provider: 'ollama', model: 'gemma4:26b' },
      thresholds: {
        overall: 0.7,
        perCriterion: { 'style-match': 0.6 },
        // No repairs, so the rejection is the first verdict rather than the third.
        maxRepairs: 0,
      },
    });

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(request([lantern()])));

    expect(produced.registered).toEqual([]);
    expect(produced.rejected).toHaveLength(1);
    expect(produced.rejected[0]?.failures.map((failure) => failure.key)).toContain('style-match');
    // An "almost good enough" asset must not quietly enter the library.
    expect(repository.assetCount).toBe(0);
    // And the generation it paid for is still on the books.
    expect(produced.rejected[0]?.costNanoUsd).toBeGreaterThan(0);
    expect(produced.ledger.spentNanoUsd).toBeGreaterThan(0);
    expect(ledger.rows.some((row) => row.task === 'vision-score')).toBe(true);
  });

  it('repairs a failed take within the budget and registers the repaired one', async () => {
    const sheet = await lanternSheet();
    const images = new ScriptedImages(() => sheet);
    const { deps } = harness(images, {
      vision: new ScriptedVision([0.05, 0.95]),
      thresholds: { overall: 0.7, perCriterion: { 'style-match': 0.6 }, maxRepairs: 2 },
    });

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(request([lantern()])));

    expect(produced.registered).toHaveLength(1);
    expect(produced.registered[0]?.attempts).toBe(2);
    expect(images.callCount).toBe(2);
    // The second request carried the gate's instruction, not just a new seed.
    expect(images.requests[1]?.prompt).toContain('Correct the previous attempt');
  });

  it('tallies every step, run and resumed', async () => {
    const sheet = await lanternSheet();
    const checkpoints = new InMemoryCheckpoints();
    const first = harness(new ScriptedImages(() => sheet), { checkpoints });
    const produced = unwrap(
      await new ProduceAssetsUseCase(first.deps).execute(request([lantern()])),
    );

    for (const step of PRODUCE_STEPS) {
      if (step === 'score') continue;
      expect(produced.ledger.byStep[step].ran).toBe(1);
    }
    expect(produced.ledger.byStep.score.ran).toBe(0);
    expect(produced.ledger.estimatedNanoUsd).toBeGreaterThan(0);
    expect(produced.ledger.spentNanoUsd).toBe(2_000_000);
  });

  it('prices every step at zero when no pricer is wired', async () => {
    const sheet = await lanternSheet();
    const { deps } = harness(new ScriptedImages(() => sheet));
    const { pricer: _dropped, ...withoutPricer } = deps;

    const produced = unwrap(
      await new ProduceAssetsUseCase(withoutPricer).execute(request([lantern()])),
    );

    expect(produced.ledger.spentNanoUsd).toBe(ZERO_USD);
    expect(produced.registered).toHaveLength(1);
  });

  it('reports progress for every step it takes', async () => {
    const sheet = await lanternSheet();
    const { deps } = harness(new ScriptedImages(() => sheet));
    const seen: string[] = [];

    unwrap(
      await new ProduceAssetsUseCase(deps).execute(
        request([lantern()], { onProgress: (event) => seen.push(`${event.step}:${event.phase}`) }),
      ),
    );

    expect(seen).toEqual([
      'generate:ran',
      'matte:ran',
      'split:ran',
      'rig:ran',
      'clips:ran',
      'bake:ran',
      'register:ran',
    ]);
  });
});

// ── the two tables, on their own ────────────────────────────────────────────

describe('lane routing', () => {
  const binding = {
    images: new ScriptedImages(() => new Uint8Array()),
    provider: 'comfyui' as const,
    model: 'dreamshaper_8.safetensors',
  };

  it('sends a prop to the local parts-sheet lane', () => {
    const route = resolveLane(lantern(), { byLane: { 'local-parts-sheet': binding } });
    expect(isOk(route) && route.value.lane).toBe('local-parts-sheet');
    expect(isOk(route) && route.value.route.decomposition).toBe('parts-sheet');
  });

  it('sends a character to the cloud multi-reference lane', () => {
    const character = threeBlobSpec({
      semanticKey: 'character/kael/base',
      subjectClass: 'character',
    });
    const route = resolveLane(character, { byLane: { 'cloud-multi-reference': binding } });
    expect(isOk(route) && route.value.lane).toBe('cloud-multi-reference');
    expect(isOk(route) && route.value.route.decomposition).toBe('segmented');
  });

  it('refuses by name rather than substituting a lane that is bound', () => {
    const character = threeBlobSpec({
      semanticKey: 'character/kael/base',
      subjectClass: 'character',
    });
    const route = resolveLane(character, { byLane: { 'local-parts-sheet': binding } });
    expect(isErr(route)).toBe(true);
    expect(isErr(route) && route.error.message).toContain('cloud-multi-reference');
  });
});

describe('step records', () => {
  it('round-trips through the content store', async () => {
    const blobs = new InMemoryBlobStore();
    const record = {
      imageHash: 'a'.repeat(64),
      mimeType: 'image/png',
      lane: 'local-parts-sheet' as const,
      decomposition: 'parts-sheet' as const,
      seed: 7,
      promptHash: 'b'.repeat(64),
      degraded: [],
      costNanoUsd: 12,
    };

    const reference = unwrap(await writeRecord(blobs, 'generate', record));
    expect(reference.kind).toBe(STEP_RECORD_KIND.generate);

    const read = await readRecord(blobs, 'generate', [reference], GenerateRecord);
    expect(read).toEqual(record);
  });

  it('returns null rather than throwing when the record is missing or unreadable', async () => {
    const blobs = new InMemoryBlobStore();
    expect(await readRecord(blobs, 'generate', [], GenerateRecord)).toBeNull();
    expect(
      await readRecord(
        blobs,
        'generate',
        [{ kind: STEP_RECORD_KIND.generate, ref: 'x', contentHash: 'c'.repeat(64) }],
        GenerateRecord,
      ),
    ).toBeNull();

    const junk = unwrap(await blobs.put(new TextEncoder().encode('not json')));
    expect(
      await readRecord(
        blobs,
        'generate',
        [{ kind: STEP_RECORD_KIND.generate, ref: junk.hash, contentHash: junk.hash }],
        GenerateRecord,
      ),
    ).toBeNull();

    const wrong = unwrap(await blobs.put(new TextEncoder().encode('{"nope":1}')));
    expect(
      await readRecord(
        blobs,
        'generate',
        [{ kind: STEP_RECORD_KIND.generate, ref: wrong.hash, contentHash: wrong.hash }],
        GenerateRecord,
      ),
    ).toBeNull();
  });
});

describe('the specs a produce run is given are still specs', () => {
  it('keeps the fixtures parseable, so a schema change breaks here first', () => {
    expect(AssetSpecSchema.safeParse(lantern()).success).toBe(true);
    expect(AssetSpecSchema.safeParse(slabSpec()).success).toBe(true);
  });
});
