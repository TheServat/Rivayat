/**
 * S1, the "I already have a look" path: references in, a proposed bible out.
 *
 * The result is explicitly a *proposal*. It is a `StyleBibleDraft`, it has no id, no
 * checksum and no lock, and the notes on it say which parts were measured, which were
 * observed and which were inherited - because the user is going to edit it, and editing
 * blind is how a style ends up half-derived and half-default with nobody able to say
 * which half is which.
 */

import { Buffer } from 'node:buffer';

import type { StyleAnchor, StyleBibleDraft } from '@rv/contracts';
import type {
  ImagePayload as PromptImage,
  StructuredBackend,
  StructuredTrace,
} from '@rv/prompt-kit';
import { type StructuredCall } from '@rv/prompt-kit';
import type { ImagePayload } from '@rv/providers';
import {
  type AppError,
  type Logger,
  NoopLogger,
  type Result,
  ValidationError,
  err,
  isErr,
  ok,
  sha256,
} from '@rv/shared-kernel';

import { type MeasuredPalette, extractPalette } from '../colour/palette';
import type { RasterPort } from '../ports/raster';
import { observationsToDraft } from './map-observations';
import { StyleObservations } from './observations';
import { DERIVE_SYSTEM_PROMPT, buildDerivePrompt } from './prompt';

/** Mime types a vision turn can actually carry. */
const SUPPORTED_MIME = new Set<PromptImage['mimeType']>(['image/png', 'image/jpeg', 'image/webp']);

/** More than this and the references stop describing one style and start describing a mood board. */
const MAX_REFERENCES = 8;

/** Swatches to pull out of the reference pixels. Six roles are named; the rest are neutrals. */
const MEASURED_SWATCHES = 6;

export interface StyleReference {
  readonly image: ImagePayload;
  /** Defaults to `exemplar`. `counter-example` references are shown but marked "not this". */
  readonly role?: StyleAnchor['role'];
  readonly note?: string;
}

export interface DeriveStyleFromReferencesInput {
  readonly references: readonly StyleReference[];
  readonly name: string;
  /** Base seed for the derived style. Injected, never generated - determinism (CLAUDE.md §1). */
  readonly seed: number;
  /** Optional brief from S0 Intake, as background only. */
  readonly brief?: string;
  readonly signal?: AbortSignal;
}

export interface DerivedStyleProposal {
  readonly draft: StyleBibleDraft;
  /** What the model reported, kept so a surprising field can be traced to the evidence. */
  readonly observations: StyleObservations;
  /** `null` when no `RasterPort` was supplied and the palette had to be taken on trust. */
  readonly measuredPalette: MeasuredPalette | null;
  readonly trace: StructuredTrace;
}

export interface DeriveStyleFromReferencesDeps {
  readonly structuredCall: StructuredCall;
  /**
   * Vision-capable backends, cheapest first.
   *
   * `StructuredCall` escalates down this chain, so the free local lane goes first and
   * only a reference set it cannot read costs anything.
   */
  readonly backends: readonly StructuredBackend[];
  /** Absent means the palette is described rather than measured, and the proposal says so. */
  readonly raster?: RasterPort;
  readonly logger?: Logger;
}

/**
 * Derives a candidate style from reference images.
 *
 * Every model call goes through `StructuredCall` (CLAUDE.md §6) - including this one,
 * which is why the reference images ride in as a `context` turn rather than through a
 * bespoke vision client. `PromptMessage` carries `images`, so the sanctioned path
 * already supports what this needs; a second parse/repair loop here would be one more
 * copy to keep in step with research §1.
 */
export class DeriveStyleFromReferencesUseCase {
  readonly #structuredCall: StructuredCall;
  readonly #backends: readonly StructuredBackend[];
  readonly #raster: RasterPort | undefined;
  readonly #logger: Logger;

  constructor(deps: DeriveStyleFromReferencesDeps) {
    this.#structuredCall = deps.structuredCall;
    this.#backends = deps.backends;
    this.#raster = deps.raster;
    this.#logger = deps.logger ?? new NoopLogger();
  }

