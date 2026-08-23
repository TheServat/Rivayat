/**
 * Per-stage model selection, as a port the story stages depend on.
 *
 * The owner's requirement - stated for the story model and generalised to every LLM
 * stage by docs/01 §5 - is that any stage can be pinned to any model. The `ModelRouter`
 * already implements that decision; what it returns is a chain of `ModelBinding`s, and
 * what `StructuredCall` needs is a chain of `StructuredBackend`s. This is the seam
 * between the two.
 *
 * It is declared here, in the layer that uses it, rather than in `@rv/providers`: a
 * use-case should be testable with a hand-written pair of fake backends and no router at
 * all, and the dependency rule (CLAUDE.md #4) points inward.
 */

import type { PipelineStageKey, QualityTier, TaskKind } from '@rv/contracts';
import { modelRef } from '@rv/contracts';
import type { StructuredBackend } from '@rv/prompt-kit';
import {
  type AppError,
  type Result,
  UnsupportedCapabilityError,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';
import type { CapabilityMatrix, ModelRouter } from '@rv/providers';

/** What is being asked for, in the router's own vocabulary. */
export interface StageCallSpec {
  /** The pipeline stage. This is the key a user's pin is recorded against. */
  readonly stage: PipelineStageKey;
  /** The finer-grained unit of work. One stage issues several kinds of call. */
  readonly task: TaskKind;
  readonly tier: QualityTier;
}

export interface StageBackends {
  /**
   * The ordered chain for one call. `chain[0]` is the primary; the rest are escalations.
   *
   * Fails rather than falling back when nothing can serve the call, because the failure
   * mode this replaces - quietly running the creative beats on whatever was cheapest -
   * is invisible until the output is bad.
   */
  resolve(spec: StageCallSpec): Result<readonly StructuredBackend[], AppError>;
}

export interface RoutedStageBackendsDeps {
  readonly router: ModelRouter;
  readonly matrix: CapabilityMatrix;
}

/**
 * The production implementation: route, then resolve each binding to its structured port.
 *
 * One wrinkle worth stating, because it looks like a bug. `TASK_CAPABILITY` in
 * `@rv/providers` maps `scene-write` to `text-generation` - correctly, since prose for
 * the audience has no schema to validate. But CLAUDE.md #6 forbids asking a model for
 * JSON outside `StructuredCall`, and dialogue arrives as `DialogueLine[]`, so the scene
 * stages issue their `scene-write` calls *through* `StructuredCall` anyway. The router
 * therefore filters on text generation while this resolver additionally requires the
 * structured port, and silently skips any routed model that lacks it. If that leaves the
 * chain empty the call fails here, before anything is spent, naming the stage.
 */
export class RoutedStageBackends implements StageBackends {
  readonly #router: ModelRouter;
  readonly #matrix: CapabilityMatrix;

  constructor(deps: RoutedStageBackendsDeps) {
    this.#router = deps.router;
    this.#matrix = deps.matrix;
  }

  resolve(spec: StageCallSpec): Result<readonly StructuredBackend[], AppError> {
    const route = this.#router.route({ task: spec.task, tier: spec.tier, stage: spec.stage });
    if (isErr(route)) return route;

    const backends: StructuredBackend[] = [];
    for (const binding of route.value.chain) {
      const port = this.#matrix.resolve(
        modelRef(binding.provider, binding.model),
        'structured-generation',
      );
      if (!isErr(port)) backends.push(port.value);
    }

    if (backends.length === 0) {
      return err(
        new UnsupportedCapabilityError(
          `stage:${spec.stage}`,
          `structured-generation for task "${spec.task}" - the route resolved but no model on it can return validated JSON`,
        ),
      );
    }
    return ok(backends);
  }
}

/**
 * A resolver that ignores the router and always hands back the same chain.
 *
 * For a caller that has already decided - a CLI `--model` flag, a replay of a recorded
 * run - and for the tests that need a backend without a capability matrix. It is
 * production code rather than a fixture because "run this whole thing on exactly this
 * model" is a real thing a user asks for.
 */
export class FixedStageBackends implements StageBackends {
  readonly #chain: readonly StructuredBackend[];

  constructor(chain: readonly StructuredBackend[]) {
    this.#chain = chain;
  }

  resolve(spec: StageCallSpec): Result<readonly StructuredBackend[], AppError> {
    if (this.#chain.length === 0) {
      return err(
        new UnsupportedCapabilityError(
          `stage:${spec.stage}`,
          'structured-generation - the fixed backend chain is empty',
        ),
      );
    }
    return ok(this.#chain);
  }
}
