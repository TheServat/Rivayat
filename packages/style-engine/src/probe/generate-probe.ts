/**
 * The probe sheet: four tiles that let a human say yes before anything expensive
 * happens.
 *
 * ## Why this refuses an unlocked style
 *
 * Architecture §3.1 reads "probe sheet → user approves → style locked", which suggests
 * the probe runs against a draft. It does not, and the reason is `assertUsableForGeneration`
 * in `@rv/core-domain`: it is the *single* guard in front of every image generation, and
 * a probe is an image generation. Giving the probe its own softer rule would mean two
 * answers to "may this style be drawn against", and the softer one is the one that
 * would get copied.
 *
 * So the flow is lock → probe → approve, or lock → probe → **fork**. That costs nothing:
 * `fork()` is already built, it produces version n+1 in draft while leaving version n
 * intact, and a rejected probe on the free lane costs $0. The invariant that no pixel is
 * generated against a moving target survives intact, which is the point of the guard.
 *
 * ## Why the free lane is the default
 *
 * A probe is a judgement about *style*, and research §0 measured the local ComfyUI lane
 * at 1.42 s for a 512px draft with bit-exact reproducibility across process restarts.
 * Four tiles is therefore about six seconds and exactly zero dollars, and a user who
 * rejects six candidate styles has spent nothing. Promoting to a paid model is a
 * decision for a locked asset, not for a sheet nobody has approved yet.
 */

import { assertUsableForGeneration } from '@rv/core-domain';
import {
  KNOWN_MODELS,
  type ModelDescriptor,
  type ModelRef,
  ProviderKind,
  type Size,
  type StyleBible,
} from '@rv/contracts';
import type { ImageArtifact, ImageCostQuote, ImageGenerationPort } from '@rv/providers';
import { priceCall, pricingFor, projectedNanoUsd } from '@rv/providers';
import {
  type AppError,
  type Clock,
  type Logger,
  type NanoUsd,
  NoopLogger,
  type Result,
  type Unit,
  ValidationError,
  ZERO_USD,
  err,
  isErr,
  nanoUsd,
  ok,
  toIso,
} from '@rv/shared-kernel';

import { type ComposedPrompt, composeStylePrompt } from '../prompts/compose';
import { PROBE_SUBJECTS, type ProbeSubject } from './subjects';

/**
 * Which image lane to run on.
 *
 * This is the value of the `image.lane` setting from architecture §7b. The settings
 * registry resolves it; this use-case only ever receives the answer, so it has no
 * opinion about `.env`, projects or run overrides.
 */
export type StyleProbeLane = 'free' | 'paid';

/**
 * 512px square.
 *
 * The measured sweet spot on the 6 GB card (research §0: 1.42 s at 4 steps, 3698 MiB
 * peak; 1024px costs 7.59 s and 95 % of the card). A probe is judged on style, not
 * resolution, so paying five times the time for detail nobody is assessing is waste.
 */
const PROBE_SIZE: Size = { width: 512, height: 512 };

export interface StyleProbeTile {
  readonly subject: ProbeSubject;
  readonly prompt: ComposedPrompt;
  readonly image: ImageArtifact;
  readonly modelRef: ModelRef;
  readonly seed: number;
  readonly costNanoUsd: NanoUsd;
  /**
   * Whether the catalogue had a price for the model that produced this tile.
   *
   * `false` means the zero next to it is "we do not know", not "it was free" - a
   * distinction that matters a great deal on a screen someone is about to approve.
   */
  readonly priced: boolean;
}

export interface StyleProbeSheet {
  readonly styleBibleId: StyleBible['id'];
  readonly styleChecksum: StyleBible['checksum'];
  readonly lane: StyleProbeLane;
  readonly size: Size;
  readonly tiles: readonly StyleProbeTile[];
  readonly totalCostNanoUsd: NanoUsd;
  /** False when any tile's model was missing from the price catalogue. */
  readonly costIsComplete: boolean;
  readonly generatedAt: string;
}

export interface GenerateStyleProbeInput {
  readonly bible: StyleBible;
  /** Defaults to `free`. */
  readonly lane?: StyleProbeLane;
  readonly size?: Size;
  readonly signal?: AbortSignal;
}

