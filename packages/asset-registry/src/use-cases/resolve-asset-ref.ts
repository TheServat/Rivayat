/**
 * `AssetRef` → the exact bytes a shot should draw.
 *
 * A shot points at an asset indirectly on purpose (see `AssetRef`): usually it names
 * the asset and lets the registry pick, sometimes it pins a version, sometimes it asks
 * for a variant "as of" a point in story time. This use-case is where those three
 * degrees of freedom collapse into one concrete answer.
 *
 * The story-time branch is the one that earns its keep. "Kael loses an eye in E06"
 * is stored as a variant with `validity.from = E06`; episodes before that resolve to
 * the base and episodes after resolve to the scarred variant, with no manual
 * bookkeeping anywhere (docs/02 §5). `StoryInterval` is half-open, so a variant that
 * ends at ordinal 60 is not served at 60.
 */

import { NotFoundError, type Result, err, isErr, ok } from '@rv/shared-kernel';
import type { Asset, AssetRef, AssetVariant, AssetVersion, Part, StoryTime } from '@rv/contracts';

import type { AssetRepository } from '../ports/index';

export interface ResolveAssetRefInput {
  readonly ref: AssetRef;
  /** Where in the fiction this is being drawn. Omit for "whatever is current". */
  readonly at?: StoryTime;
}

export interface ResolvedAssetRef {
  readonly asset: Asset;
  readonly version: AssetVersion;
  /** `null` when the ref named no variant, or named one with no story-time constraint. */
  readonly variant: AssetVariant | null;
  /** The version's parts with the variant's replacements applied. What gets drawn. */
  readonly parts: readonly Part[];
}

export interface ResolveAssetRefDeps {
  readonly repository: AssetRepository;
}

export class ResolveAssetRefUseCase {
  readonly #repository: AssetRepository;

  constructor(deps: ResolveAssetRefDeps) {
    this.#repository = deps.repository;
  }

  async execute(input: ResolveAssetRefInput): Promise<Result<ResolvedAssetRef>> {
    const found = await this.#repository.findById(input.ref.assetId);
    if (isErr(found)) return found;
    if (found.value === null) return err(new NotFoundError('Asset', input.ref.assetId));

    const asset = found.value;
    const pinned = input.ref.versionId ?? asset.currentVersionId;
    const version = asset.versions.find((candidate) => candidate.id === pinned);
    if (version === undefined) return err(new NotFoundError('AssetVersion', pinned));

    if (input.ref.variantKey === undefined) {
      return ok({ asset, version, variant: null, parts: version.parts });
    }

    const variant = selectVariant(version.variants, input.ref.variantKey, input.at);
    if (variant === null) {
      // `NotFoundError` records only `{ resource, id }`, so the story time that made
      // the lookup fail goes into the id rather than being silently dropped: "eye" and
      // "eye@10" are different failures and the difference is the whole diagnosis.
      const at = input.at === undefined ? '' : `@${String(input.at.ordinal)}`;
      return err(new NotFoundError('AssetVariant', `${input.ref.variantKey}${at}`));
    }

    return ok({ asset, version, variant, parts: applyVariant(version.parts, variant) });
  }
}

/**
 * Picks the variant to serve for a key, honouring story time when it is supplied.
 *
 * Several variants may share a key with disjoint validity - that is how a thing that
 * changes twice is modelled. The tie-break is "latest start wins", so a variant added
 * later in the fiction shadows an earlier one, and an unbounded variant is the floor.
 */
function selectVariant(
  variants: readonly AssetVariant[],
  key: string,
  at: StoryTime | undefined,
): AssetVariant | null {
  const candidates = variants.filter((variant) => variant.key === key);
  if (candidates.length === 0) return null;

  const applicable =
    at === undefined ? candidates : candidates.filter((variant) => isValidAt(variant, at));
  if (applicable.length === 0) return null;

  let best = applicable[0] ?? null;
  for (const candidate of applicable) {
    if (best === null || startsAfter(candidate, best)) best = candidate;
  }
  return best;
}

function isValidAt(variant: AssetVariant, at: StoryTime): boolean {
  const validity = variant.validity;
  if (validity === undefined) return true;
  if (validity.from !== null && at.ordinal < validity.from.ordinal) return false;
  // Half-open: a variant valid until 60 is not the one to draw at 60.
  if (validity.until !== null && at.ordinal >= validity.until.ordinal) return false;
  return true;
}

function startsAfter(candidate: AssetVariant, incumbent: AssetVariant): boolean {
  const candidateStart = candidate.validity?.from?.ordinal ?? Number.NEGATIVE_INFINITY;
  const incumbentStart = incumbent.validity?.from?.ordinal ?? Number.NEGATIVE_INFINITY;
  if (candidateStart !== incumbentStart) return candidateStart > incumbentStart;
  // Deterministic tie-break, so two variants with the same start never flip order.
  return candidate.id.localeCompare(incumbent.id) > 0;
}

/**
 * Overlays the variant's replaced layers onto the base parts.
 *
 * Only `replacedParts` differ; everything else is reused byte-for-byte, which is why a
 * variant costs a fraction of a fresh take and keeps the rig and clips intact.
 */
function applyVariant(parts: readonly Part[], variant: AssetVariant): readonly Part[] {
  return parts.map((part) => {
    const replacement = variant.replacedParts[part.name];
    return replacement === undefined ? part : { ...part, imageHash: replacement };
  });
}
