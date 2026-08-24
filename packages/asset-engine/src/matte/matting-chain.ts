/**
 * The matting chain every app should wire, assembled in one place.
 *
 * The shape is a finding, not a preference. `prop/lamp-cart/laden` failed at matte on
 * every run of the live produce: SD 1.5 drew it on a vignetted studio backdrop, and
 * both threshold tiers refused it correctly with *"removed nothing: alpha coverage
 * 0.9902 is above 0.97"*. Flood-filling from the border stalls a few pixels in when the
 * field is graded, so widening the tolerance does not help - past a point it starts
 * eating the subject instead. Research §4 assigns exactly this case to BiRefNet.
 *
 * So the chain is three tiers, cheapest first, and the escalation is driven by the
 * refusal {@link ChainedMatting} already produces:
 *
 * | tier | engine | when it runs | cost |
 * | ---- | ------ | ------------ | ---- |
 * | 1 | `threshold-key` at 18/46 | always | ~30 ms, no model |
 * | 2 | `threshold-key` at 30/72 | tier 1 refused | ~30 ms, no model |
 * | 3 | `birefnet` | tiers 1-2 refused | 224 MB once, then ~13 s/image on CPU |
 *
 * **There is no background classifier and there must not be one.** The question "is
 * this field flat enough to key" is already answered, exactly, by running the key and
 * measuring the result - `MatteAcceptance` does it in three numbers. A separate
 * detector would be a second, weaker opinion that can disagree with the first, and the
 * disagreement is unobservable until a cutout comes back wrong.
 *
 * Tier 3 is lazy in the way that matters: `BiRefNetSegmentation` builds its ONNX
 * session on the first `segment()` call, so a run whose sheets all key cleanly never
 * touches the download.
 */

import type { Logger } from '@rv/shared-kernel';

import type { MattingPort, SegmentationModel } from '../ports/matting-port';
import { BiRefNetSegmentation, type BiRefNetOptions } from './adapters/birefnet-segmentation';
import { ChainedMatting, type MatteAcceptance } from './chained-matting';
import { ModelMatting, type ModelMattingOptions } from './model-matting';
import { ThresholdMatting } from './threshold-matting';

/**
 * Tier 2's tolerances.
 *
 * 30/72 in per-channel terms, squared and tripled to match `ThresholdMatting`'s
 * distance metric. Wide enough for a field the model shaded slightly, narrow enough
 * that a muted earth palette on a cream field still survives.
 */
export const WIDE_THRESHOLD = { tolerance: 30 * 30 * 3, softTolerance: 72 * 72 * 3 } as const;

export interface DefaultMattingChainOptions {
  /**
   * The learned tier. Defaults to BiRefNet through `@huggingface/transformers`.
   *
   * Injectable so a test can prove the escalation happens without a 224 MB download,
   * and so a project that prefers RMBG or `@imgly/background-removal-node` swaps one
   * argument rather than rebuilding the chain.
   */
  readonly segmentation?: SegmentationModel;
  /** Only read when `segmentation` is absent. `cacheDir` is the one worth setting. */
  readonly birefnet?: BiRefNetOptions;
  readonly modelMatting?: ModelMattingOptions;
  readonly acceptance?: MatteAcceptance;
  readonly logger?: Logger;
  /**
   * Drops tier 3, leaving the two key tiers.
   *
   * For a run that must not touch the network or spend 13 s on a fallback - a CI smoke
   * test, or a batch that would rather fail fast and be re-prompted. Named for what it
   * does rather than `enableBiRefNet`, so the default reads as the normal case.
   */
  readonly keyOnly?: boolean;
}

/**
 * Threshold, wider threshold, then the model - with the escalation recorded.
 *
 * Returns `ChainedMatting`, not a bare `MattingPort`, because the concrete type is what
 * carries `engine` as the joined chain name onto the resumability hash: change the
 * chain and the matte step's `inputHash` changes, so a resumed run re-mattes rather
 * than replaying a cutout the old chain produced.
 */
export function defaultMattingChain(options: DefaultMattingChainOptions = {}): ChainedMatting {
  const tiers: MattingPort[] = [new ThresholdMatting(), new ThresholdMatting(WIDE_THRESHOLD)];

  if (options.keyOnly !== true) {
    const model = options.segmentation ?? new BiRefNetSegmentation(options.birefnet ?? {});
    tiers.push(new ModelMatting(model, options.modelMatting ?? {}));
  }

  return new ChainedMatting(tiers, {
    ...(options.acceptance === undefined ? {} : { acceptance: options.acceptance }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}
