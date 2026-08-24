/**
 * `StyleEnginePort`, for real, over `@rv/style-engine`.
 *
 * The port was declared when the engine was a scaffold and bound to a stub that
 * answered 501 with the package that owed the work. The package now owes nothing: the
 * presets, the derivation, the probe and the scorer are all built and tested. This is
 * the joint, and it is only a joint - every decision it makes is a binding.
 *
 * Three of them are worth naming, because they are the reason this file is not four
 * one-line delegations.
 *
 * **A bible has to persist between requests.** Choose, probe and lock are three HTTP
 * calls against the same document; the client holds an id and the server has to resolve
 * it. `materialiseStyleBible` mints one and nothing stored it, so every route here
 * writes through {@link StyleBibleRepository} before it answers.
 *
 * **The probe seals rather than locks.** See `probe-seal.ts` - the whole of that
 * decision lives there.
 *
 * **A probe tile's bytes go into the content store on the way out.** Four PNGs inlined
 * as base64 is a JSON body of a few megabytes that no client can cache and every proxy
 * re-transfers; the store already addresses bytes by hash, and a hash is immutable, so
 * `GET /api/blobs/<hash>` is cacheable forever by construction.
 */

import type { BlobStore } from '@rv/asset-registry';
import {
  ProviderKind,
  type Brief,
  type Ids,
  type Slug,
  type StyleBible,
  type StyleBibleId,
} from '@rv/contracts';
import { lock } from '@rv/core-domain';
import type { StructuredBackend } from '@rv/prompt-kit';
import { StructuredCall } from '@rv/prompt-kit';
import type { ImageGenerationPort } from '@rv/providers';
import {
  DeriveStyleFromReferencesUseCase,
  GenerateStyleProbeUseCase,
  STYLE_PRESETS,
  findPreset,
  materialiseStyleBible,
  type ProbeSpendGuard,
  type RasterPort as StyleRasterPort,
  type StyleProbeLane as EngineProbeLane,
  type StyleReference,
} from '@rv/style-engine';
import {
  NotFoundError,
  ValidationError,
  contentHash,
  err,
  isErr,
  ok,
  toIso,
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';

import type {
  DeriveStyleRequest,
  ProbeStyleRequest,
  StyleEnginePort,
} from '../application/ports/engine.ports';
import {
  StylePresetList,
  StyleProbeSheet,
  type StyleProbeTile,
} from '../modules/style/style.contracts';
import { sealForProbe } from './probe-seal';
import type { StyleBibleRepository } from './style-bible.repository';

/** Where a content-addressed artefact is served from. Relative: the origin is the client's. */
export function blobUrl(hash: string): string {
  return `/api/blobs/${hash}`;
}

export interface StyleEngineAdapterDeps {
  readonly repository: StyleBibleRepository;
  readonly blobs: BlobStore;
  readonly ids: Ids;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * One image port per probe lane.
   *
   * A map rather than two fields, because that is the shape the use-case declares and
   * because an unwired lane must be a refusal that names the lane rather than an
   * adapter that throws on first use. On a machine with no ComfyUI and no cloud key
   * this is empty, and `POST /style/:id/probe` says so.
   */
  readonly imageLanes: Partial<Record<EngineProbeLane, ImageGenerationPort>>;
  /**
   * Vision-capable structured backends, cheapest first, for derivation.
   *
   * Empty on a machine with no model configured, which makes `POST /style/derive` fail
   * by naming what is missing rather than with a 501 blaming a package that is finished.
   */
  readonly backends: readonly StructuredBackend[];
  /** Reads pixels, so a derived palette is measured rather than described. */
  readonly raster: StyleRasterPort;
  /** Consulted before every tile. Absent is only safe on the free lane. */
  readonly budget?: ProbeSpendGuard;
}

export class StyleEngineAdapter implements StyleEnginePort {
  readonly #deps: StyleEngineAdapterDeps;
  readonly #logger: Logger;

  constructor(deps: StyleEngineAdapterDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ component: 'style-engine' });
  }

  /**
   * The shelf, whole.
   *
   * A projection and not a query: `STYLE_PRESETS` is compiled at module load and is
   * pure, so this touches nothing. `medium` is dropped because it is
   * `draft.visual.medium` and a second copy is a second thing to keep in step.
   */
  listPresets(): Promise<Result<StylePresetList, AppError>> {
    const presets = STYLE_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      draft: preset.draft,
    }));

    // Parsed rather than asserted: the projection crosses a package boundary, and the
    // one thing a gallery cannot survive is a card missing the block it renders.
    const parsed = StylePresetList.safeParse({ presets });
    if (!parsed.success) {
      return Promise.resolve(
        err(
          new ValidationError({
            message: 'A style preset does not satisfy the card shape the gallery renders.',
            issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          }),
        ),
      );
    }
    return Promise.resolve(ok(parsed.data));
  }

  async fromPreset(preset: Slug): Promise<Result<StyleBible, AppError>> {
    const found = findPreset(preset);
    if (isErr(found)) return found;

    const bible = materialiseStyleBible({
      draft: found.value.draft,
      id: this.#deps.ids.styleBible(),
      clock: this.#deps.clock,
    });

    const stored = await this.#deps.repository.save(bible);
    if (isErr(stored)) return stored;

    this.#logger.info('style bible materialised from a preset', {
      preset,
      styleBibleId: bible.id,
      checksum: bible.checksum,
    });
    return ok(bible);
  }

  /**
   * A candidate derived from images the caller has already stored.
   *
   * Hashes rather than bytes, because the references are uploaded once and referred to
   * thereafter - which is what makes the derivation cacheable and keeps a multi-megabyte
   * body off a route that is called repeatedly while someone iterates.
   */
  async derive(request: DeriveStyleRequest): Promise<Result<StyleBible, AppError>> {
    if (this.#deps.backends.length === 0) {
      return err(
        new ValidationError({
          message:
            'No vision-capable model is configured, so a style cannot be derived from ' +
            'reference images. Set OLLAMA_HOST or a cloud key, or start from a preset.',
          context: { referenceCount: request.referenceHashes.length },
        }),
      );
    }

    const references: StyleReference[] = [];
    for (const hash of request.referenceHashes) {
      const bytes = await this.#deps.blobs.get(hash);
      if (isErr(bytes)) return bytes;
      references.push({ image: { mimeType: 'image/png', data: bytes.value } });
    }

    const useCase = new DeriveStyleFromReferencesUseCase({
      structuredCall: new StructuredCall({ clock: this.#deps.clock, logger: this.#logger }),
      backends: this.#deps.backends,
      raster: this.#deps.raster,
      logger: this.#logger,
    });

    const proposal = await useCase.execute({
      references,
      name: request.brief.workingTitle ?? 'Derived style',
      // Injected, never drawn: two derivations from the same references must produce
      // the same style, and the references are the only thing in scope that is a
      // function of the request rather than of the moment (non-negotiable #1).
      seed: seedFrom(request.referenceHashes),
      brief: briefSummary(request.brief),
    });
    if (isErr(proposal)) return proposal;

    const bible = materialiseStyleBible({
      draft: proposal.value.draft,
      id: this.#deps.ids.styleBible(),
      clock: this.#deps.clock,
    });

    const stored = await this.#deps.repository.save(bible);
    if (isErr(stored)) return stored;

    this.#logger.info('style bible derived from references', {
      styleBibleId: bible.id,
      checksum: bible.checksum,
      references: request.referenceHashes.length,
      paletteMeasured: proposal.value.measuredPalette !== null,
    });
    return ok(bible);
  }

  /**
   * Four tiles, so a human can say yes before anything expensive happens.
   *
   * The sheet is the screen the user approves; `lock` is what they press afterwards.
   */
  async probe(request: ProbeStyleRequest): Promise<Result<StyleProbeSheet, AppError>> {
    const found = await this.#load(request.styleBibleId);
    if (isErr(found)) return found;

    const sealed = sealForProbe(found.value, this.#deps.clock);
    if (isErr(sealed)) return sealed;

    const useCase = new GenerateStyleProbeUseCase({
      imageLanes: this.#deps.imageLanes,
      clock: this.#deps.clock,
      logger: this.#logger,
      ...(this.#deps.budget === undefined ? {} : { budget: this.#deps.budget }),
    });

    const sheet = await useCase.execute({
      bible: sealed.value.bible,
      lane: request.lane,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (isErr(sheet)) return sheet;

    const tiles: StyleProbeTile[] = [];
    for (const tile of sheet.value.tiles) {
      // Stored, then referenced. `put` is idempotent on identical bytes, so re-probing
      // an unchanged style writes nothing and returns the same four URLs - the same
      // "costs nothing and creates no file" property the asset registry has, one layer up.
      const put = await this.#deps.blobs.put(tile.image.data);
      if (isErr(put)) return put;

      const binding = splitModelRef(tile.modelRef);
      if (isErr(binding)) return binding;
      tiles.push({
        subject: tile.subject.key,
        label: tile.subject.label,
        imageUrl: blobUrl(put.value.hash),
        provider: binding.value.provider,
        model: binding.value.model,
        seed: tile.seed,
        costNanoUsd: tile.costNanoUsd,
        priced: tile.priced,
      });
    }

    const parsed = StyleProbeSheet.safeParse({
      styleBibleId: sheet.value.styleBibleId,
      styleChecksum: sheet.value.styleChecksum,
      lane: sheet.value.lane,
      width: sheet.value.size.width,
      height: sheet.value.size.height,
      tiles,
      totalCostNanoUsd: sheet.value.totalCostNanoUsd,
      costIsComplete: sheet.value.costIsComplete,
      generatedAt: sheet.value.generatedAt,
    });
    if (!parsed.success) {
      return err(
        new ValidationError({
          message: 'The probe sheet does not satisfy the shape the Style Lab renders.',
          context: { styleBibleId: request.styleBibleId },
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        }),
      );
    }

    this.#logger.info('style probe sheet generated', {
      styleBibleId: parsed.data.styleBibleId,
      lane: parsed.data.lane,
      tiles: parsed.data.tiles.length,
      provisional: sealed.value.provisional,
      totalCostNanoUsd: parsed.data.totalCostNanoUsd,
    });
    return ok(parsed.data);
  }

  /**
   * Freezes the checksum. The single most consequential write in the system.
   *
   * `lock()` recomputes the hash rather than trusting the stored one, so a document
   * edited in place between materialising and locking is locked to what it *is*, not to
   * what it claimed. Re-locking is a `ConflictError` from the domain, which is the right
   * answer: a second lock would be a fork.
   */
  async lock(id: StyleBibleId): Promise<Result<StyleBible, AppError>> {
    const found = await this.#load(id);
    if (isErr(found)) return found;

    const locked = lock(found.value, toIso(this.#deps.clock.now()));
    if (isErr(locked)) return locked;

    const stored = await this.#deps.repository.save(locked.value);
    if (isErr(stored)) return stored;

    this.#logger.info('style bible locked; every asset key from here contains this checksum', {
      styleBibleId: locked.value.id,
      checksum: locked.value.checksum,
    });
    return ok(locked.value);
  }

  async #load(id: StyleBibleId): Promise<Result<StyleBible, AppError>> {
    const found = await this.#deps.repository.find(id);
    if (isErr(found)) return found;
    if (found.value === null) return err(new NotFoundError('style bible', id));
    return ok(found.value);
  }
}

