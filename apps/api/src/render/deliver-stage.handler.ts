/**
 * S11 Deliver, wired: one master becomes seven platform files, each probed against the
 * profile it claims to satisfy.
 *
 * `DeliverEpisodeUseCase` in `@rv/render-engine` owns the work - solve a plan,
 * build the filter graph, transcode, probe, validate - and has owned it for a while
 * with nothing calling it. This is the joint, and it answers the three questions the
 * use case cannot answer for itself.
 *
 * **Which master.** The one this run rendered. S10 files everything under the render's
 * content address and records `render-key:<sha>`, so the delivery finds the master by
 * asking the run what it made rather than by being told a path. The same key is
 * recorded again here, which is what makes `GET /api/runs/:id/delivery` work for a run
 * that only delivered - a re-delivery of last week's master is a legitimate run, and it
 * still has to be able to say what it produced.
 *
 * **Which shots.** From the `Choreography` record filed beside the composition, because
 * an `AnimationIR` has no shots and a crop is per shot. Where there is no record the
 * whole timeline is treated as one shot - a correct answer to "frame this composition"
 * and a poor one to "frame this episode", so the difference is logged rather than
 * hidden.
 *
 * **Where the subject is.** Through `sampleFocusTrack`, which evaluates the node and
 * **projects it through the camera**. This is the defect that shipped and was fixed:
 * the crop is applied to a master that has the camera baked into every layer, so
 * normalising a raw scene position answers a different question - where the subject
 * sits on the authoring canvas - and on this repo's own fixture the two answers differed
 * by a quarter of the frame width against a crop only a third of it. The subject left
 * the frame. Nothing in this file normalises a position itself.
 *
 * **Formats are grouped by aspect, and that is not an optimisation.** `SceneSpace.
 * overrides` carries a hand-authored crop *per delivery aspect*, `ShotFraming.override`
 * is one crop per shot, and applying the 9:16 override to the 16:9 file would be
 * actively wrong. One solve per aspect is the smallest unit that can honour them, so
 * the files are grouped into `<outputDir>/<aspect>/` and each group is solved with its
 * own overrides.
 *
 * `$0`, and provably: nothing here calls a provider. A delivery is seven transcodes of
 * a file that already exists, which is what makes RV-170's "the ledger shows
 * `nanoUsd === 0` for the delivery run" true rather than aspirational.
 */

import { readFile, writeFile } from 'node:fs/promises';

