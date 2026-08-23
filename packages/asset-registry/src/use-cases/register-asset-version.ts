/**
 * The only door into the asset library.
 *
 * Everything that produces imagery lands here, and the door is deliberately hard to
 * open twice: registering against a key that already exists is a **conflict** unless
 * the caller presents a `RegenerateIntent`. That is non-negotiable #2 expressed as
 * control flow rather than as a comment - there is no code path that adds a second
 * take by accident, and none at all that overwrites the first.
 *
 * Ordinals are assigned by the repository inside the insert transaction, not read and
 * incremented here: two workers finishing takes at the same moment must get 2 and 3,
 * never 2 and 2.
 */

import {
  type Clock,
  ConflictError,
  type Result,
  ValidationError,
  err,
  isErr,
  ok,
  toIso,
} from '@rv/shared-kernel';
import {
  type Asset,
  type AssetKey,
  type AssetKeyParts,
  type AssetSpec,
  type AssetVersion,
  type Ids,
  RegenerateIntent,
  type Sha256Hex,
  type Slug,
  type StyleBibleId,
} from '@rv/contracts';

import { deriveAssetKey } from '../asset-key';
import type { AssetRepository, NewAssetVersion } from '../ports/index';

export interface RegisterAssetVersionInput {
  readonly spec: AssetSpec;
  readonly styleBibleId: StyleBibleId;
  readonly styleChecksum: Sha256Hex;
  readonly variantKey?: Slug;
  /** The finished take. Its `ordinal` and `assetId` are the registry's to decide. */
  readonly version: NewAssetVersion;
  /**
   * Required to add a take to an asset that already exists. Absent is the normal case
   * and means "this is the first version"; absent against an existing key is refused.
   */
  readonly intent?: RegenerateIntent;
  /** Whether the new take becomes the served one. Defaults to true. */
  readonly makeCurrent?: boolean;
}

export interface RegisterAssetVersionOutput {
  readonly asset: Asset;
  readonly version: AssetVersion;
  readonly key: AssetKey;
  readonly keyParts: AssetKeyParts;
  /** True when this call brought the asset into existence rather than adding a take. */
  readonly createdAsset: boolean;
}

export interface RegisterAssetVersionDeps {
  readonly repository: AssetRepository;
  readonly ids: Ids;
  readonly clock: Clock;
}

export class RegisterAssetVersionUseCase {
  readonly #repository: AssetRepository;
  readonly #ids: Ids;
  readonly #clock: Clock;

  constructor(deps: RegisterAssetVersionDeps) {
    this.#repository = deps.repository;
    this.#ids = deps.ids;
    this.#clock = deps.clock;
  }

  async execute(input: RegisterAssetVersionInput): Promise<Result<RegisterAssetVersionOutput>> {
    const context =
      input.variantKey === undefined
        ? { styleChecksum: input.styleChecksum }
        : { styleChecksum: input.styleChecksum, variantKey: input.variantKey };
    const { key, keyParts } = deriveAssetKey(input.spec, context);

    const existing = await this.#repository.findByKey(key);
    if (isErr(existing)) return existing;

    const now = toIso(this.#clock.now());

    if (existing.value === null) {
      const created = await this.#repository.create(
        {
          id: this.#ids.asset(),
          key,
          keyParts,
          semanticKey: input.spec.semanticKey,
          archetype: input.spec.archetype,
          label: input.spec.label,
          description: input.spec.description,
          tags: input.spec.tags,
        },
        input.version,
        now,
      );
      if (isErr(created)) return created;
      return ok({ ...created.value, key, keyParts, createdAsset: true });
    }

    if (input.intent === undefined) {
      return err(
        new ConflictError({
          message:
            'An asset is already registered under this dedup key. A second take requires an explicit RegenerateIntent.',
          context: { assetKey: key, assetId: existing.value.id, ...keyParts },
        }),
      );
    }

    // Parse rather than trust: `keepPrevious` is `literal(true)`, so an attempt to turn
    // regeneration destructive fails here instead of reaching the repository.
    const intent = RegenerateIntent.safeParse(input.intent);
    if (!intent.success) {
      return err(
        new ValidationError({
          message: 'RegenerateIntent is not valid; refusing to add a take.',
          context: { assetKey: key },
          issues: intent.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        }),
      );
    }

    const appended = await this.#repository.appendVersion(
      { ...input.version, assetId: existing.value.id },
      { makeCurrent: input.makeCurrent ?? true },
      now,
    );
    if (isErr(appended)) return appended;
    return ok({ ...appended.value, key, keyParts, createdAsset: false });
  }
}
