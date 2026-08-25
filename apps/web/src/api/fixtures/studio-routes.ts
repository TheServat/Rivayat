/**
 * The fixture transport's routes for the asset library and the timeline.
 *
 * Kept out of `fixture-transport.ts` for the same reason the message catalogues are
 * kept one file per screen: four people are building six screens, and a single
 * if-chain is the file they all have to edit at once.
 *
 * A class rather than a module of functions because two of these routes **mutate**.
 * Regeneration has to genuinely append a version - that is the whole invariant the
 * asset screen exists to make visible - and a module-level store would leak one test's
 * appended version into the next test's assertion about version counts. The transport
 * owns one instance, and a fresh transport is a fresh library.
 */

import type {
  Asset,
  AssetDemandPlan,
  AssetResolution,
  AssetSpec,
  AssetVersion,
} from '@rv/contracts';

import type { AssetProduceReport, RegenerateOutcome } from '../schemas/assets';

import { ANIMATION_INDEX, animationById } from './animations.fixture';
import {
  ASSET_FIXTURES,
  INCOMPLETE_TAKES,
  PRODUCE_REPORTS,
  assetLibraryPage,
  assetSearchHits,
} from './assets.fixture';

/** What a miss costs at the cloud image lane's flat rate, in nano-dollars. */
const PER_MISS_NANO_USD = 21_000_000;

/**
 * Above this, the plan asks before it spends.
 *
 * Mirrors the default in `@rv/asset-registry`'s resolver rather than inventing a
 * second threshold: the point of the panel is that the number the user approves is the
 * number the server would have refused to exceed.
 */
const CONFIRM_THRESHOLD_NANO_USD = 50_000_000;

interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

/** Widens a fixture literal into the branded id the schema parses it back into. */
function brand<T>(value: string): T {
  return value as T;
}

/** `undefined` means "not my route"; the caller falls through to its own table. */
export type RouteResult = { readonly payload: unknown } | undefined;

export class StudioFixtureRoutes {
  /** A working copy, so an appended version is visible on the next read. */
  readonly #assets: Asset[] = ASSET_FIXTURES.map((asset) => structuredClone(asset));
  readonly #reports = new Map<string, AssetProduceReport>(Object.entries(PRODUCE_REPORTS));
  /** Monotonic, so two regenerations in one session do not mint the same id. */
  #minted = 0;

  handle(request: RouteRequest): RouteResult {
    const segments = request.path.split('/').filter((segment) => segment !== '');
    const [root, ...rest] = segments;
    if (root === 'assets') return this.#assetsRoute(request, rest);
    if (root === 'compositions') return compositionsRoute(request, rest);
    return undefined;
  }

  #assetsRoute(request: RouteRequest, rest: readonly string[]): RouteResult {
    const [first, second, third, fourth] = rest;

