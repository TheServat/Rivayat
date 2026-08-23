/**
 * "Give me another take" - the only sanctioned way to spend money on something we
 * already have.
 *
 * Three things make it safe rather than merely possible:
 *
 * - The intent is a **parameter, not a flag**: `RegenerateIntent` is required by the
 *   type and re-parsed at runtime, so `keepPrevious: false` fails before any IO.
 * - It appends. The previous versions keep their ordinals and their rows, and the
 *   use-case checks that afterwards rather than assuming it - a repository that
 *   quietly replaced a version would fail here, loudly, with the ids it lost.
 * - Regenerating something that was never generated is a `NotFoundError`, not a silent
 *   create. If the key misses, the caller wanted `RegisterAssetVersionUseCase` and the
 *   spec or the style checksum has moved under them; saying so beats guessing.
 */

import {
  type Clock,
  InternalError,
  NotFoundError,
  type Result,
  ValidationError,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';
import {
  type Asset,
  type AssetKey,
  type AssetSpec,
  type AssetVersion,
  type AssetVersionId,
  type Ids,
  RegenerateIntent,
  type Sha256Hex,
  type Slug,
  type StyleBibleId,
} from '@rv/contracts';

import { deriveAssetKey } from '../asset-key';
import type { AssetRepository, NewAssetVersion } from '../ports/index';
import { RegisterAssetVersionUseCase } from './register-asset-version';

export interface RegenerateAssetInput {
  readonly spec: AssetSpec;
  readonly styleBibleId: StyleBibleId;
  readonly styleChecksum: Sha256Hex;
  readonly variantKey?: Slug;
  readonly version: NewAssetVersion;
  /** Why we are deliberately paying for something we may already have. */
  readonly intent: RegenerateIntent;
  /** Whether the new take becomes the served one. Defaults to true. */
  readonly makeCurrent?: boolean;
}

export interface RegenerateAssetOutput {
  readonly asset: Asset;
  readonly version: AssetVersion;
  readonly key: AssetKey;
  /** Every version that existed before this call. All of them are still addressable. */
  readonly previousVersionIds: readonly AssetVersionId[];
}

export interface RegenerateAssetDeps {
  readonly repository: AssetRepository;
  readonly ids: Ids;
  readonly clock: Clock;
}

export class RegenerateAssetUseCase {
  readonly #repository: AssetRepository;
  readonly #register: RegisterAssetVersionUseCase;

  constructor(deps: RegenerateAssetDeps) {
    this.#repository = deps.repository;
    this.#register = new RegisterAssetVersionUseCase(deps);
  }

  async execute(input: RegenerateAssetInput): Promise<Result<RegenerateAssetOutput>> {
    const intent = RegenerateIntent.safeParse(input.intent);
    if (!intent.success) {
      return err(
        new ValidationError({
          message: 'RegenerateIntent is not valid; refusing to regenerate.',
          context: { semanticKey: input.spec.semanticKey },
          issues: intent.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        }),
      );
    }

    const context =
      input.variantKey === undefined
        ? { styleChecksum: input.styleChecksum }
        : { styleChecksum: input.styleChecksum, variantKey: input.variantKey };
    const { key } = deriveAssetKey(input.spec, context);

    const existing = await this.#repository.findByKey(key);
    if (isErr(existing)) return existing;
    if (existing.value === null) {
      return err(
        new NotFoundError('Asset', key, {
          context: { semanticKey: input.spec.semanticKey, styleChecksum: input.styleChecksum },
        }),
      );
    }

    const previousVersionIds = existing.value.versions.map((version) => version.id);

    const registered = await this.#register.execute({
      ...input,
      intent: intent.data,
      makeCurrent: input.makeCurrent ?? true,
    });
    if (isErr(registered)) return registered;

    const survivors = new Set(registered.value.asset.versions.map((version) => version.id));
    const lost = previousVersionIds.filter((id) => !survivors.has(id));
    if (lost.length > 0) {
      return err(
        new InternalError({
          message: 'Regeneration dropped a previous version. Prior takes must stay addressable.',
          context: { assetKey: key, lost },
        }),
      );
    }

    return ok({
      asset: registered.value.asset,
      version: registered.value.version,
      key,
      previousVersionIds,
    });
  }
}
