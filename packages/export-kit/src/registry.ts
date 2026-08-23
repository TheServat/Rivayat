/**
 * The format registry.
 *
 * CLAUDE.md §2: *no `switch` on a format name in core*. A format is an entry in a map and
 * an implementation of {@link Exporter}, so adding Rive tomorrow is a class and a
 * `register` call - nothing in this file, the port, or any caller changes. The union
 * never grows, so there is no union to keep exhaustive.
 *
 * The registry is also where "what would I lose?" is answerable **before** an export is
 * paid for: every entry carries its declared {@link FormatCapabilities}, so a UI can list
 * the formats, show what each one drops for the document in hand, and only then run one.
 */

import {
  type AppError,
  type Clock,
  type Result,
  ConflictError,
  NotFoundError,
  err,
  ok,
} from '@rv/shared-kernel';
import type { AnimationIR } from '@rv/contracts';

import { detectFeatures } from './features';
import type { ExportOptions } from './options';
import type { ImageEncoderPort } from './pixels';
import type { ExportFormatId, ExportInput, ExportOutput, Exporter } from './port';
import { type ExportWarning, diffFeatures } from './warnings';

import { AtlasExporter } from './atlas/atlas-exporter';
import { DragonBonesExporter } from './dragonbones/dragonbones-exporter';
import { FramesExporter } from './frames/frames-exporter';
import { LottieExporter } from './lottie/lottie-exporter';

export class ExporterRegistry {
  readonly #byId = new Map<ExportFormatId, Exporter>();

  /**
   * Registers a format.
   *
   * Throws on a duplicate id rather than returning a `Result`: two implementations
   * claiming one format id is a wiring mistake in the composition root, not a runtime
   * condition a caller can recover from.
   */
  register(exporter: Exporter): void {
    if (this.#byId.has(exporter.id)) {
      throw new ConflictError({
        message: `an exporter is already registered for "${exporter.id}"`,
        context: { format: exporter.id },
      });
    }
    this.#byId.set(exporter.id, exporter);
  }

  get(id: ExportFormatId): Result<Exporter, AppError> {
    const exporter = this.#byId.get(id);
    return exporter === undefined ? err(new NotFoundError('exporter', id)) : ok(exporter);
  }

  /** Registration order, which is the order a picker should show them in. */
  list(): readonly Exporter[] {
    return [...this.#byId.values()];
  }

  /**
   * What each registered format would lose for this document, without exporting anything.
   *
   * The point of declaring capabilities statically: choosing a format is a decision about
   * what you can afford to lose, and it should be possible to make that decision before
   * committing to the work.
   */
  preview(ir: AnimationIR): readonly {
    readonly format: ExportFormatId;
    readonly label: string;
    readonly warnings: readonly ExportWarning[];
  }[] {
    const present = detectFeatures(ir);
    return this.list().map((exporter) => ({
      format: exporter.id,
      label: exporter.label,
      warnings: diffFeatures(present, exporter.capabilities),
    }));
  }

  async export(
    id: ExportFormatId,
    input: ExportInput,
    options?: ExportOptions,
  ): Promise<Result<ExportOutput, AppError>> {
    const exporter = this.get(id);
    if (!exporter.ok) return exporter;
    return exporter.value.export(input, options);
  }
}

export interface DefaultExportersDeps {
  /**
   * Turns RGBA into a file. Omit it and the pixel-bearing formats are simply not
   * registered - which is better than registering a format that fails on use.
   */
  readonly encoder?: ImageEncoderPort;
  /** Read exactly once, for the frame manifest's `createdAt`. */
  readonly clock: Clock;
}

/**
 * The four formats this package ships.
 *
 * Lottie and DragonBones need nothing but the IR, so they are always available. The atlas
 * and frame-sequence formats write pixels, so they appear only when an encoder is wired
 * up. A caller can inspect {@link ExporterRegistry.list} to find out which it got.
 */
export function createDefaultRegistry(deps: DefaultExportersDeps): ExporterRegistry {
  const registry = new ExporterRegistry();
  registry.register(new LottieExporter());
  registry.register(
    new DragonBonesExporter(deps.encoder === undefined ? {} : { encoder: deps.encoder }),
  );
  if (deps.encoder !== undefined) {
    registry.register(new AtlasExporter({ encoder: deps.encoder }));
    registry.register(new FramesExporter({ encoder: deps.encoder, clock: deps.clock }));
  }
  return registry;
}