import {
  DELIVERY_ASPECTS,
  FORMAT_PRESETS,
  type AnimationIR,
  type DeliveryAspect,
  type FormatProfileId,
  type NormRect,
  type ShotId,
  type Size,
} from '@rv/contracts';
import { deriveId } from '@rv/anim-engine';
import {
  DeliverEpisodeUseCase,
  FfmpegEncoder,
  FfprobeReader,
  FileArtifactStore,
  sampleFocusTrack,
  satisfiesProfile,
  staticFocusTrack,
  type DeliveryEntry,
  type ShotFraming,
  type ShotTiming,
} from '@rv/render-engine';
import {
  ValidationError,
  at,
  err,
  isErr,
  ok,
  toIso,
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';

import { toValidationError } from '../common/zod-validation.pipe';
import type { CompositionStore } from '../modules/compositions/composition.store';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
import type { ShotTimeline } from './choreography.contracts';
import type { ChoreographyStore } from './choreography.store';
import { compositionReference } from './composition-source';
import { DeliverStageRequest } from './deliver-stage.contracts';
import { RunDelivery, type DeliveredFile } from './delivery.contracts';
import { renderKeyOf } from './delivery.service';
import { renderLayout } from './render-stage.handler';

/** The subject region for a composition nobody framed: a centred third. */
const DEFAULT_FOCUS: NormRect = { x: 1 / 3, y: 1 / 3, width: 1 / 3, height: 1 / 3 };
const FULL_FRAME: NormRect = { x: 0, y: 0, width: 1, height: 1 };
/** Aspect agreement between master and composition, as a fraction. */
const ASPECT_TOLERANCE = 0.01;

export interface DeliverStageHandlerDeps {
  readonly encoder: FfmpegEncoder;
  readonly prober: FfprobeReader;
  readonly compositions: CompositionStore;
  readonly choreography: ChoreographyStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly workspaceDir: string;
}

/** The master a delivery is cut from, however it was found. */
interface Master {
  readonly path: string;
  readonly size: Size;
  readonly durationMs: number;
  readonly frameCount: number;
  readonly file: DeliveredFile | null;
}

export class DeliverStageHandler implements StageHandler {
  readonly stage = 'deliver' as const;
  readonly implemented = true;
  readonly #deps: DeliverStageHandlerDeps;

  constructor(deps: DeliverStageHandlerDeps) {
    this.#deps = deps;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const parsed = DeliverStageRequest.safeParse(context.job.payload.deliver ?? {});
    if (!parsed.success) return err(toValidationError(parsed.error, 'run.payload.deliver'));
    const request = parsed.data;

    const key = request.renderKey ?? renderKeyOf(context.run);
    if (key === null) {
      return err(
        new ValidationError({
          message:
            'this run has no rendered master to deliver: run the render stage first, or name ' +
            'an existing one with `payload.deliver.renderKey`',
          context: { runId: context.run.id },
        }),
      );
    }

    const layout = renderLayout(this.#deps.workspaceDir, key, 'h264');
    const master = await this.#master(layout.manifest, request.masterPath);
    if (isErr(master)) return master;

    const composition = await this.#composition(context, request.compositionId);
    if (isErr(composition)) return composition;

    const scene = composition.value?.ir.sceneSpace ?? master.value.size;
    const agrees = aspectAgrees(scene, master.value.size);
    if (!agrees) {
      return err(
        new ValidationError({
          message:
            `the master is ${String(master.value.size.width)}x${String(master.value.size.height)} ` +
            `and the composition is ${String(scene.width)}x${String(scene.height)}; a crop solved ` +
            'against one aspect cannot be applied to the other',
          context: { master: master.value.size, composition: scene },
        }),
      );
    }

    const shots = await this.#shots(composition.value?.compositionId ?? null);
    if (isErr(shots)) return shots;

    const timeline = clampToMaster(
      shots.value ?? [derivedShot(key, master.value.durationMs)],
      master.value.durationMs,
    );
    if (shots.value === null) {
      this.#deps.logger.info('delivering an uncut composition as one shot', { renderKey: key });
    }

    const outputDir = request.outputDir ?? `deliveries/${key}`;
    const artifacts = new FileArtifactStore(this.#deps.workspaceDir);
    const useCase = new DeliverEpisodeUseCase({
      encoder: this.#deps.encoder,
      prober: this.#deps.prober,
      artifacts,
      clock: this.#deps.clock,
    });

    const groups = groupByAspect(request.formats);
    const entries: DeliveryEntry[] = [];
    let done = 0;

    for (const [aspect, formats] of groups) {
      const leading = at(formats, 0, 'format');
      context.reportProgress({
        progress: done / request.formats.length,
        detail: `cutting ${formats.map((format) => FORMAT_PRESETS[format].label).join(', ')}`,
        item: { kind: 'format', key: leading, index: done, total: request.formats.length },
      });
      done += formats.length;

      const framings = timeline.map((shot) =>
        framingFor(shot, aspect, composition.value?.ir ?? null),
      );
      const timings: ShotTiming[] = timeline.map((shot) => ({
        shotId: shot.shotId,
        startMs: shot.startMs,
        durationMs: shot.durationMs,
      }));

      const delivered = await useCase.execute({
        masterPath: master.value.path,
        masterSize: master.value.size,
        animationId: composition.value?.ir.id ?? key,
        frameCount: master.value.frameCount,
        outputDir: `${outputDir}/${aspectSlug(aspect)}`,
        formats,
        reframe: { composition: scene, shots: framings },
        timings,
        ...(request.maxPanPerSecond === undefined
          ? {}
          : { solve: { maxPanPerSecond: request.maxPanPerSecond } }),
        validate: { checkBitrate: request.checkBitrate },
      });
      if (isErr(delivered)) return delivered;
      entries.push(...delivered.value.manifest.entries);

      // A cancelled run must not spend the next four minutes finishing the other six
      // files. Checked between groups because a transcode is the unit here - the same
      // reason S10 checks between frames.
      if (context.signal.aborted) break;
    }

    const files = entries.map(toDeliveredFile);
    const manifest: RunDelivery = {
      renderKey: key,
      composition: scene,
      files: [...(master.value.file === null ? [] : [master.value.file]), ...files],
      // Both halves of "needs eyes": a file that violates its own spec, and a plan that
      // could not keep the subject in the safe area. The second produces a file that is
      // technically in spec and framed wrongly, which is the more expensive mistake.
      needsAttention:
        files.some((file) => file.inSpec === false) || entries.some((entry) => entry.needsReview),
      createdAt: toIso(this.#deps.clock.now()),
    };

    const written = await this.#writeManifest(layout.manifest, manifest);
    if (isErr(written)) return written;

    this.#deps.logger.info('delivered', {
      renderKey: key,
      files: files.length,
      needsAttention: manifest.needsAttention,
    });

    context.reportProgress({
      progress: 1,
      detail: `${String(files.length)} files, ${String(files.filter((file) => file.inSpec === true).length)} in spec`,
    });

    return ok({
      artifacts: [
        // Recorded again so a delivery-only run can still answer `GET /runs/:id/delivery`.
        `render-key:${key}`,
        ...files.map((file) => `delivery:${file.format ?? 'unknown'}:${file.sha256}`),
        `delivery-manifest:${outputDir}`,
      ],
      // The timeline's own duration, not seven times it: seven files are seven cuts of
      // one episode, and `deliveredMsOf` takes the last stage that reported rather than
      // the sum precisely so cost per delivered minute stays a number about the episode.
      deliveredMs: master.value.durationMs,
    });
  }

  /** The master, from S10's manifest or from a path the payload named. */
  async #master(
    manifestPath: string,
    override: string | undefined,
  ): Promise<Result<Master, AppError>> {
    const manifest = await this.#readManifest(manifestPath);
    if (isErr(manifest)) return manifest;

    const recorded = manifest.value?.files.find((file) => file.kind === 'master') ?? null;
    if (recorded !== null && override === undefined) {
      return ok({
        path: recorded.path,
        size: recorded.size,
        durationMs: recorded.durationMs,
        frameCount: recorded.frameCount ?? Math.max(1, Math.round(recorded.durationMs / 1000)),
        file: recorded,
      });
    }

    if (override === undefined) {
      return err(
        new ValidationError({
          message:
            'the render produced no delivery manifest, so the master cannot be located or ' +
            'measured; name it with `payload.deliver.masterPath`',
          context: { manifest: manifestPath },
        }),
      );
    }

    // Named by hand: measured here rather than assumed, because every crop below is a
    // fraction of this frame.
    const store = new FileArtifactStore(this.#deps.workspaceDir);
    const probed = await this.#deps.prober.probe(store.resolve(override));
    if (isErr(probed)) return probed;

    return ok({
      path: override,
      size: { width: probed.value.width, height: probed.value.height },
      durationMs: Math.round(probed.value.durationMs),
      frameCount:
        probed.value.frameCount ??
        Math.max(1, Math.round((probed.value.durationMs / 1000) * probed.value.fps)),
      file: null,
    });
  }

  /**
   * The composition the master was rendered from, or `null`.
   *
   * `null` is a legitimate answer: a master rendered from an inline IR that was never
   * stored can still be delivered, it simply cannot have its subject followed. An
   * explicitly named composition that does not exist is a different thing, and fails.
   */
  async #composition(
    context: StageContext,
    named: string | undefined,
  ): Promise<Result<{ ir: AnimationIR; compositionId: string | null } | null, AppError>> {
    const reference = compositionReference(context, { compositionId: named });
    if (reference.ir !== undefined) return ok({ ir: reference.ir, compositionId: null });

    const id = reference.compositionId;
    if (id === undefined) return ok(null);

    const found = await this.#deps.compositions.find(id);
    if (isErr(found)) return found;
    if (found.value === null) {
      return named === undefined
        ? ok(null)
        : err(
            new ValidationError({
              message: `No composition is stored under ${id}`,
              context: { compositionId: id },
            }),
          );
    }
    return ok({ ir: found.value.ir, compositionId: id });
  }

  /** The shot list for this composition, or `null` when nobody choreographed it. */
  async #shots(
    compositionId: string | null,
  ): Promise<Result<readonly ShotTimeline[] | null, AppError>> {
    if (compositionId === null) return ok(null);
    const record = await this.#deps.choreography.find(compositionId);
    if (isErr(record)) return record;
    return ok(record.value === null || record.value.shots.length === 0 ? null : record.value.shots);
  }

  async #readManifest(path: string): Promise<Result<RunDelivery | null, AppError>> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return ok(null);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `the render manifest at ${path} is not readable`,
          cause: caught,
          context: { path },
        }),
      );
    }

    const manifest = RunDelivery.safeParse(parsed);
    return manifest.success
      ? ok(manifest.data)
      : err(toValidationError(manifest.error, 'render.manifest'));
  }

  async #writeManifest(path: string, manifest: RunDelivery): Promise<Result<void, AppError>> {
    try {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      return ok(undefined);
    } catch (caught: unknown) {
      // Fatal, unlike S10's. There, a manifest that could not be written cost a
      // description of one master; here it *is* the delivery's verdict, and a run that
      // reported success with no record of what it produced is the failure this whole
      // route exists to remove.
      return err(
        new ValidationError({
          message: `the delivery manifest could not be written to ${path}`,
          cause: caught,
          context: { path },
        }),
      );
    }
  }
}