  async execute(
    input: DeriveStyleFromReferencesInput,
  ): Promise<Result<DerivedStyleProposal, AppError>> {
    const references = this.#validate(input);
    if (isErr(references)) return references;

    // Measured first, and independently of the model: it costs nothing, it cannot fail
    // the whole derivation, and having it in hand means a model that hallucinates a
    // palette is overruled rather than believed.
    const measuredPalette = await this.#measurePalette(input.references);

    const turns = references.value;
    const outcome = await this.#structuredCall.run({
      schemaName: 'StyleObservations',
      schema: StyleObservations,
      backends: this.#backends,
      system: DERIVE_SYSTEM_PROMPT,
      user: buildDerivePrompt({
        referenceCount: input.references.length,
        ...(input.brief === undefined ? {} : { brief: input.brief }),
      }),
      context: [{ role: 'user', content: REFERENCE_TURN, images: turns }],
      temperature: 0,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    if (isErr(outcome)) {
      this.#logger.warn('style derivation: no backend produced usable observations', {
        attempts: outcome.error.trace.attempts,
        failedPaths: outcome.error.trace.failedPaths,
      });
      return err(outcome.error.error);
    }

    const draft = observationsToDraft({
      observations: outcome.value.value,
      name: input.name,
      seed: input.seed,
      measuredPalette,
      anchors: this.#anchors(input.references),
    });

    return ok({
      draft,
      observations: outcome.value.value,
      measuredPalette,
      trace: outcome.value.trace,
    });
  }

  /**
   * Rejects what cannot be sent before anything is spent.
   *
   * An unsupported mime type is a `ValidationError` rather than a silent drop: a
   * derivation that quietly ignored two of four references would produce a style that
   * matches the wrong half of the mood board, and nothing in the output would say so.
   */
  #validate(input: DeriveStyleFromReferencesInput): Result<readonly PromptImage[], AppError> {
    if (input.references.length === 0) {
      return err(
        new ValidationError({
          message: 'Deriving a style needs at least one reference image.',
          context: { references: 0 },
        }),
      );
    }
    if (input.references.length > MAX_REFERENCES) {
      return err(
        new ValidationError({
          message: `At most ${String(MAX_REFERENCES)} references; ${String(input.references.length)} were given.`,
          context: { references: input.references.length, max: MAX_REFERENCES },
        }),
      );
    }

    const turns: PromptImage[] = [];
    for (const [index, reference] of input.references.entries()) {
      const mimeType = reference.image.mimeType as PromptImage['mimeType'];
      if (!SUPPORTED_MIME.has(mimeType)) {
        return err(
          new ValidationError({
            message: `Reference ${String(index)} is "${reference.image.mimeType}"; a vision turn carries png, jpeg or webp.`,
            context: { index, mimeType: reference.image.mimeType },
          }),
        );
      }
      turns.push({
        mimeType,
        base64: Buffer.from(reference.image.data).toString('base64'),
        hash: sha256(reference.image.data),
      });
    }
    return ok(turns);
  }

  /**
   * Merges every reference's pixels into one palette.
   *
   * Counter-examples are excluded: "explicitly not this" colours belong in the negative
   * prompt, not in the palette the whole series is built from.
   */
  async #measurePalette(references: readonly StyleReference[]): Promise<MeasuredPalette | null> {
    const raster = this.#raster;
    if (raster === undefined) return null;

    const swatches: { hex: string; share: number }[] = [];
    let sampled = 0;

    for (const reference of references) {
      if (reference.role === 'counter-example') continue;
      const decoded = await raster.decode(reference.image);
      if (isErr(decoded)) {
        // A decoder failure degrades to the described palette rather than failing the
        // derivation: the model's colours are worse, but they are not nothing.
        this.#logger.warn('style derivation: reference could not be decoded', {
          code: decoded.error.code,
        });
        continue;
      }
      const measured = extractPalette(decoded.value, { count: MEASURED_SWATCHES });
      sampled += measured.sampled;
      for (const swatch of measured.swatches) {
        swatches.push({ hex: swatch.hex, share: swatch.share * measured.sampled });
      }
    }

    if (swatches.length === 0 || sampled === 0) return null;

    // Same hex from two references is one swatch with the combined share. Ordering is
    // share-desc then hex-asc so the result is total and reproducible.
    const merged = new Map<string, number>();
    for (const swatch of swatches) {
      merged.set(swatch.hex, (merged.get(swatch.hex) ?? 0) + swatch.share);
    }
    const combined = [...merged.entries()]
      .map(([hex, weight]) => ({ hex, share: weight / sampled }))
      .sort((left, right) => right.share - left.share || left.hex.localeCompare(right.hex))
      .slice(0, MEASURED_SWATCHES);

    return { swatches: combined, sampled };
  }

  #anchors(references: readonly StyleReference[]): readonly StyleAnchor[] {
    return references.map((reference) => ({
      imageHash: sha256(reference.image.data),
      role: reference.role ?? 'exemplar',
      ...(reference.note === undefined ? {} : { note: reference.note }),
    }));
  }
}

const REFERENCE_TURN =
  'These are the reference images. Examine all of them before answering anything.';
