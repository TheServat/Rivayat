/**
 * The stage handlers this app can actually run today, and honest stubs for the rest.
 *
 * Two stages have engine-free implementations and are wired for real:
 *
 * - **S0 Intake** validates the brief the run was started with against `Brief` from
 *   `@rv/contracts`. That is the whole of S0 - "free text to a `Brief`" - for a brief
 *   that arrived already structured, which is the case for every API caller.
 * - **S5 Resolve** runs `ResolveAssetDemandUseCase`, which reads the dedup index and
 *   prices the misses without calling a provider or writing anything. It is the screen
 *   the user approves before money moves, and it is fully implemented in
 *   `@rv/asset-registry` today.
 *
 * The other ten are bound to {@link StubStageHandler}, which returns the same 501 the
 * engine ports do, naming the package that owes the work. That is what makes the
 * wiring testable: a run of `[intake, resolve]` completes end to end, and a run that
 * asks for `story` fails with a diagnosis rather than a hang.
 */

import {
  Brief,
  type AssetSpec,
  type PipelineStageKey,
  type Sha256Hex,
  type Slug,
  type StyleBibleId,
} from '@rv/contracts';
import type { ResolveAssetDemandUseCase } from '@rv/asset-registry';
import { type AppError, type Result, err, isErr, nanoUsd, ok } from '@rv/shared-kernel';

import { notImplemented } from '../application/not-implemented';
import { toValidationError } from '../common/zod-validation.pipe';
import type { StageContext, StageHandler, StageOutput } from './stage';

/** Which package owes each unimplemented stage. Data, so the message is never guessed. */
export const STAGE_OWNER: Readonly<Record<PipelineStageKey, string>> = {
  intake: '@rv/api',
  style: '@rv/style-engine',
  story: '@rv/story-engine',
  cast: '@rv/story-engine',
  world: '@rv/story-engine',
  resolve: '@rv/asset-registry',
  produce: '@rv/asset-engine',
  sequence: '@rv/story-engine',
  choreograph: '@rv/anim-engine',
  preview: '@rv/anim-engine',
  render: '@rv/render-engine',
  deliver: '@rv/render-engine',
};

/**
 * S0 Intake.
 *
 * Validation *is* the stage for a structured brief: the pipeline's contract is that
 * every stage after this one receives a `Brief`, and a run that started with something
 * else has to fail here rather than eight stages later with a shape error nobody can
 * trace back.
 */
export class IntakeStageHandler implements StageHandler {
  readonly stage = 'intake' as const;

  execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    context.reportProgress(0.1, 'validating the brief');

    const parsed = Brief.safeParse(context.job.payload.brief);
    if (!parsed.success) {
      return Promise.resolve(err(toValidationError(parsed.error, 'run.brief')));
    }

    context.reportProgress(1, `accepted a ${parsed.data.kind} brief`);
    return Promise.resolve(ok({ artifacts: [`brief:${parsed.data.kind}`] }));
  }
}

/** What S5 needs on the job payload. Absent fields are a validation failure, not a skip. */
interface ResolvePayload {
  readonly specs: readonly AssetSpec[];
  readonly styleBibleId: StyleBibleId;
  readonly styleChecksum: Sha256Hex;
  readonly variantKey?: Slug;
}

/**
 * S5 Resolve.
 *
 * Writes nothing and calls no provider - the use-case asserts that property directly -
 * so it is safe to run before the budget has been approved. That is the point: the
 * estimate has to exist before anyone agrees to pay it.
 */
export class ResolveStageHandler implements StageHandler {
  readonly stage = 'resolve' as const;
  readonly #useCase: ResolveAssetDemandUseCase;

  constructor(useCase: ResolveAssetDemandUseCase) {
    this.#useCase = useCase;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const payload = context.job.payload as unknown as Partial<ResolvePayload>;
    if (
      payload.specs === undefined ||
      payload.styleChecksum === undefined ||
      payload.styleBibleId === undefined
    ) {
      return notImplemented<StageOutput>(
        'S5 resolve without a style bible and asset specs - S1 and S4 must run first',
        '@rv/story-engine',
      );
    }

    context.reportProgress(0.2, `resolving ${String(payload.specs.length)} specs`);

    const plan = await this.#useCase.execute({
      specs: payload.specs,
      styleBibleId: payload.styleBibleId,
      styleChecksum: payload.styleChecksum,
      ...(payload.variantKey === undefined ? {} : { variantKey: payload.variantKey }),
      ...(context.run.budgetNanoUsd === null
        ? {}
        : { budgetNanoUsd: nanoUsd(context.run.budgetNanoUsd) }),
    });
    if (isErr(plan)) return plan;

    context.reportProgress(
      1,
      `${String(plan.value.hitCount)} already in the library, ${String(plan.value.missCount)} to generate`,
    );
    return ok({
      artifacts: [
        `asset-demand-plan:${String(plan.value.hitCount)}/${String(plan.value.missCount)}`,
      ],
    });
  }
}

/**
 * A stage whose engine does not exist yet.
 *
 * Not omitted from the registry: a missing key and a stub are different failures, and
 * only the stub can say which package to go and look at.
 */
export class StubStageHandler implements StageHandler {
  readonly stage: PipelineStageKey;

  constructor(stage: PipelineStageKey) {
    this.stage = stage;
  }

  execute(_context: StageContext): Promise<Result<StageOutput, AppError>> {
    return Promise.resolve(
      notImplemented<StageOutput>(`pipeline stage "${this.stage}"`, STAGE_OWNER[this.stage]),
    );
  }
}
