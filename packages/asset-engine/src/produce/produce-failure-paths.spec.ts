/**
 * The produce chain when something goes wrong, and the options nobody sets by default.
 *
 * Split from `produce-assets.spec.ts` because the questions are different in kind.
 * That file asks what the orchestrator does; this one asks what it does when the disk
 * fills, the checkpoint table disappears, the model draws two components where the
 * plan wanted three, or the run is cancelled at each of the six points it can be. Each
 * of those has exactly one correct answer - the *asset* fails or stops, the *run* does
 * not - and each is a path nothing else in the suite reaches.
 */

import { describe, expect, it } from 'vitest';
import { ProviderError, ZERO_USD, isOk, nanoUsd, ok, unwrap } from '@rv/shared-kernel';
import { type AssetSpec, type RunId } from '@rv/contracts';
import {
  FlatRateAssetCostEstimator,
  RegisterAssetVersionUseCase,
  ResolveAssetDemandUseCase,
} from '@rv/asset-registry';
import type {
  ImageCostQuote,
  ImageCostRequest,
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageResult,
} from '@rv/providers';
import { toImageArtifact } from '@rv/providers';
import type { AppError, Result } from '@rv/shared-kernel';

import {
  FlakyBlobStore,
  FlatPricer,
  InMemoryAssetRepository,
  InMemoryBlobStore,
  InMemoryCheckpoints,
  RecordingLedger,
  UnreadableCheckpoints,
} from '../__fixtures__/doubles';
import { styleBible, testClock, testIds, threeBlobSpec } from '../__fixtures__/builders';
import { NEUTRAL_FIELD, paintSheet } from '../__fixtures__/images';
import { ChainedMatting } from '../matte/chained-matting';
import { ThresholdMatting } from '../matte/threshold-matting';
import { PngRaster } from '../raster/png-raster';
import type { BlobStore } from '@rv/asset-registry';
import type { ProduceStep } from './checkpoints';
import {
  type ProduceAssetsDeps,
  type ProduceAssetsInput,
  ProduceAssetsUseCase,
} from './produce-assets';

const raster = new PngRaster();
const RUN_ID = 'run_01J0000000000000000000000B' as RunId;
const STYLE = styleBible();

class Images implements ImageGenerationPort {
  readonly requests: ImageGenerationRequest[] = [];

  constructor(private readonly bytes: Uint8Array) {}

  quoteImage(request: ImageCostRequest): ImageCostQuote {
    void request;
    return {
      kind: 'free',
      modelRef: 'comfyui:dreamshaper_8.safetensors',
      nanoUsd: ZERO_USD,
      reason: 'local inference on this machine, metered at zero',
    };
  }

  get callCount(): number {
    return this.requests.length;
  }

  generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>> {
    this.requests.push(request);
    return Promise.resolve(
      ok({
        modelRef: 'comfyui:dreamshaper_8.safetensors',
        usage: {
          tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
          images: { count: 1, resolution: request.size ?? null },
          latencyMs: 1,
        },
        images: [
          toImageArtifact(
            { mimeType: 'image/png', data: this.bytes },
            { seed: request.seed ?? null, size: request.size ?? null },
          ),
        ],
      }),
    );
  }
}

function sheetOf(
  blobs: readonly { x: number; y: number; width: number; height: number }[],
): Promise<{ data: Uint8Array }> {
  return paintSheet(120, 120, blobs, NEUTRAL_FIELD);
}

function threePieces(): Promise<{ data: Uint8Array }> {
  return sheetOf([
    { x: 10, y: 10, width: 30, height: 30 },
    { x: 78, y: 10, width: 30, height: 30 },
    { x: 10, y: 78, width: 30, height: 30 },
  ]);
}

interface Built {
  readonly deps: ProduceAssetsDeps;
  readonly repository: InMemoryAssetRepository;
  readonly images: Images;
}

function build(images: Images, overrides: Partial<ProduceAssetsDeps> = {}): Built {
  const repository = new InMemoryAssetRepository();
  const clock = testClock();
  const ids = testIds();
  const deps: ProduceAssetsDeps = {
    resolver: new ResolveAssetDemandUseCase({
      repository,
      estimator: new FlatRateAssetCostEstimator(),
    }),
    registrar: new RegisterAssetVersionUseCase({ repository, ids, clock }),
    budget: { check: () => ok({}) },
    lanes: {
      byLane: {
        'local-parts-sheet': { images, provider: 'comfyui', model: 'dreamshaper_8.safetensors' },
      },
    },
    raster,
    matting: new ChainedMatting([new ThresholdMatting()]),
    blobs: new InMemoryBlobStore(),
    ids,
    clock,
    checkpoints: new InMemoryCheckpoints(),
    ledger: new RecordingLedger(),
    pricer: new FlatPricer(2_000_000),
    ...overrides,
  };
  return { deps, repository, images };
}

