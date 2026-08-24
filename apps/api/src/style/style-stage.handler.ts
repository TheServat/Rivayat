/**
 * S1 Style, wired for real: choose, probe, lock - in that order and in one stage.
 *
 * The three steps are one stage rather than three because they are one *decision*. A
 * style is not usable until it is locked, and it must not be locked until somebody has
 * seen what it draws; splitting them across pipeline stages would create a run that can
 * legitimately stop in the middle holding a bible nothing downstream may touch.
 *
 * What it does not do is ask. A pipeline run is unattended by definition, so "the human
 * approves the sheet" happens over HTTP (`POST /api/style/:id/probe` then `/lock`) and
 * this stage's `probe` setting exists so that an unattended run still *draws* the sheet
 * - the tiles land in the content store and the run's artifacts name them, so the
 * approval can happen after the fact against real pixels rather than against a promise.
 *
 * The probe is best-effort and the lock is not. A machine with no image lane wired can
 * still establish a style - the sheet is evidence, not a precondition - and the stage
 * says in its progress line that it produced none. A failed *lock*, by contrast, fails
 * the stage: every stage after this one refuses an unlocked bible, and continuing would
 * only move the failure somewhere harder to read.
 */

import type { Ids, PipelineStageKey, StyleBible, StyleBibleId } from '@rv/contracts';
import { isLocked } from '@rv/core-domain';
import { findPreset, materialiseStyleBible } from '@rv/style-engine';
import {
  ValidationError,
  err,
  isErr,
  ok,
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';

import type { StyleEnginePort } from '../application/ports/engine.ports';
import { toValidationError } from '../common/zod-validation.pipe';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
import { StyleStageRequest } from './style-stage.contracts';
import type { StyleBibleRepository } from './style-bible.repository';

export interface StyleStageHandlerDeps {
  readonly engine: StyleEnginePort;
  readonly repository: StyleBibleRepository;
  readonly ids: Ids;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class StyleStageHandler implements StageHandler {
  readonly stage: PipelineStageKey = 'style';
  readonly implemented = true;
  readonly #deps: StyleStageHandlerDeps;

  constructor(deps: StyleStageHandlerDeps) {
    this.#deps = deps;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const request = StyleStageRequest.safeParse(context.job.payload.style ?? {});
    if (!request.success) return err(toValidationError(request.error, 'run.payload.style'));

    context.reportProgress({ progress: 0.1, detail: 'resolving the style bible' });

    const chosen = await this.#choose(request.data);
    if (isErr(chosen)) return chosen;
    let bible = chosen.value;

    const artifacts: string[] = [`style-bible:${bible.id}`];

    if (request.data.probe !== false) {
      context.reportProgress({ progress: 0.3, detail: 'drawing the probe sheet' });
      const sheet = await this.#deps.engine.probe({
        styleBibleId: bible.id,
        lane: request.data.probe,
        signal: context.signal,
      });

      if (isErr(sheet)) {
        // Evidence, not a precondition. The run continues and says what it lost, because
        // a machine with no image lane can still establish a style and a stage that
        // failed here would report "no style" for a missing GPU.
        this.#deps.logger.warn('S1: no probe sheet; the style is unillustrated', {
          styleBibleId: bible.id,
          lane: request.data.probe,
          code: sheet.error.code,
        });
        context.reportProgress({
          progress: 0.6,
          detail: `no probe sheet: ${sheet.error.message}`,
        });
      } else {
        for (const tile of sheet.value.tiles) artifacts.push(`style-probe-tile:${tile.imageUrl}`);
        artifacts.push(`style-probe:${String(sheet.value.tiles.length)}`);
        context.reportProgress({
          progress: 0.6,
          detail: `${String(sheet.value.tiles.length)} probe tiles on the ${sheet.value.lane} lane`,
          item: {
            kind: 'asset',
            key: 'probe-sheet',
            index: sheet.value.tiles.length,
            total: sheet.value.tiles.length,
          },
        });
      }
    }

    if (request.data.lock && !isLocked(bible)) {
      context.reportProgress({ progress: 0.85, detail: 'freezing the checksum' });
      const locked = await this.#deps.engine.lock(bible.id);
      if (isErr(locked)) return locked;
      bible = locked.value;
    }

    artifacts.push(`style-checksum:${bible.checksum}`);
    context.reportProgress({
      progress: 1,
      detail: isLocked(bible)
        ? `locked "${bible.name}" at ${bible.checksum.slice(0, 12)}`
        : `"${bible.name}" is a candidate; nothing downstream may generate against it yet`,
    });
    return ok({ artifacts });
  }

  /**
   * The bible this run is about.
   *
   * An id that names an existing row wins over a preset, so a run given both is using
   * the preset as a *description of what to create under that id* - which is the only
   * way a `[style, resolve, produce]` run can name its style before it exists, given
   * that a run payload is fixed before the first stage starts.
   */
  async #choose(request: StyleStageRequest): Promise<Result<StyleBible, AppError>> {
    const id = request.styleBibleId;

    if (id !== undefined) {
      const found = await this.#deps.repository.find(id);
      if (isErr(found)) return found;
      if (found.value !== null) return ok(found.value);
      if (request.preset === undefined) {
        return err(
          new ValidationError({
            message: `No style bible is stored under ${id}, and the payload names no preset to create one from.`,
            context: { styleBibleId: id },
          }),
        );
      }
    }

    const preset = request.preset;
    if (preset === undefined) {
      return err(
        new ValidationError({
          message: 'S1 needs either a preset or an existing style bible id.',
          context: {},
        }),
      );
    }
    return this.#materialise(preset, id);
  }

  async #materialise(
    preset: string,
    id: StyleBibleId | undefined,
  ): Promise<Result<StyleBible, AppError>> {
    const found = findPreset(preset);
    if (isErr(found)) return found;

    const bible = materialiseStyleBible({
      draft: found.value.draft,
      id: id ?? this.#deps.ids.styleBible(),
      clock: this.#deps.clock,
    });

    const stored = await this.#deps.repository.save(bible);
    if (isErr(stored)) return stored;
    return ok(bible);
  }
}