// ── framing ─────────────────────────────────────────────────────────────────

/**
 * One shot as the solver needs it, with the subject located through the camera.
 *
 * A hand-authored crop for *this* aspect wins outright: "an author who has framed a
 * shot by hand must not have it re-solved underneath them".
 */
function framingFor(shot: ShotTimeline, aspect: string, ir: AnimationIR | null): ShotFraming {
  const region = shot.focusRegion;
  const override = isDeliveryAspect(aspect) ? shot.overrides[aspect] : undefined;

  const focus =
    ir === null || shot.focusNodeId === null
      ? staticFocusTrack(region)
      : sampleFocusTrack(ir, shot.focusNodeId, region, {
          startMs: shot.startMs,
          durationMs: shot.durationMs,
        });

  return {
    shotId: shot.shotId,
    startMs: shot.startMs,
    durationMs: shot.durationMs,
    safeArea: shot.safeArea,
    focus,
    // `must-keep`: a subject the author named has to survive the crop. `prefer` would
    // let the solver drop it silently when the aspect is tight, which is the one
    // outcome nobody would choose on purpose.
    priority: 'must-keep',
    ...(override === undefined ? {} : { override }),
  };
}

/** The whole timeline as one shot, framed on the middle third. */
function derivedShot(key: string, durationMs: number): ShotTimeline {
  return {
    shotId: deriveId<ShotId>('sht', `derived:${key}`),
    startMs: 0,
    durationMs: Math.max(1, durationMs),
    focusNodeId: null,
    focusRegion: DEFAULT_FOCUS,
    safeArea: FULL_FRAME,
    overrides: {},
  };
}