function lantern(): AssetSpec {
  return threeBlobSpec();
}

function ask(overrides: Partial<ProduceAssetsInput> = {}): ProduceAssetsInput {
  return {
    specs: [lantern()],
    style: STYLE,
    runId: RUN_ID,
    approved: true,
    bake: { clips: ['idle'], settings: { frames: 3 } },
    ...overrides,
  };
}

describe('when the infrastructure gives out', () => {
  it('names the step at which the content store stopped accepting writes', async () => {
    const sheet = (await threePieces()).data;
    const reached = new Set<ProduceStep | 'plan'>();

    // Every step writes at least one blob, so refusing the Nth write walks each
    // step's failure path in turn. The invariant is uniform: the asset fails, the run
    // does not, and the failure says where.
    for (let limit = 0; limit < 20; limit += 1) {
      const blobs: BlobStore = new FlakyBlobStore({ failPutAfter: limit });
      const { deps } = build(new Images(sheet), { blobs });
      const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(ask()));
      if (produced.registered.length > 0) continue;
      expect(produced.failed).toHaveLength(1);
      const failure = produced.failed[0];
      if (failure !== undefined) reached.add(failure.step);
    }

    // Not an exhaustive list on purpose: what matters is that several *different*
    // steps reported themselves rather than one opaque error at the end.
    expect(reached.size).toBeGreaterThanOrEqual(4);
    expect(reached.has('generate')).toBe(true);
    expect(reached.has('register')).toBe(true);
  });

  it('names the step at which the content store stopped answering reads', async () => {
    const sheet = (await threePieces()).data;
    const reached = new Set<ProduceStep | 'plan'>();

    for (let limit = 0; limit < 10; limit += 1) {
      const blobs: BlobStore = new FlakyBlobStore({ failGetAfter: limit });
      const { deps } = build(new Images(sheet), { blobs });
      const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(ask()));
      if (produced.registered.length > 0) continue;
      const failure = produced.failed[0];
      if (failure !== undefined) reached.add(failure.step);
    }

    expect(reached.has('matte')).toBe(true);
  });

  it('fails the asset, not the run, when the checkpoint store cannot be read', async () => {
    const sheet = (await threePieces()).data;
    const { deps } = build(new Images(sheet), {
      checkpoints: new UnreadableCheckpoints(
        new ProviderError({ message: 'checkpoint table is gone', provider: 'comfyui' }),
      ),
    });

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(ask()));

    expect(produced.failed[0]?.step).toBe('generate');
    expect(produced.registered).toEqual([]);
  });

  it('refuses to rig when a required part never came back', async () => {
    // Two components where the plan wanted three. The splitter reports the gap and the
    // rig refuses rather than binding a bone to nothing.
    const sparse = await sheetOf([
      { x: 10, y: 10, width: 30, height: 30 },
      { x: 78, y: 10, width: 30, height: 30 },
    ]);
    const { deps } = build(new Images(sparse.data));

    const produced = unwrap(await new ProduceAssetsUseCase(deps).execute(ask()));

    expect(produced.failed[0]?.step).toBe('rig');
    expect(produced.failed[0]?.error.code).toBe('VALIDATION_FAILED');
  });

  it('stops at whichever step the signal aborts after', async () => {
    const sheet = (await threePieces()).data;
    const steps: readonly ProduceStep[] = ['generate', 'matte', 'split', 'rig', 'clips', 'bake'];

    for (const step of steps) {
      const controller = new AbortController();
      const { deps } = build(new Images(sheet));
      const produced = unwrap(
        await new ProduceAssetsUseCase(deps).execute(
          ask({
            signal: controller.signal,
            onProgress: (event) => {
              if (event.step === step) controller.abort();
            },
          }),
        ),
      );

      expect(produced.status).toBe('cancelled');
      expect(produced.skipped).toHaveLength(1);
      expect(produced.failed).toEqual([]);
      expect(produced.registered).toEqual([]);
    }
  });
});

