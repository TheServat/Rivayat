/**
 * The joint between this app's provider layer and `@rv/story-engine`.
 *
 * The engine declares two ports and holds no adapter: `StructuredCall` from
 * `@rv/prompt-kit` for the call itself, and `StageBackends` for "which models may serve
 * this stage, in which order". Both are satisfied here, once, so that no use-case and no
 * stage handler ever names a provider.
 *
 * `RoutedStageBackends` is the engine's own production resolver over `ModelRouter` and
 * `CapabilityMatrix` - the two objects the composition root already builds. Using it
 * rather than `FixedStageBackends` is what makes "pin S2 to a different model in the
 * settings" work from the API without a line changing here: the pin lives in
 * `RouterConfig.stageOverrides`, the router reads it, and the role's `stage` field is
 * what it is keyed on.
 *
 * `clock` and `ids` are injected all the way down for non-negotiable #1: a replayed run
 * has to mint the ids it minted the first time, and that is only possible if neither is
 * reached for globally.
 */

import { Ids } from '@rv/contracts';
import { StructuredCall } from '@rv/prompt-kit';
import type { CapabilityMatrix, ModelRouter } from '@rv/providers';
import { RoutedStageBackends, type StoryEngineDeps } from '@rv/story-engine';
import type { Clock, Logger } from '@rv/shared-kernel';

export interface StoryEngineDepsOptions {
  readonly router: ModelRouter;
  readonly matrix: CapabilityMatrix;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly logger: Logger;
}

/**
 * Builds the dependency bundle every story-engine use-case takes.
 *
 * A function rather than a class because it holds no state: the `StructuredCall` it
 * makes is itself stateless, and constructing one per stage run keeps its logger scoped
 * to the stage that is running.
 */
export function buildStoryEngineDeps(options: StoryEngineDepsOptions): StoryEngineDeps {
  return {
    structured: new StructuredCall({ clock: options.clock, logger: options.logger }),
    backends: new RoutedStageBackends({ router: options.router, matrix: options.matrix }),
    clock: options.clock,
    ids: options.ids,
    logger: options.logger,
  };
}

/**
 * The bundle, as one injectable thing.
 *
 * A class rather than four separate tokens on every controller and stage handler,
 * because the four are only ever wanted together and a controller that had to assemble
 * them would be a second composition root. `create` takes a logger so a stage run can
 * scope `StructuredCall`'s output to itself - which is what makes "which model needed
 * three repair turns on this schema" answerable per run rather than per process.
 */
export class StoryEngineFactory {
  readonly #options: StoryEngineDepsOptions;

  constructor(options: StoryEngineDepsOptions) {
    this.#options = options;
  }

  create(logger?: Logger): StoryEngineDeps {
    return buildStoryEngineDeps(
      logger === undefined ? this.#options : { ...this.#options, logger },
    );
  }

  /** The resolver alone, for a caller that holds `StructuredBackend`s of its own. */
  get backends(): RoutedStageBackends {
    return new RoutedStageBackends({ router: this.#options.router, matrix: this.#options.matrix });
  }
}
