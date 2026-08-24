/**
 * Hand-written doubles for every port this package calls out through.
 *
 * Each one counts its calls, because most of the assertions that matter here are
 * negative: the image port received **zero** calls on a cache hit, the registry was
 * never written to by a rejected take, the budget guard ran *before* the provider. A
 * spy that cannot be interrogated proves none of those.
 */

import {
  type AppError,
  type BudgetExceededError,
  ConflictError,
  type NanoUsd,
  NotFoundError,
  type Result,
  UNIT,
  type Unit,
  ZERO_USD,
  err,
  nanoUsd,
  ok,
  sha256,
} from '@rv/shared-kernel';
import type {
  Asset,
  AssetDemandPlan,
  AssetId,
  AssetKey,
  AssetSpec,
  IsoInstant,
  ProviderKind,
  Sha256Hex,
  Slug,
  StageCheckpoint,
  StyleBibleId,
} from '@rv/contracts';
import type {
  AppendVersionOptions,
  AssetIdentityDraft,
  AssetRepository,
  AssetSearchRecord,
  AssetVersionDraft,
  BlobPutResult,
  BlobStore,
  NewAssetVersion,
  StoredAssetVersion,
} from '@rv/asset-registry';
import type {
  ImageCostQuote,
  ImageCostRequest,
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageResult,
  PartsSheetPort,
  PartsSheetRequest,
  ProviderUsage,
  VisionScore,
  VisionScoringPort,
  VisionScoringRequest,
  VisionScoringResult,
} from '@rv/providers';
import { toImageArtifact } from '@rv/providers';

import type {
  MatteRequest,
  MatteResult,
  MattingPort,
  SegmentationModel,
} from '../ports/matting-port';
import type { RgbaImage } from '../ports/raster-port';
import type { BudgetCheckPort, DemandResolverPort } from '../generate/generate-asset-version';
import {
  PRODUCE_STEPS,
  type ProduceCheckpointKey,
  type ProduceCheckpointStore,
  type ProduceStep,
  checkpointKeyString,
} from '../produce/checkpoints';
import type { ProduceLedgerPort, UsagePricerPort } from '../produce/produce-assets';

// ── blob store ──────────────────────────────────────────────────────────────

export class InMemoryBlobStore implements BlobStore {
  readonly #bytes = new Map<string, Uint8Array>();
  readonly puts: Sha256Hex[] = [];

  put(bytes: Uint8Array): Promise<Result<BlobPutResult, AppError>> {
    const hash = sha256(bytes);
    const created = !this.#bytes.has(hash);
    this.#bytes.set(hash, Uint8Array.from(bytes));
    this.puts.push(hash);
    return Promise.resolve(ok({ hash, byteSize: bytes.length, created }));
  }

  get(hash: Sha256Hex): Promise<Result<Uint8Array, AppError>> {
    const found = this.#bytes.get(hash);
    if (found === undefined) return Promise.resolve(err(new NotFoundError('blob', hash)));
    return Promise.resolve(ok(found));
  }

