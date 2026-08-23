/**
 * Matted canvas in, named `Part[]` out - with an honest account of what did not fit.
 *
 * RV-124 wants a `parts-count-mismatch` failure when the sheet does not match the plan,
 * and RV-125 wants a fallback chain that reacts to it. Both need the same information,
 * so this use-case always produces the report and `strict` decides whether an
 * incomplete report is also an error. Returning only the error would throw away the
 * assignment the fallback chain needs to decide what to try next; returning only the
 * report would let an incomplete split flow onward unnoticed.
 */

import { type AppError, type Result, ValidationError, err, isErr, ok } from '@rv/shared-kernel';
import type { AssetSpec, Ids, Part, Sha256Hex } from '@rv/contracts';
import type { BlobStore } from '@rv/asset-registry';

import type { RasterPort, RgbaImage } from '../ports/raster-port';
import { alphaCoverage } from '../raster/alpha';
import { extentByRole } from '../rig/templates/index';
import { type AssignmentReport, assignComponents, toPlanTargets } from './assign-components';
import {
  type Component,
  type ComponentOptions,
  extractComponent,
  findComponents,
} from './connected-components';

export interface SplitPartsDeps {
  readonly raster: RasterPort;
  readonly blobs: BlobStore;
  readonly ids: Ids;
}

export interface SplitPartsInput {
  readonly spec: AssetSpec;
  /** The matted canvas: RGBA with the background already keyed out. */
  readonly image: RgbaImage;
  /**
   * `single-layer` skips segmentation entirely and registers the whole canvas as the
   * first planned part. It is the terminal fallback and also the correct primary for a
   * cloud, a sky or anything else with no separable pieces.
   */
  readonly decomposition?: 'parts-sheet' | 'segmented' | 'single-layer';
  readonly componentOptions?: ComponentOptions;
  /** Turns an incomplete assignment into a failure. Defaults to false. */
  readonly strict?: boolean;
}

export interface SplitPartsOutput {
  readonly parts: readonly Part[];
  readonly report: AssignmentReport;
  /** Components below the size floor. Speckle, usually - but reported, never hidden. */
  readonly discardedComponents: number;
  readonly decomposition: 'parts-sheet' | 'segmented' | 'single-layer';
}

export class SplitPartsUseCase {
  readonly #deps: SplitPartsDeps;

  constructor(deps: SplitPartsDeps) {
    this.#deps = deps;
  }

  async execute(input: SplitPartsInput): Promise<Result<SplitPartsOutput, AppError>> {
    const decomposition = input.decomposition ?? 'parts-sheet';
    const targets = toPlanTargets(input.spec.parts, extentByRole(input.spec.archetype));

    if (decomposition === 'single-layer') {
      return this.#singleLayer(input, targets);
    }

    const field = findComponents(input.image, input.componentOptions);
    const report = assignComponents(field.components, targets, {
      width: input.image.width,
      height: input.image.height,
    });

    if (input.strict === true && !report.complete) {
      return err(
        new ValidationError({
          message: 'parts-count-mismatch',
          context: {
            semanticKey: input.spec.semanticKey,
            planned: input.spec.parts.length,
            found: field.components.length,
            unfilled: report.unfilled.map((plan) => plan.name),
            unmatched: report.unmatched.map((component) => component.id),
          },
        }),
      );
    }

    const parts: Part[] = [];
    for (const assignment of report.assignments) {
      const cut = extractComponent(input.image, field, assignment.component);
      const stored = await this.#store(cut);
      if (isErr(stored)) return stored;
      parts.push(
        this.#toPart(input, assignment.plan.name, assignment.component, cut, stored.value),
      );
    }

    return ok({ parts, report, discardedComponents: field.discarded, decomposition });
  }

  /** One part, the whole canvas, trimmed to its alpha. Still mesh-deformable. */
  async #singleLayer(
    input: SplitPartsInput,
    targets: ReturnType<typeof toPlanTargets>,
  ): Promise<Result<SplitPartsOutput, AppError>> {
    const target = targets[0];
    if (target === undefined) {
      return err(
        new ValidationError({
          message: 'a spec must plan at least one part',
          context: { semanticKey: input.spec.semanticKey },
        }),
      );
    }

    const bounds = this.#deps.raster.trimBounds(input.image, 0) ?? {
      x: 0,
      y: 0,
      width: input.image.width,
      height: input.image.height,
    };
    const cropped = this.#deps.raster.crop(input.image, bounds);
    if (isErr(cropped)) return cropped;

    const stored = await this.#store(cropped.value);
    if (isErr(stored)) return stored;

    const pseudo: Component = {
      id: 1,
      bounds,
      pixelCount: Math.round(
        alphaCoverage(cropped.value) * cropped.value.width * cropped.value.height,
      ),
      centroid: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      fill: alphaCoverage(cropped.value),
    };

    return ok({
      parts: [this.#toPart(input, target.name, pseudo, cropped.value, stored.value)],
      report: {
        assignments: [{ plan: target, component: pseudo, cost: 0 }],
        unmatched: [],
        // Every other plan is unfilled by construction, and saying so is the point:
        // "we fell back to one layer" must be visible in the record, not inferred.
        unfilled: targets.slice(1),
        complete: targets.slice(1).every((plan) => plan.optional),
      },
      discardedComponents: 0,
      decomposition: 'single-layer',
    });
  }

  async #store(image: RgbaImage): Promise<Result<Sha256Hex, AppError>> {
    const encoded = this.#deps.raster.encode(image);
    if (isErr(encoded)) return encoded;
    const put = await this.#deps.blobs.put(encoded.value.data);
    if (isErr(put)) return put;
    return ok(put.value.hash);
  }

  #toPart(
    input: SplitPartsInput,
    name: string,
    component: Component,
    cut: RgbaImage,
    imageHash: Sha256Hex,
  ): Part {
    const plan = input.spec.parts.find((candidate) => candidate.name === name);
    return {
      id: this.#deps.ids.part(),
      name,
      role: plan?.role ?? name,
      imageHash,
      bounds: component.bounds,
      size: { width: cut.width, height: cut.height },
      // Centroid-relative pivot rather than the box centre: a crescent's centre of mass
      // is where it should rotate about, and its bounding-box centre is in the gap.
      pivot: {
        x: clamp01(
          (component.centroid.x - component.bounds.x) / Math.max(1, component.bounds.width),
        ),
        y: clamp01(
          (component.centroid.y - component.bounds.y) / Math.max(1, component.bounds.height),
        ),
      },
      zOrder: plan?.zOrder ?? 0,
      deformable: plan?.deformable ?? false,
      alphaCoverage: alphaCoverage(cut),
    };
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