/** What is about to be spent, before it is. */
export interface ProbeSpendRequest {
  readonly lane: StyleProbeLane;
  /** Which tile, zero-based, so a refusal can say how far the sheet got. */
  readonly tileIndex: number;
  /** Images this one call will ask for. Explicit, so a batched call cannot slip past. */
  readonly images: number;
  /** What this sheet has already cost, in nano-dollars. */
  readonly spentNanoUsd: NanoUsd;
  /**
   * The adapter's own quote for this exact call, taken before it is made.
   *
   * From `ImageGenerationPort.quoteImage`, so the estimate and the eventual invoice come
   * from one pricing table rather than from a number the composition root looked up
   * separately. The whole quote and not just its total, because the `unpriced` arm
   * carries a `modelRef` and a reason that a policy decision needs.
   */
  readonly quote: ImageCostQuote;
  /**
   * The number to check a ceiling against, or `null` when the model is unpriced.
   *
   * `null` rather than zero, and deliberately not defaulted: an unknown price that reads
   * as free is the most expensive possible way to be wrong, so a guard has to decide
   * what its policy is instead of being handed a plausible-looking nothing.
   */
  readonly projectedNanoUsd: NanoUsd | null;
}

/**
 * The ceiling, asked **before** each tile.
 *
 * CLAUDE.md #3: "the budget guard runs *before* the call". A probe sheet is a loop of
 * `PROBE_SUBJECTS.length` image generations, and on the paid lane every one of them is
 * money - so a check that ran once at the top, or a total totted up at the bottom, would
 * be a receipt rather than a guard.
 *
 * A narrow port rather than `BudgetGuard` itself, for the reason CLAUDE.md §2 gives for
 * narrow ports: this use-case does not know the run id, the policy or the ledger, and it
 * should not have to. It does know what the call will cost, because
 * `ImageGenerationPort.quoteImage` answers that before the call is made - so the guard is
 * handed a real projection and the composition root only has to adapt
 * `@rv/providers`' `BudgetGuard` onto this shape.
 *
 * Optional on {@link GenerateStyleProbeDeps} only because the default lane is the local
 * one and costs nothing. Wire it for anything that can reach the paid lane.
 */
export interface ProbeSpendGuard {
  /** `err` refuses the tile, and the provider is not touched. */
  check(request: ProbeSpendRequest): Result<Unit, AppError>;
}

export interface GenerateStyleProbeDeps {
  /**
   * One port per lane.
   *
   * A map rather than two fields so an unwired paid lane is a missing key the use-case
   * can report by name, instead of an adapter that throws on first use.
   */
  readonly imageLanes: Partial<Record<StyleProbeLane, ImageGenerationPort>>;
  readonly clock: Clock;
  /** Defaults to `KNOWN_MODELS` via `pricingFor`. */
  readonly catalogue?: readonly ModelDescriptor[];
  /** Consulted before every tile. See {@link ProbeSpendGuard}. */
  readonly budget?: ProbeSpendGuard;
  readonly logger?: Logger;
}

export class GenerateStyleProbeUseCase {
  readonly #lanes: Partial<Record<StyleProbeLane, ImageGenerationPort>>;
  readonly #clock: Clock;
  readonly #catalogue: readonly ModelDescriptor[];
  readonly #budget: ProbeSpendGuard | undefined;
  readonly #logger: Logger;

  constructor(deps: GenerateStyleProbeDeps) {
    this.#lanes = deps.imageLanes;
    this.#clock = deps.clock;
    this.#catalogue = deps.catalogue ?? KNOWN_MODELS;
    this.#budget = deps.budget;
    this.#logger = deps.logger ?? new NoopLogger();
  }