  has(hash: Sha256Hex): Promise<Result<boolean, AppError>> {
    return Promise.resolve(ok(this.#bytes.has(hash)));
  }

  path(hash: Sha256Hex): string {
    return `memory://${hash}`;
  }

  link(hash: Sha256Hex, name: string): Promise<Result<string, AppError>> {
    return Promise.resolve(ok(`memory://${hash}/${name}`));
  }

  /** Number of distinct blobs. Proves two identical clips shared one file. */
  get size(): number {
    return this.#bytes.size;
  }
}

// ── image generation ────────────────────────────────────────────────────────

export class FakeImagePort implements ImageGenerationPort {
  readonly requests: ImageGenerationRequest[] = [];
  #failure: AppError | null = null;
  #images = 1;

  constructor(private readonly bytes: Uint8Array = Uint8Array.from([1, 2, 3, 4])) {}

  failWith(error: AppError): void {
    this.#failure = error;
  }

  /** Lets the "provider returned nothing" branch be reached without a real provider. */
  returnNoImages(): void {
    this.#images = 0;
  }

  get callCount(): number {
    return this.requests.length;
  }

  /**
   * Quotes whatever the test told it to, defaulting to free.
   *
   * Settable because "the guard refused an unpriced model" is a branch that only exists
   * if a double can produce one.
   */
  quote: ImageCostQuote = {
    kind: 'free',
    modelRef: 'fake:image',
    nanoUsd: ZERO_USD,
    reason: 'a test double spends nothing',
  };

  quoteImage(request: ImageCostRequest): ImageCostQuote {
    this.quotes.push(request);
    return this.quote;
  }

  readonly quotes: ImageCostRequest[] = [];

  generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>> {
    this.requests.push(request);
    if (this.#failure !== null) return Promise.resolve(err(this.#failure));
    return Promise.resolve(
      ok({
        modelRef: 'fake:image',
        usage: {
          tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
          images: { count: this.#images, resolution: request.size ?? null },
          latencyMs: 1,
        },
        images:
          this.#images === 0
            ? []
            : [
                toImageArtifact(
                  { mimeType: 'image/png', data: this.bytes },
                  { seed: request.seed ?? null },
                ),
              ],
      }),
    );
  }
}

/**
 * An image port that also serves the parts-sheet graph.
 *
 * Extends the plain fake rather than replacing it, because the property under test is
 * that the *same* caller reaches a different method when - and only when - the port
 * declares it. `servesPartsSheet` is settable so the "declared but not available"
 * branch is reachable, which is the branch a deployment without the workflow file hits.
 */
export class FakePartsSheetPort extends FakeImagePort implements PartsSheetPort {
  readonly sheetRequests: PartsSheetRequest[] = [];
  servesPartsSheet = true;

  generatePartsSheet(request: PartsSheetRequest): Promise<Result<ImageResult, AppError>> {
    this.sheetRequests.push(request);
    return this.generateImage({
      prompt: request.subject,
      ...(request.negativePrompt === undefined ? {} : { negativePrompt: request.negativePrompt }),
      ...(request.size === undefined ? {} : { size: request.size }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    });
  }
}

// ── budget ──────────────────────────────────────────────────────────────────

export class FakeBudget implements BudgetCheckPort {
  readonly checks: NanoUsd[] = [];
  #error: BudgetExceededError | null = null;

  refuseWith(error: BudgetExceededError): void {
    this.#error = error;
  }

  check(request: { runId: string; projectedNanoUsd: NanoUsd }): Result<Unit, BudgetExceededError> {
    this.checks.push(request.projectedNanoUsd);
    return this.#error === null ? ok(UNIT) : err(this.#error);
  }
}

// ── registry demand plan ────────────────────────────────────────────────────

export class FakeResolver implements DemandResolverPort {
  readonly calls: { specs: readonly AssetSpec[]; styleChecksum: Sha256Hex }[] = [];
  #plan: AssetDemandPlan | null = null;
  #error: AppError | null = null;

  planFor(plan: AssetDemandPlan): void {
    this.#plan = plan;
  }

  failWith(error: AppError): void {
    this.#error = error;
  }

  execute(input: {
    specs: readonly AssetSpec[];
    styleBibleId: StyleBibleId;
    styleChecksum: Sha256Hex;
    variantKey?: Slug;
  }): Promise<Result<AssetDemandPlan, AppError>> {
    this.calls.push({ specs: input.specs, styleChecksum: input.styleChecksum });
    if (this.#error !== null) return Promise.resolve(err(this.#error));
    if (this.#plan !== null) return Promise.resolve(ok(this.#plan));
    const spec = input.specs[0];
    return Promise.resolve(
      ok({
        resolutions:
          spec === undefined
            ? []
            : [
                {
                  key: sha256(
                    spec.semanticKey,
                  ) as unknown as AssetDemandPlan['resolutions'][number]['key'],
                  spec,
                  outcome: 'miss' as const,
                  styleBibleId: input.styleBibleId,
                  estimatedCostNanoUsd: 33_600_000,
                },
              ],
        hitCount: 0,
        missCount: 1,
        totalEstimatedNanoUsd: 33_600_000,
        requiresConfirmation: true,
      }),
    );
  }
}

// ── vision scoring ──────────────────────────────────────────────────────────

export class FakeVisionPort implements VisionScoringPort {
  readonly requests: VisionScoringRequest[] = [];
  #scores: Readonly<Record<string, number>> = {};
  #error: AppError | null = null;

  constructor(scores: Readonly<Record<string, number>> = {}) {
    this.#scores = scores;
  }

  setScores(scores: Readonly<Record<string, number>>): void {
    this.#scores = scores;
  }

  failWith(error: AppError): void {
    this.#error = error;
  }

  score(request: VisionScoringRequest): Promise<Result<VisionScoringResult, AppError>> {
    this.requests.push(request);
    if (this.#error !== null) return Promise.resolve(err(this.#error));
    const scores: VisionScore[] = request.rubric.map((criterion) => ({
      key: criterion.key,
      score: this.#scores[criterion.key] ?? 0.9,
      reason: 'fixture',
    }));
    const weight = request.rubric.reduce((sum, criterion) => sum + (criterion.weight ?? 1), 0);
    const weighted = request.rubric.reduce(
      (sum, criterion) => sum + (this.#scores[criterion.key] ?? 0.9) * (criterion.weight ?? 1),
      0,
    );
    return Promise.resolve(
      ok({
        modelRef: 'fake:vision',
        usage: {
          tokens: { input: 10, output: 10, cached: 0, reasoning: 0 },
          images: { count: 0, resolution: null },
          latencyMs: 1,
        },
        scores,
        overall: weight === 0 ? 0 : weighted / weight,
      }),
    );
  }
}

// ── matting ─────────────────────────────────────────────────────────────────

/** A matting port whose answer is dictated by the test. */
export class ScriptedMatting implements MattingPort {
  readonly calls: MatteRequest[] = [];

  constructor(
    readonly engine: string,
    private readonly answer: (request: MatteRequest) => Result<RgbaImage, AppError>,
  ) {}

  matte(request: MatteRequest): Promise<Result<MatteResult, AppError>> {
    this.calls.push(request);
    const answered = this.answer(request);
    if (!answered.ok) return Promise.resolve(err(answered.error));
    return Promise.resolve(ok({ image: answered.value, engine: this.engine, fallbacks: [] }));
  }
}

/** A segmentation model that returns a mask the test computed itself. */
export class ScriptedSegmentation implements SegmentationModel {
  constructor(
    readonly id: string,
    private readonly mask: (image: RgbaImage) => Result<Uint8Array, AppError>,
  ) {}

  segment(image: RgbaImage): Promise<Result<Uint8Array, AppError>> {
    return Promise.resolve(this.mask(image));
  }
}

export const NO_COST: NanoUsd = ZERO_USD;

// ── produce: a registry that actually stores ────────────────────────────────

/**
 * An `AssetRepository` that really keeps what it is given.
 *
 * `FakeAssetRepository` in `@rv/asset-registry` deliberately refuses to succeed at a
 * write, because its job is to count calls. RV-130 needs the opposite: the produce
 * chain is tested against the **real** `ResolveAssetDemandUseCase` and
 * `RegisterAssetVersionUseCase`, so that "no asset is generated twice" is exercised
 * rather than mocked away - a second run over the same specs must come back as cache
 * hits, and it can only do that against a store that remembers.
 */
export class InMemoryAssetRepository implements AssetRepository {
  readonly calls: string[] = [];
  readonly #byKey = new Map<AssetKey, Asset>();
  readonly #byId = new Map<AssetId, Asset>();

  get wrote(): boolean {
    return this.calls.some((call) => call === 'create' || call === 'appendVersion');
  }

  get assetCount(): number {
    return this.#byKey.size;
  }

  findByKey(key: AssetKey): Promise<Result<Asset | null, AppError>> {
    this.calls.push('findByKey');
    return Promise.resolve(ok(this.#byKey.get(key) ?? null));
  }

  findManyByKeys(
    keys: readonly AssetKey[],
  ): Promise<Result<ReadonlyMap<AssetKey, Asset>, AppError>> {
    this.calls.push('findManyByKeys');
    const found = new Map<AssetKey, Asset>();
    for (const key of keys) {
      const asset = this.#byKey.get(key);
      if (asset !== undefined) found.set(key, asset);
    }
    return Promise.resolve(ok(found));
  }

  findById(id: AssetId): Promise<Result<Asset | null, AppError>> {
    this.calls.push('findById');
    return Promise.resolve(ok(this.#byId.get(id) ?? null));
  }

  create(
    identity: AssetIdentityDraft,
    firstVersion: NewAssetVersion,
    now: IsoInstant,
  ): Promise<Result<StoredAssetVersion, AppError>> {
    this.calls.push('create');
    if (this.#byKey.has(identity.key)) {
      return Promise.resolve(err(new ConflictError({ message: 'key exists' })));
    }
    const version = { ...firstVersion, assetId: identity.id, ordinal: 1 };
    const asset: Asset = {
      id: identity.id,
      key: identity.key,
      semanticKey: identity.semanticKey,
      archetype: identity.archetype,
      label: identity.label,
      description: identity.description,
      tags: [...identity.tags],
      versions: [version],
      currentVersionId: version.id,
      createdAt: now,
      updatedAt: now,
    };
    this.#byKey.set(asset.key, asset);
    this.#byId.set(asset.id, asset);
    return Promise.resolve(ok({ asset, version }));
  }

  appendVersion(
    draft: AssetVersionDraft,
    options: AppendVersionOptions,
    now: IsoInstant,
  ): Promise<Result<StoredAssetVersion, AppError>> {
    this.calls.push('appendVersion');
    const existing = this.#byId.get(draft.assetId);
    if (existing === undefined) {
      return Promise.resolve(err(new NotFoundError('asset', draft.assetId)));
    }
    // Assigned here rather than read-then-written by the caller: the ordinal is the
    // repository's, inside the same step as the insert.
    const version = { ...draft, ordinal: existing.versions.length + 1 };
    const asset: Asset = {
      ...existing,
      versions: [...existing.versions, version],
      currentVersionId: options.makeCurrent ? version.id : existing.currentVersionId,
      updatedAt: now,
    };
    this.#byKey.set(asset.key, asset);
    this.#byId.set(asset.id, asset);
    return Promise.resolve(ok({ asset, version }));
  }

  setCurrentVersion(): Promise<Result<Unit, AppError>> {
    this.calls.push('setCurrentVersion');
    return Promise.resolve(ok(UNIT));
  }

  listSearchRecords(): Promise<Result<readonly AssetSearchRecord[], AppError>> {
    this.calls.push('listSearchRecords');
    return Promise.resolve(ok([]));
  }

  saveEmbedding(): Promise<Result<Unit, AppError>> {
    this.calls.push('saveEmbedding');
    return Promise.resolve(ok(UNIT));
  }
}

/**
 * Checkpoints in a Map, plus the two things a resumability test needs.
 *
 * `forgetFrom` is the interesting one: it drops every checkpoint at or after a step,
 * which is what killing a process mid-asset actually leaves behind.
 */
export class InMemoryCheckpoints implements ProduceCheckpointStore {
  readonly writes: string[] = [];
  readonly #rows = new Map<string, StageCheckpoint>();
  #writeFailure: AppError | null = null;

  failWritesWith(error: AppError): void {
    this.#writeFailure = error;
  }

  read(key: ProduceCheckpointKey): Promise<Result<StageCheckpoint | null, AppError>> {
    return Promise.resolve(ok(this.#rows.get(checkpointKeyString(key)) ?? null));
  }

  write(key: ProduceCheckpointKey, checkpoint: StageCheckpoint): Promise<Result<Unit, AppError>> {
    if (this.#writeFailure !== null) return Promise.resolve(err(this.#writeFailure));
    this.writes.push(`${key.step}:${key.attempt}`);
    this.#rows.set(checkpointKeyString(key), checkpoint);
    return Promise.resolve(ok(UNIT));
  }

  /** Simulates a kill: everything from `step` onward is gone. */
  forgetFrom(step: ProduceStep): void {
    const from = PRODUCE_STEPS.indexOf(step);
    for (const key of [...this.#rows.keys()]) {
      const parts = key.split('/');
      const name = parts[2] as ProduceStep | undefined;
      if (name !== undefined && PRODUCE_STEPS.indexOf(name) >= from) this.#rows.delete(key);
    }
  }

  get size(): number {
    return this.#rows.size;
  }
}

/** A matting port that always fails, so the chain's failure path is reachable. */
export class FailingMatting implements MattingPort {
  readonly engine = 'always-fails';

  constructor(private readonly error: AppError) {}

  matte(): Promise<Result<MatteResult, AppError>> {
    return Promise.resolve(err(this.error));
  }
}

/** Prices every image at a flat rate, so the ledger has a number to attribute. */
export class FlatPricer implements UsagePricerPort {
  constructor(private readonly perImageNanoUsd: number) {}

  price(_provider: ProviderKind, _model: string, usage: ProviderUsage): NanoUsd {
    return nanoUsd(usage.images.count * this.perImageNanoUsd);
  }
}

/** A ledger that keeps its rows, so "was the rejected take metered" is answerable. */
export class RecordingLedger implements ProduceLedgerPort {
  readonly rows: { task: string; outcome: string; model: string }[] = [];

  record(input: { task: string; outcome: string; model: string }): unknown {
    this.rows.push({ task: input.task, outcome: input.outcome, model: input.model });
    return undefined;
  }
}

/**
 * A content store that stops working part-way through a run.
 *
 * A disk filling up mid-asset is the failure the produce chain most needs to survive
 * *as a named failure* rather than as a crash, and every step writes to the store, so
 * counting calls and refusing the Nth is enough to reach every one of those paths.
 */
export class FlakyBlobStore implements BlobStore {
  readonly #inner = new InMemoryBlobStore();
  #puts = 0;
  #gets = 0;

  constructor(
    private readonly limits: { readonly failPutAfter?: number; readonly failGetAfter?: number },
  ) {}

  put(bytes: Uint8Array): Promise<Result<BlobPutResult, AppError>> {
    this.#puts += 1;
    if (this.limits.failPutAfter !== undefined && this.#puts > this.limits.failPutAfter) {
      return Promise.resolve(err(new ConflictError({ message: 'no space left on device' })));
    }
    return this.#inner.put(bytes);
  }

  get(hash: Sha256Hex): Promise<Result<Uint8Array, AppError>> {
    this.#gets += 1;
    if (this.limits.failGetAfter !== undefined && this.#gets > this.limits.failGetAfter) {
      return Promise.resolve(err(new NotFoundError('blob', hash)));
    }
    return this.#inner.get(hash);
  }

  has(hash: Sha256Hex): Promise<Result<boolean, AppError>> {
    return this.#inner.has(hash);
  }

  path(hash: Sha256Hex): string {
    return this.#inner.path(hash);
  }

  link(hash: Sha256Hex, name: string): Promise<Result<string, AppError>> {
    return this.#inner.link(hash, name);
  }
}

/** A checkpoint store whose reads fail, so the resume path's error branch is reachable. */
export class UnreadableCheckpoints implements ProduceCheckpointStore {
  constructor(private readonly error: AppError) {}

  read(): Promise<Result<StageCheckpoint | null, AppError>> {
    return Promise.resolve(err(this.error));
  }

  write(): Promise<Result<Unit, AppError>> {
    return Promise.resolve(ok(UNIT));
  }
}
