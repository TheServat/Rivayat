/**
 * `GET /api/assets/demand/plan` - the plan for everything this build has ever been asked
 * to make.
 *
 * `POST /assets/resolve` is the authoritative route and takes a list of `AssetSpec`s.
 * The studio has no source of those: specs come out of S4, which has no endpoint yet. So
 * the Assets screen asks a narrower question - *what would it cost to rebuild what this
 * project has asked for* - and that is answerable from the produce records, which hold
 * every spec S6 has ever been handed.
 *
 * The answer is genuinely useful rather than a placeholder, because of what it says about
 * a library that already exists: every registered asset resolves to a `cache-hit` and
 * contributes nothing, and the only misses are the takes that never registered. A project
 * whose library is complete therefore reads **$0.0000**, and means it. That is the number
 * non-negotiable #2 exists to produce, and this is the screen it shows up on.
 *
 * **Grouped by style, because the plan is.** A dedup key contains the style checksum, so
 * two specs recorded under different bibles are two different questions and
 * `ResolveAssetDemandUseCase` takes one style per call. The groups are resolved
 * separately and their plans concatenated; the totals add because each resolution's
 * estimate is independent of the others.
 *
 * It writes nothing and calls no provider - the use-case asserts that property directly -
 * so it is safe to poll while somebody decides.
 */

import type { ResolveAssetDemandUseCase } from '@rv/asset-registry';
import type {
  AssetDemandPlan,
  AssetResolution,
  AssetSpec,
  Sha256Hex,
  Slug,
  StyleBibleId,
} from '@rv/contracts';
import { isErr, ok, type AppError, type Result } from '@rv/shared-kernel';

import type { ProduceRecordStore } from './produce-record.store';

/** How many recorded specs one plan covers. Enough for several episodes' worth. */
const MAX_RECORDS = 2048;

interface DemandGroup {
  readonly styleBibleId: StyleBibleId;
  readonly styleChecksum: Sha256Hex;
  readonly variantKey: Slug | undefined;
  readonly specs: AssetSpec[];
}

export interface AssetDemandServiceDeps {
  readonly resolve: ResolveAssetDemandUseCase;
  readonly records: ProduceRecordStore;
}

export class AssetDemandService {
  readonly #deps: AssetDemandServiceDeps;

  constructor(deps: AssetDemandServiceDeps) {
    this.#deps = deps;
  }

  async plan(): Promise<Result<AssetDemandPlan, AppError>> {
    const records = await this.#deps.records.list(MAX_RECORDS);
    if (isErr(records)) return records;

    const groups = new Map<string, DemandGroup>();
    for (const record of records.value) {
      const groupKey = `${record.styleBibleId}|${record.styleChecksum}|${record.variantKey ?? ''}`;
      const existing = groups.get(groupKey);
      if (existing === undefined) {
        groups.set(groupKey, {
          styleBibleId: record.styleBibleId,
          styleChecksum: record.styleChecksum,
          variantKey: record.variantKey,
          specs: [record.spec],
        });
        continue;
      }
      existing.specs.push(record.spec);
    }

    const resolutions: AssetResolution[] = [];
    let hitCount = 0;
    let missCount = 0;
    let total = 0;
    let requiresConfirmation = false;

    for (const group of groups.values()) {
      const plan = await this.#deps.resolve.execute({
        specs: group.specs,
        styleBibleId: group.styleBibleId,
        styleChecksum: group.styleChecksum,
        ...(group.variantKey === undefined ? {} : { variantKey: group.variantKey }),
      });
      if (isErr(plan)) return plan;

      resolutions.push(...plan.value.resolutions);
      hitCount += plan.value.hitCount;
      missCount += plan.value.missCount;
      total += plan.value.totalEstimatedNanoUsd;
      requiresConfirmation = requiresConfirmation || plan.value.requiresConfirmation;
    }

    return ok({
      resolutions,
      hitCount,
      missCount,
      totalEstimatedNanoUsd: total,
      requiresConfirmation,
    });
  }
}
