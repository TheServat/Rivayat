/**
 * Reconciling the live OpenRouter catalogue against what we think we know.
 *
 * The seed table in `@rv/contracts` (`KNOWN_MODELS`) records prices verified on
 * 2026-08-23. The live catalogue records prices as of now. Neither is authoritative on
 * its own: the live one can rename or withdraw a model mid-run, and the seed one can
 * be stale. So the sync **reports the difference** instead of overwriting one with the
 * other, and a human decides.
 *
 * Two research §2 findings are re-checked on every sync, because they are the two most
 * commonly re-derived incorrectly and a regression is otherwise invisible:
 *
 *  - the `:free` pool contains no model that emits images;
 *  - the `:free` pool is the size `FREE_TIER_FACTS` recorded.
 *
 * One thing is deliberately *not* reconciled: the image-output rate. Research §2 quotes
 * "$ / 1M image-output tokens" from this endpoint, but OpenRouter's published pricing
 * object documents `prompt`, `completion`, `request` and `image` (per *input* image)
 * only. Comparing our `imageOutputPerMTokensUsd` against a field whose name we have not
 * seen documented would invent an assertion, so the drift report says nothing about it
 * rather than saying something unfounded.
 */

import { FREE_TIER_FACTS, KNOWN_MODELS, type ModelDescriptor, type Modality } from '@rv/contracts';

import type { OpenRouterModel, OpenRouterModelsResponse } from './wire';

export interface CatalogueEntry {
  readonly id: string;
  readonly label: string;
  /** `null` when OpenRouter did not publish one - a real answer, not a placeholder. */
  readonly contextLength: number | null;
  readonly maxOutputTokens: number | null;
  readonly inputModalities: readonly Modality[];
  readonly outputModalities: readonly Modality[];
  /** Per-token rates, verbatim strings as OpenRouter quoted them. */
  readonly pricing: {
    readonly promptPerTokenUsd: string | null;
    readonly completionPerTokenUsd: string | null;
    readonly perInputImageUsd: string | null;
  };
  /** True when every quoted rate is zero. The `:free` suffix is a claim, this is a check. */
  readonly free: boolean;
}

export type DriftKind =
  /** We ship a descriptor for a model the live catalogue no longer lists. */
  | 'missing-from-live'
  /** A rate we recorded no longer matches the live rate. */
  | 'price-changed'
  /** The model gained or lost an output modality. */
  | 'modality-changed'
  /** The size of the `:free` pool moved away from `FREE_TIER_FACTS`. */
  | 'free-pool-size-changed'
  /** A `:free` model now emits images, contradicting research §2. */
  | 'free-model-emits-images';

export interface CatalogueDrift {
  readonly kind: DriftKind;
  /** Model id, or `*` for a fact about the pool as a whole. */
  readonly modelId: string;
  readonly expected: string;
  readonly actual: string;
}

export interface CatalogueSnapshot {
  /** Epoch millis, from the injected clock. */
  readonly fetchedAt: number;
  readonly models: ReadonlyMap<string, CatalogueEntry>;
  /** Ids carrying the `:free` suffix, sorted, so the set is diffable between runs. */
  readonly freeModelIds: readonly string[];
  readonly drift: readonly CatalogueDrift[];
}

const KNOWN_MODALITIES = new Set<string>(['text', 'image', 'audio']);

function toModalities(values: readonly string[] | undefined, fallback: Modality): Modality[] {
  const mapped = (values ?? [])
    .map((value) => value.toLowerCase())
    .filter((value): value is Modality => KNOWN_MODALITIES.has(value));
  return mapped.length > 0 ? mapped : [fallback];
}