describe('the optional halves of the request', () => {
  it('keeps a variant on its own dedup key', async () => {
    const sheet = (await threePieces()).data;
    const { deps, repository, images } = build(new Images(sheet));

    const winter = unwrap(
      await new ProduceAssetsUseCase(deps).execute(
        ask({
          variantKey: 'winter',
          confirmationThresholdNanoUsd: nanoUsd(1_000_000_000),
        }),
      ),
    );
    const base = unwrap(await new ProduceAssetsUseCase(deps).execute(ask()));

    expect(winter.registered).toHaveLength(1);
    expect(base.registered).toHaveLength(1);
    expect(winter.registered[0]?.key).not.toBe(base.registered[0]?.key);
    expect(repository.assetCount).toBe(2);
    expect(images.callCount).toBe(2);
  });

  it('uses the default bake plan and the lane background hint when none are given', async () => {
    const sheet = (await threePieces()).data;
    const images = new Images(sheet);
    const { deps } = build(images, {
      lanes: {
        byLane: {
          'local-parts-sheet': {
            images,
            provider: 'comfyui',
            model: 'dreamshaper_8.safetensors',
            // The lane declares the field its prompts ask for, so the key does not
            // have to sample it out of the corners.
            backgroundHint: NEUTRAL_FIELD,
          },
        },
      },
    });

    const produced = unwrap(
      await new ProduceAssetsUseCase(deps).execute({
        specs: [lantern()],
        style: STYLE,
        runId: RUN_ID,
        approved: true,
      }),
    );

    const asset = produced.registered[0];
    expect(asset?.sheets).toHaveLength(1);
    expect(asset?.sheets[0]?.clipName).toBe('idle');
    // A full loop of the clip, not the three frames the other tests ask for.
    expect(asset?.sheets[0]?.frameCount).toBeGreaterThan(3);
  });

  it("shapes the prompt for the lane's text encoder", async () => {
    const sheet = (await threePieces()).data;
    const clipImages = new Images(sheet);
    const longImages = new Images(sheet);

    const clip = build(clipImages, {
      lanes: {
        byLane: {
          'local-parts-sheet': {
            images: clipImages,
            provider: 'comfyui',
            model: 'dreamshaper_8.safetensors',
            promptEncoder: 'clip-77',
          },
        },
      },
    });
    unwrap(await new ProduceAssetsUseCase(clip.deps).execute(ask()));

    const long = build(longImages);
    unwrap(await new ProduceAssetsUseCase(long.deps).execute(ask()));

    // Measured on the real card: with the layout instruction behind a thousand
    // characters of style adjectives, SD 1.5 draws one assembled object.
    expect(clipImages.requests[0]?.prompt.startsWith('Draw a parts sheet')).toBe(true);
    expect(longImages.requests[0]?.prompt.startsWith('Draw a parts sheet')).toBe(false);
    // Different pixels for the same key, so the two must not share a checkpoint.
    expect(clipImages.requests[0]?.prompt).not.toBe(longImages.requests[0]?.prompt);
  });

  it('runs with no ledger and no pricer at all', async () => {
    const sheet = (await threePieces()).data;
    const { deps } = build(new Images(sheet));
    const { ledger: _ledger, pricer: _pricer, ...bare } = deps;

    const produced = unwrap(await new ProduceAssetsUseCase(bare).execute(ask()));

    expect(produced.registered).toHaveLength(1);
    expect(produced.ledger.spentNanoUsd).toBe(0);
  });

  it('reuses a key that appeared between the plan and the generation', async () => {
    const sheet = (await threePieces()).data;
    const { deps, repository, images } = build(new Images(sheet));

    // Fill the library first, through the ordinary path.
    unwrap(await new ProduceAssetsUseCase(deps).execute(ask()));
    expect(repository.assetCount).toBe(1);

    // Now a batch plan that has not noticed - exactly the state one worker's plan is
    // in when another registers the same key underneath it. The per-asset resolve
    // inside `GenerateAssetVersionUseCase` is what catches it, which is why that
    // second call to the registry is not redundant.
    const realPlanner = deps.resolver;
    let calls = 0;
    const stale = new ProduceAssetsUseCase({
      ...deps,
      // A fresh checkpoint store, because this is a *different* worker: with the first
      // run's checkpoints it would resume straight past the generate step and never
      // consult the registry at all.
      checkpoints: new InMemoryCheckpoints(),
      resolver: {
        execute: async (input) => {
          calls += 1;
          const planned = await realPlanner.execute(input);
          if (calls > 1 || !isOk(planned)) return planned;
          return ok({
            ...planned.value,
            hitCount: 0,
            missCount: planned.value.resolutions.length,
            resolutions: planned.value.resolutions.map((resolution) => ({
              ...resolution,
              outcome: 'miss' as const,
              reason: undefined,
            })),
          });
        },
      },
    });

    const callsBefore = images.callCount;
    const produced = unwrap(await stale.execute(ask()));

    expect(produced.reused).toHaveLength(1);
    expect(produced.registered).toEqual([]);
    expect(images.callCount).toBe(callsBefore);
    expect(repository.assetCount).toBe(1);
  });
});
