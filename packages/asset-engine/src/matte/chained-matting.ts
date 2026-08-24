/**
 * Primary, then fallback, with the reason recorded.
 *
 * RV-123 asks for exactly this: BiRefNet first, `@imgly/background-removal-node` when
 * it is unavailable, and "records which engine was used". The chain adds one thing to
 * that sentence, which is the part that matters in practice - an engine can *succeed*
 * and still be wrong. A matte that removed everything (coverage ~0) or nothing
 * (coverage ~1, opaque corners) is a failure that returns `ok`, and without an
 * acceptance check the pipeline would rig a rectangle.
 */

import {
  type AppError,
  type Logger,
  NoopLogger,
  type Result,
  ValidationError,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';

import type { MatteRequest, MatteResult, MattingPort } from '../ports/matting-port';
import { alphaCoverage, cornersAreTransparent } from '../raster/alpha';

export interface MatteAcceptance {
  /** Below this, the engine removed the subject along with the background. */
  readonly minCoverage: number;
  /** Above this, the engine removed nothing worth calling a cutout. */
  readonly maxCoverage: number;
  /** Whether opaque corners disqualify a result. */
  readonly requireTransparentCorners: boolean;
}

export const DEFAULT_ACCEPTANCE: MatteAcceptance = {
  minCoverage: 0.005,
  maxCoverage: 0.97,
  requireTransparentCorners: true,
};

export interface ChainedMattingOptions {
  readonly acceptance?: MatteAcceptance;
  readonly logger?: Logger;
}

export class ChainedMatting implements MattingPort {
  readonly engine: string;
  readonly #chain: readonly MattingPort[];
  readonly #acceptance: MatteAcceptance;
  readonly #logger: Logger;

  constructor(chain: readonly MattingPort[], options: ChainedMattingOptions = {}) {
    if (chain.length === 0) {
      throw new ValidationError({ message: 'ChainedMatting needs at least one engine' });
    }
    this.#chain = chain;
    this.#acceptance = options.acceptance ?? DEFAULT_ACCEPTANCE;
    this.#logger = options.logger ?? new NoopLogger();
    this.engine = chain.map((port) => port.engine).join('>');
  }

  async matte(request: MatteRequest): Promise<Result<MatteResult, AppError>> {
    const fallbacks: { engine: string; reason: string }[] = [];
    let lastError: AppError | undefined;

    for (const port of this.#chain) {
      const attempt = await port.matte(request);
      if (isErr(attempt)) {
        lastError = attempt.error;
        fallbacks.push({ engine: port.engine, reason: attempt.error.message });
        this.#logger.warn('matte: engine failed, falling back', {
          engine: port.engine,
          code: attempt.error.code,
        });
        continue;
      }

      const rejection = this.#reject(attempt.value);
      if (rejection !== null) {
        fallbacks.push({ engine: port.engine, reason: rejection });
        this.#logger.warn('matte: result rejected, falling back', {
          engine: port.engine,
          reason: rejection,
        });
        continue;
      }

      return ok({ ...attempt.value, engine: port.engine, fallbacks });
    }

    // The last *thrown* error wins when there was one, so a missing model file still
    // reaches the caller as a provider failure with its retryability intact. When every
    // tier merely produced rubbish there is no error to keep, so the reasons are what
    // the failure is made of - and they are logged either way, because a chain that
    // threw at tier 3 and was refused at tiers 1-2 otherwise reports only the throw.
    this.#logger.warn('matte: every engine in the chain was exhausted', {
      attempts: fallbacks.map((entry) => `${entry.engine}: ${entry.reason}`),
    });
    return err(
      lastError ??
        new ValidationError({
          message: 'every matting engine produced an unusable cutout',
          context: {
            tried: fallbacks.map((entry) => entry.engine),
            reasons: fallbacks.map((entry) => entry.reason),
          },
        }),
    );
  }

  /** `null` when the result is acceptable, otherwise why it is not. */
  #reject(result: MatteResult): string | null {
    const coverage = alphaCoverage(result.image);
    if (coverage < this.#acceptance.minCoverage) {
      return `removed the subject: alpha coverage ${coverage.toFixed(4)} is below ${String(this.#acceptance.minCoverage)}`;
    }
    if (coverage > this.#acceptance.maxCoverage) {
      return `removed nothing: alpha coverage ${coverage.toFixed(4)} is above ${String(this.#acceptance.maxCoverage)}`;
    }
    if (this.#acceptance.requireTransparentCorners && !cornersAreTransparent(result.image)) {
      return 'the canvas corners are still opaque';
    }
    return null;
  }
}