/**
 * Shots trimmed to the master that actually exists.
 *
 * A sharded render produces a master shorter than the timeline it came from, and a
 * filter graph that trims past the end of its input produces an empty segment and a
 * failed concat. Trimming here means the delivery covers what was rendered.
 */
function clampToMaster(shots: readonly ShotTimeline[], durationMs: number): ShotTimeline[] {
  const kept: ShotTimeline[] = [];
  for (const shot of shots) {
    if (shot.startMs >= durationMs) break;
    const available = durationMs - shot.startMs;
    kept.push(
      shot.durationMs <= available ? shot : { ...shot, durationMs: Math.max(1, available) },
    );
  }
  if (kept.length > 0) return kept;

  // Every shot starts past the end of a master shorter than one shot: the delivery is
  // still the master, framed by the shot the author wrote for its opening.
  const first = at(shots, 0, 'shot');
  return [{ ...first, startMs: 0, durationMs: Math.max(1, durationMs) }];
}

/** Requested formats, in aspect groups, so per-aspect crops can be honoured. */
function groupByAspect(formats: readonly FormatProfileId[]): Map<string, FormatProfileId[]> {
  const groups = new Map<string, FormatProfileId[]>();
  for (const format of formats) {
    const aspect = FORMAT_PRESETS[format].aspectRatio;
    const bucket = groups.get(aspect);
    if (bucket === undefined) groups.set(aspect, [format]);
    else bucket.push(format);
  }
  return groups;
}

function aspectSlug(aspect: string): string {
  return aspect.replace(':', 'x');
}

function isDeliveryAspect(aspect: string): aspect is DeliveryAspect {
  return (DELIVERY_ASPECTS as readonly string[]).includes(aspect);
}

/** Two sizes present the same picture undistorted. */
function aspectAgrees(composition: Size, master: Size): boolean {
  const left = composition.width / composition.height;
  const right = master.width / master.height;
  return Math.abs(left - right) <= ASPECT_TOLERANCE * Math.max(left, right);
}

/** One engine entry as the run's delivery manifest carries it. */
function toDeliveredFile(entry: DeliveryEntry): DeliveredFile {
  return {
    kind: 'delivery',
    path: entry.artifact.path,
    format: entry.format,
    sha256: entry.artifact.sha256,
    bytes: entry.artifact.bytes,
    durationMs: Math.round(entry.probe.durationMs),
    size: { width: entry.probe.width, height: entry.probe.height },
    codecName: entry.probe.codecName,
    pixelFormat: entry.probe.pixelFormat,
    fps: entry.probe.fps,
    bitrateBps: entry.probe.bitrateBps,
    frameCount: entry.probe.frameCount,
    hasAudio: entry.probe.hasAudio,
    issues: entry.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      expected: issue.expected,
      actual: issue.actual,
    })),
    // A warning is not a failure. `satisfiesProfile` is the engine's own reading of its
    // own issues, so the verdict on the screen and the verdict in the CLI are one rule.
    inSpec: satisfiesProfile(entry.issues),
  };
}