  async execute(input: GenerateStyleProbeInput): Promise<Result<StyleProbeSheet, AppError>> {
    // The one guard, reused. A second lock check here would be a second answer to the
    // same question, and the two would eventually disagree.
    const usable = assertUsableForGeneration(input.bible);
    if (isErr(usable)) return usable;

    const lane = input.lane ?? 'free';
    const port = this.#lanes[lane];
    if (port === undefined) {
      return err(
        new ValidationError({
          message: `No image adapter is wired to the "${lane}" lane.`,
          context: { lane, wired: Object.keys(this.#lanes) },
        }),
      );
    }

    const size = input.size ?? PROBE_SIZE;
    const tiles: StyleProbeTile[] = [];
    let total = 0;
    let costIsComplete = true;

    for (const [index, subject] of PROBE_SUBJECTS.entries()) {
      const prompt = composeStylePrompt({
        fragments: input.bible.prompts,
        subject: subject.subject,
        subjectClass: subject.subjectClass,
      });
      // Offset from the bible's base seed rather than drawn from an RNG: the same
      // candidate must produce the same sheet, so the cache serves a regeneration and
      // the ledger records another zero (RV-044).
      const seed = input.bible.seed + index;

      // Before the spend, never after. A refusal returns the guard's own error rather
      // than a wrapper: `BudgetExceededError` names the ceiling and is deliberately
      // not retryable, and re-wrapping it would lose both.
      // Priced before it is spent, from the adapter that is about to be paid. A quote
      // taken from anywhere else could disagree with the invoice.
      const quote = port.quoteImage({ size, count: 1 });
      const allowed = this.#budget?.check({
        lane,
        tileIndex: index,
        images: 1,
        spentNanoUsd: nanoUsd(total),
        quote,
        projectedNanoUsd: projectedNanoUsd(quote),
      });
      if (allowed !== undefined && isErr(allowed)) {
        this.#logger.warn('style probe: refused by the budget guard', {
          lane,
          tileIndex: index,
          spentNanoUsd: total,
          projectedNanoUsd: projectedNanoUsd(quote),
          modelRef: quote.modelRef,
          code: allowed.error.code,
        });
        return allowed;
      }

      const generated = await port.generateImage({
        prompt: prompt.positive,
        negativePrompt: prompt.negative,
        size,
        count: 1,
        seed,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      if (isErr(generated)) {
        this.#logger.warn('style probe: tile failed', {
          subject: subject.key,
          lane,
          code: generated.error.code,
        });
        return err(
          new ValidationError({
            message: `The "${subject.key}" probe tile could not be generated: ${generated.error.message}`,
            context: {
              subject: subject.key,
              lane,
              cause: generated.error.code,
              spentNanoUsd: total,
              tilesCompleted: tiles.length,
            },
          }),
        );
      }

      const image = generated.value.images[0];
      if (image === undefined) {
        return err(
          new ValidationError({
            message: `The "${subject.key}" probe tile came back with no image.`,
            context: { subject: subject.key, lane, modelRef: generated.value.modelRef },
          }),
        );
      }

      const priced = this.#price(generated.value.modelRef, generated.value.usage);
      if (!priced.known) costIsComplete = false;
      total += priced.cost;

      tiles.push({
        subject,
        prompt,
        image,
        modelRef: generated.value.modelRef,
        seed,
        costNanoUsd: nanoUsd(priced.cost),
        priced: priced.known,
      });
    }

    return ok({
      styleBibleId: input.bible.id,
      styleChecksum: usable.value,
      lane,
      size,
      tiles,
      totalCostNanoUsd: tiles.length === 0 ? ZERO_USD : nanoUsd(total),
      costIsComplete,
      generatedAt: toIso(this.#clock.now()),
    });
  }

  /**
   * Prices one tile from the catalogue.
   *
   * `ModelRef` is `provider:model` and the model half may itself contain colons
   * (`qwen3.5:latest`), so it splits on the *first* one only.
   */
  #price(
    reference: ModelRef,
    consumed: Parameters<typeof priceCall>[1],
  ): { cost: number; known: boolean } {
    const separator = reference.indexOf(':');
    if (separator < 0) return { cost: 0, known: false };
    const provider = ProviderKind.safeParse(reference.slice(0, separator));
    if (!provider.success) return { cost: 0, known: false };

    const pricing = pricingFor(provider.data, reference.slice(separator + 1), this.#catalogue);
    const known =
      pricing.free ||
      pricing.inputPerMTokensUsd !== null ||
      pricing.outputPerMTokensUsd !== null ||
      pricing.imageOutputPerMTokensUsd !== null;

    return { cost: priceCall(pricing, consumed), known };
  }
}