/**
 * `provider:model`, where the model half may itself contain colons (`qwen3.5:latest`).
 *
 * A failure rather than a fallback. Every adapter builds this string with `modelRef`,
 * so an unsplittable one is a wiring bug - and the alternative, substituting a plausible
 * vendor name, would put a fiction next to a cost figure on a screen someone is about to
 * approve.
 */
function splitModelRef(
  reference: string,
): Result<{ readonly provider: ProviderKind; readonly model: string }, AppError> {
  const separator = reference.indexOf(':');
  const provider = ProviderKind.safeParse(separator < 0 ? '' : reference.slice(0, separator));
  const model = separator < 0 ? '' : reference.slice(separator + 1);
  if (!provider.success || model === '') {
    return err(
      new ValidationError({
        message: `A probe tile came back from "${reference}", which is not a provider:model reference.`,
        context: { modelRef: reference },
      }),
    );
  }
  return ok({ provider: provider.data, model });
}

/**
 * The brief, as one line of background for the derivation prompt.
 *
 * The engine takes a string and uses it as context only, so what matters is that it
 * carries the register - who this is for and how it should feel - rather than the plot.
 */
function briefSummary(brief: Brief): string {
  const title = brief.workingTitle ?? 'untitled';
  return `${title}: ${brief.toneWords.join(', ')}, for ${brief.targetAudience}.`;
}

/** A seed that is a function of the request. See the call site for why not an RNG. */
function seedFrom(hashes: readonly string[]): number {
  const digest = contentHash([...hashes].sort());
  // The first 13 hex digits stay inside `Number.MAX_SAFE_INTEGER`; the modulus keeps it
  // inside the signed 32-bit range every image adapter can pass to a sampler.
  return Number.parseInt(digest.slice(0, 13), 16) % 2_147_483_647;
}
