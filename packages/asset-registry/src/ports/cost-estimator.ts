/**
 * What a miss would cost, before anything is spent.
 *
 * Narrow on purpose: the demand plan needs one number per spec and nothing else. The
 * real price table, provider routing and the ledger live behind `@rv/providers`
 * (RV-028); this port is the seam so the registry can produce an approvable plan
 * without depending on any of that.
 */

import type { NanoUsd } from '@rv/shared-kernel';
import type { AssetSpec } from '@rv/contracts';

export interface AssetCostEstimator {
  /**
   * Synchronous and pure.
   *
   * An estimate that could do IO is an estimate that could itself cost money, which
   * defeats the point of showing it before the user approves the spend.
   */
  estimateNanoUsd(spec: AssetSpec): NanoUsd;
}