    if (request.method === 'GET' && first === undefined) {
      return { payload: this.#page(request.query.get('query') ?? '') };
    }
    // Two segments: `@Get(':id')` on the real controller swallows any single one.
    if (request.method === 'GET' && first === 'demand' && second === 'plan') {
      return { payload: this.#plan() };
    }
    if (request.method === 'POST' && first === 'search') {
      const body = request.body as { query?: unknown; minSimilarity?: unknown };
      const query = typeof body.query === 'string' ? body.query : '';
      const floor = typeof body.minSimilarity === 'number' ? body.minSimilarity : 0.6;
      return { payload: assetSearchHits(query, floor) };
    }
    if (request.method === 'POST' && first === 'resolve') {
      return { payload: this.#plan() };
    }
    if (request.method === 'GET' && first !== undefined && second === undefined) {
      const asset = this.#assets.find((candidate) => candidate.id === first);
      return asset === undefined ? notFound() : { payload: asset };
    }
    if (
      request.method === 'GET' &&
      first !== undefined &&
      second === 'versions' &&
      third !== undefined &&
      fourth === 'produce'
    ) {
      const report = this.#reports.get(third);
      return report === undefined ? notFound() : { payload: report };
    }
    if (request.method === 'POST' && first !== undefined && second === 'regenerate') {
      return this.#regenerate(first);
    }
    return undefined;
  }

  #page(query: string): unknown {
    // The projection lives in the fixture module so the shape is computed once; the
    // working copy only has to override the rows whose version count has moved.
    const base = assetLibraryPage(query);
    const assets = base.assets.map((entry) => {
      const live = this.#assets.find((candidate) => candidate.id === entry.id);
      if (live === undefined) return entry;
      const current = live.versions.find((version) => version.id === live.currentVersionId);
      return {
        ...entry,
        currentVersionId: live.currentVersionId,
        currentStatus: current?.status ?? entry.currentStatus,
        versionCount: live.versions.length,
        variantCount: live.versions.reduce((total, version) => total + version.variants.length, 0),
        clipCount: current?.clips.length ?? entry.clipCount,
        partCount: current?.parts.length ?? entry.partCount,
        spentNanoUsd: live.versions.reduce(
          (total, version) =>
            total +
            version.provenance.costNanoUsd +
            version.variants.reduce((sum, item) => sum + item.provenance.costNanoUsd, 0),
          0,
        ),
        updatedAt: live.updatedAt,
      };
    });
    return { ...base, assets };
  }

  /**
   * The plan, before anything is spent.
   *
   * Everything already in the library is a `cache-hit` and contributes nothing, which is
   * the number that has to be believable: a run over a library that already exists says
   * `$0.00` and means it. The one take that never registered is the only miss.
   */
  #plan(): AssetDemandPlan {
    const hits: AssetResolution[] = this.#assets.map((asset) => ({
      key: asset.key,
      spec: specFor(asset),
      outcome: 'cache-hit',
      existingAssetId: asset.id,
      existingVersionId: asset.currentVersionId,
      styleBibleId: STYLE_BIBLE_ID,
      estimatedCostNanoUsd: 0,
      reason: 'the dedup key resolved to a registered version in this style',
    }));

    const misses: AssetResolution[] = INCOMPLETE_TAKES.map((report) => ({
      key: report.key,
      spec: specForReport(report),
      outcome: 'miss' as const,
      styleBibleId: STYLE_BIBLE_ID,
      estimatedCostNanoUsd: PER_MISS_NANO_USD,
      reason: `the previous take stopped at ${report.failedStep ?? 'plan'} and was never registered`,
    }));

    const resolutions = [...hits, ...misses];
    const total = resolutions.reduce((sum, resolution) => sum + resolution.estimatedCostNanoUsd, 0);
    return {
      resolutions,
      hitCount: hits.length,
      missCount: misses.length,
      totalEstimatedNanoUsd: total,
      requiresConfirmation: total > CONFIRM_THRESHOLD_NANO_USD,
    };
  }

  /**
   * A second take: appended, never in place.
   *
   * The previous version keeps its ordinal, its parts and its provenance, and the
   * response names both ids so the screen can show the old one still resolving rather
   * than assert in a sentence that it does.
   */
  #regenerate(assetId: string): RouteResult {
    const asset = this.#assets.find((candidate) => candidate.id === assetId);
    if (asset === undefined) return notFound();

    const previous =
      asset.versions.find((version) => version.id === asset.currentVersionId) ??
      asset.versions[asset.versions.length - 1];
    if (previous === undefined) return notFound();

    this.#minted += 1;
    const ordinal = asset.versions.length + 1;
    const suffix = String(this.#minted).padStart(2, '0');
    const newId = brand<AssetVersion['id']>(`asv_7RQKW${suffix}ZT3DB2RJX9HMC0VF7A6`);
    const appended: AssetVersion = {
      ...structuredClone(previous),
      id: newId,
      ordinal,
      status: 'generating',
      provenance: {
        ...previous.provenance,
        parents: [...previous.provenance.parents, previous.id],
        costNanoUsd: PER_MISS_NANO_USD,
      },
    };

    asset.versions = [...asset.versions, appended];
    asset.currentVersionId = newId;
    this.#reports.set(newId, {
      key: asset.key,
      semanticKey: asset.semanticKey,
      label: asset.label,
      assetId: asset.id,
      versionId: newId,
      steps: [
        {
          step: 'generate',
          outcome: 'ran',
          attempt: 0,
          durationMs: 0,
          costNanoUsd: PER_MISS_NANO_USD,
        },
        { step: 'matte', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
        { step: 'split', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
        { step: 'score', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
        { step: 'rig', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
        { step: 'clips', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
        { step: 'bake', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
        { step: 'register', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
      ],
      spentNanoUsd: PER_MISS_NANO_USD,
    });

    const outcome: RegenerateOutcome = {
      assetId: asset.id,
      previousVersionId: previous.id,
      newVersionId: newId,
      ordinal,
      estimatedNanoUsd: PER_MISS_NANO_USD,
    };
    return { payload: outcome };
  }
}

/**
 * The server calls these compositions and the studio calls them animations.
 *
 * The fixture serves the *server's* shape - a list of `CompositionSummary` and a
 * `StoredComposition` - so the client's translation runs here exactly as it does live.
 * A fixture that served the studio's own vocabulary would skip the one piece of logic
 * most likely to be wrong, which is the mapping between them.
 */
function compositionsRoute(request: RouteRequest, rest: readonly string[]): RouteResult {
  const [first, second] = rest;

  if (request.method === 'GET' && first === undefined) {
    return {
      payload: {
        compositions: ANIMATION_INDEX.animations.map((a) => ({
          // The hash is the address; a fixture has no real bytes to hash, so it is
          // derived from the id and is stable, which is all a fixture needs it to be.
          id: fakeHash(a.id),
          animationId: a.id,
          label: a.name,
          durationMs: a.durationMs,
          fps: a.fps,
          sceneSpace: a.sceneSpace,
          nodeCount: a.nodeCount,
          storedAt: a.updatedAt,
        })),
      },
    };
  }

  if (request.method === 'GET' && first !== undefined && second === undefined) {
    const summary = ANIMATION_INDEX.animations.find((a) => fakeHash(a.id) === first);
    const ir = summary === undefined ? undefined : animationById(summary.id);
    if (summary === undefined || ir === undefined) return notFound();
    return {
      payload: {
        summary: {
          id: first,
          animationId: summary.id,
          label: summary.name,
          durationMs: summary.durationMs,
          fps: summary.fps,
          sceneSpace: summary.sceneSpace,
          nodeCount: summary.nodeCount,
          storedAt: summary.updatedAt,
        },
        ir,
      },
    };
  }

  return undefined;
}

/** A stable 64-hex string from an id. Not a real digest, and not pretending to be. */
function fakeHash(id: string): string {
  let a = 0x811c9dc5;
  const out: string[] = [];
  for (let round = 0; round < 8; round += 1) {
    for (const ch of `${id}:${round}`) {
      a ^= ch.codePointAt(0) ?? 0;
      a = Math.imul(a, 0x01000193) >>> 0;
    }
    out.push(a.toString(16).padStart(8, '0'));
  }
  return out.join('').slice(0, 64);
}

/**
 * A 404 the caller turns into an `ApiError`.
 *
 * Returned as a payload rather than thrown so the transport owns the error type; the
 * schema parse would fail anyway, and "the fixture has no such asset" should read the
 * same way the API's own not-found does.
 */
function notFound(): RouteResult {
  return { payload: { __notFound: true } };
}

export function isNotFound(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && '__notFound' in payload;
}

/** The one locked bible in the workspace database; every fixture resolves against it. */
const STYLE_BIBLE_ID = 'sty_01M0QRJ20N5VT5GGFVJC5E2F4R' as AssetResolution['styleBibleId'];

/**
 * The spec a registered asset would have been generated from.
 *
 * Reconstructed from the stored version rather than invented: the parts, the canvas and
 * the nominal height are on the version, and those are the fields the dedup key's
 * `specHash` covers. It is a projection of real data, not a second description of the
 * asset.
 */
function specFor(asset: Asset): AssetSpec {
  const current =
    asset.versions.find((version) => version.id === asset.currentVersionId) ?? asset.versions[0];
  const parts = current?.parts ?? [];
  return {
    semanticKey: asset.semanticKey,
    archetype: asset.archetype,
    subjectClass: subjectClassFor(asset.semanticKey),
    label: asset.label,
    description: asset.description,
    tags: [...asset.tags],
    canvas: current?.canvas ?? { width: 1024, height: 1024 },
    nominalHeight: current?.nominalHeight ?? 512,
    parts:
      parts.length === 0
        ? [
            {
              name: 'body',
              role: 'body',
              description: asset.description,
              zOrder: 0,
              deformable: false,
              optional: false,
            },
          ]
        : parts.map((part) => ({
            name: part.name,
            role: part.role,
            description: `${part.name} of ${asset.label}`,
            zOrder: part.zOrder,
            deformable: part.deformable,
            optional: false,
          })),
    variants: [],
    references: [],
    quality: current?.quality ?? 'preview',
    requireAlpha: true,
  };
}

function specForReport(report: AssetProduceReport): AssetSpec {
  return {
    semanticKey: report.semanticKey,
    archetype: 'rigid-prop',
    subjectClass: subjectClassFor(report.semanticKey),
    label: report.label,
    description: `${report.label}, in the locked style`,
    tags: [],
    canvas: { width: 512, height: 512 },
    nominalHeight: 512,
    parts: [
      {
        name: 'body',
        role: 'body',
        description: report.label,
        zOrder: 0,
        deformable: false,
        optional: false,
      },
    ],
    variants: [],
    references: [],
    quality: 'preview',
    requireAlpha: true,
  };
}

/** The style bible's prompt fragment is chosen by subject class, so the spec carries one. */
function subjectClassFor(semanticKey: string): AssetSpec['subjectClass'] {
  const category = semanticKey.split('/')[0] ?? '';
  const table: Readonly<Record<string, AssetSpec['subjectClass']>> = {
    prop: 'prop',
    flora: 'foliage',
    fauna: 'creature',
    char: 'character',
    arch: 'architecture',
  };
  return table[category] ?? 'prop';
}