function rateOf(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

function isZeroRate(value: string | null): boolean {
  return value === null || Number.parseFloat(value) === 0;
}

export function toCatalogueEntry(model: OpenRouterModel): CatalogueEntry {
  const pricing = {
    promptPerTokenUsd: rateOf(model.pricing?.prompt),
    completionPerTokenUsd: rateOf(model.pricing?.completion),
    perInputImageUsd: rateOf(model.pricing?.image),
  };
  return {
    id: model.id,
    label: model.name ?? model.id,
    contextLength: model.context_length ?? model.top_provider?.context_length ?? null,
    maxOutputTokens: model.top_provider?.max_completion_tokens ?? null,
    inputModalities: toModalities(model.architecture?.input_modalities, 'text'),
    outputModalities: toModalities(model.architecture?.output_modalities, 'text'),
    pricing,
    free: isZeroRate(pricing.promptPerTokenUsd) && isZeroRate(pricing.completionPerTokenUsd),
  };
}

/** Per-token to per-million, the unit `@rv/contracts` stores. */
function perMillion(perToken: string | null): number | null {
  return perToken === null ? null : Number.parseFloat(perToken) * 1_000_000;
}

/**
 * Relative comparison, because these are floats reconstructed from decimal strings.
 *
 * An absolute epsilon would either wave through a real change at $120/1M or flag
 * rounding noise at $0.0000003/1M. 1e-6 relative is far tighter than any real price
 * move and far looser than the reconstruction error.
 */
function ratesDiffer(expected: string | null, actual: number | null): boolean {
  if (expected === null && actual === null) return false;
  if (expected === null || actual === null) return true;
  const target = Number.parseFloat(expected);
  if (target === 0) return actual !== 0;
  return Math.abs(actual - target) / Math.abs(target) > 1e-6;
}

function describeRate(value: number | null): string {
  return value === null ? 'not published' : `${String(value)}/1M`;
}

/**
 * Compares the live catalogue with our seed table.
 *
 * Only models we ship a descriptor for are compared one by one. Reporting every live
 * model we have never heard of would bury the three lines that matter under several
 * hundred that do not.
 */
export function reconcile(
  live: ReadonlyMap<string, CatalogueEntry>,
  catalogue: readonly ModelDescriptor[] = KNOWN_MODELS,
): readonly CatalogueDrift[] {
  const drift: CatalogueDrift[] = [];

  for (const descriptor of catalogue) {
    if (descriptor.provider !== 'openrouter') continue;
    const entry = live.get(descriptor.id);
    if (entry === undefined) {
      drift.push({
        kind: 'missing-from-live',
        modelId: descriptor.id,
        expected: 'listed by /api/v1/models',
        actual: 'absent',
      });
      continue;
    }

    const livePrompt = perMillion(entry.pricing.promptPerTokenUsd);
    if (ratesDiffer(descriptor.pricing.inputPerMTokensUsd, livePrompt)) {
      drift.push({
        kind: 'price-changed',
        modelId: descriptor.id,
        expected: `input ${descriptor.pricing.inputPerMTokensUsd ?? 'not published'}/1M`,
        actual: `input ${describeRate(livePrompt)}`,
      });
    }

    const liveCompletion = perMillion(entry.pricing.completionPerTokenUsd);
    if (ratesDiffer(descriptor.pricing.outputPerMTokensUsd, liveCompletion)) {
      drift.push({
        kind: 'price-changed',
        modelId: descriptor.id,
        expected: `output ${descriptor.pricing.outputPerMTokensUsd ?? 'not published'}/1M`,
        actual: `output ${describeRate(liveCompletion)}`,
      });
    }

    const weExpectImages = descriptor.outputModalities.includes('image');
    const liveHasImages = entry.outputModalities.includes('image');
    if (weExpectImages !== liveHasImages) {
      drift.push({
        kind: 'modality-changed',
        modelId: descriptor.id,
        expected: `output image: ${String(weExpectImages)}`,
        actual: `output image: ${String(liveHasImages)}`,
      });
    }
  }

  const freeIds = [...live.values()]
    .filter((entry) => entry.id.endsWith(':free'))
    .map((entry) => entry.id);

  if (freeIds.length !== FREE_TIER_FACTS.openRouterFreeModelCount) {
    drift.push({
      kind: 'free-pool-size-changed',
      modelId: '*',
      expected: `${String(FREE_TIER_FACTS.openRouterFreeModelCount)} models with the :free suffix`,
      actual: `${String(freeIds.length)}`,
    });
  }

  for (const id of freeIds) {
    const entry = live.get(id);
    if (entry?.outputModalities.includes('image') === true) {
      drift.push({
        kind: 'free-model-emits-images',
        modelId: id,
        expected: 'no :free model produces image output (research §2)',
        actual: 'declares image output',
      });
    }
  }

  return drift;
}

/** Builds a snapshot from a validated `/api/v1/models` payload. */
export function buildSnapshot(
  payload: OpenRouterModelsResponse,
  fetchedAt: number,
  catalogue: readonly ModelDescriptor[] = KNOWN_MODELS,
): CatalogueSnapshot {
  const models = new Map<string, CatalogueEntry>();
  for (const model of payload.data) models.set(model.id, toCatalogueEntry(model));

  return {
    fetchedAt,
    models,
    freeModelIds: [...models.keys()].filter((id) => id.endsWith(':free')).sort(),
    drift: reconcile(models, catalogue),
  };
}
