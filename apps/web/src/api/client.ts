import {
  AssetDemandPlan,
  Project,
  StyleBible,
  UpdateProjectRequest,
  type AnimationId,
  type AssetId,
  type AssetVersionId,
  type RegenerateIntent,
  type ProjectId,
  type RunId,
  type Slug,
  type StyleBibleId,
} from '@rv/contracts';

import { FixtureTransport } from './fixtures/fixture-transport';
import { ApiError } from './errors';
import { RunSummary, StartRunBody } from './schemas/runs';
import { AnimationIndex, type AnimationIR } from './schemas/animations';
import { CompositionList, StoredComposition } from './schemas/compositions';
import {
  Asset,
  AssetLibraryPage,
  AssetProduceReport,
  AssetSearchHits,
  RegenerateOutcome,
} from './schemas/assets';
import { ProjectList } from './schemas/pending-contracts';
import type { NewProjectDraft } from './schemas/projects';
import {
  type SettingsPatch,
  type SettingsScopeRef,
  SettingsSnapshot,
  type WritableSettingsScope,
} from './schemas/settings';
import { StylePresetList, StyleProbeSheet, type StyleProbeLane } from './schemas/style';
import { HttpTransport, type StudioTransport } from './transport';

/**
 * Every call the studio makes, in one typed surface.
 *
 * Each method names the schema its response must satisfy, and `transport.send`
 * validates against it before resolving. There is no path by which an unvalidated
 * payload reaches a store: the schema is a required field of the request, not an
 * option a caller can forget.
 */
export class StudioApi {
  readonly transport: StudioTransport;

  constructor(transport: StudioTransport) {
    this.transport = transport;
  }

  listProjects(signal?: AbortSignal): Promise<ProjectList> {
    return this.transport.send({
      method: 'GET',
      path: '/projects',
      schema: ProjectList,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Starts a project.
   *
   * Returns the aggregate rather than the summary, because that is what the API
   * answers: `spentNanoUsd` and `episodeCount` are joins over runs and episodes that a
   * project one millisecond old has none of. The list is reloaded afterwards rather
   * than patched from this, so the row a user sees is the one the server would send.
   */
  createProject(draft: NewProjectDraft, signal?: AbortSignal): Promise<Project> {
    return this.transport.send({
      method: 'POST',
      path: '/projects',
      schema: Project,
      body: draft,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Changes a project, one field at a time or several at once.
   *
   * Every key is optional and an absent key is left alone, which is the difference
   * between a patch and a replacement - a caller that only knows the style should not
   * have to send back a name it never read.
   *
   * The first caller is the Style Lab attaching a bible it just locked. Locking used to
   * produce a bible attached to nothing, so a project stayed at "no style chosen" no
   * matter how many times someone locked one.
   */
  updateProject(
    id: ProjectId,
    patch: UpdateProjectRequest,
    signal?: AbortSignal,
  ): Promise<Project> {
    return this.transport.send({
      method: 'PATCH',
      path: `/projects/${id}`,
      schema: Project,
      body: UpdateProjectRequest.parse(patch),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  // ── S1 style ────────────────────────────────────────────────────────

  /**
   * The curated shelf.
   *
   * Typed against {@link StylePresetList}, which is wider than what the route returns
   * today - see the table in `schemas/style.ts` for what the API owes this call and
   * why a list of slugs cannot drive the gallery.
   */
  listStylePresets(signal?: AbortSignal): Promise<StylePresetList> {
    return this.transport.send({
      method: 'GET',
      path: '/style/presets',
      schema: StylePresetList,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Materialises a preset into a real bible with an id and a checksum. */
  styleFromPreset(preset: Slug, signal?: AbortSignal): Promise<StyleBible> {
    return this.transport.send({
      method: 'POST',
      path: '/style/from-preset',
      schema: StyleBible,
      body: { preset },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Four tiles, so a human can say yes before anything expensive happens.
   *
   * **No route answers this yet.** `apps/api` exposes presets, from-preset, derive and
   * lock; the probe use-case is built in `@rv/style-engine` and unbound. The call is
   * written here rather than omitted so the screen has one place to point when it
   * lands, and so the failure a user sees is the API's own refusal rather than a
   * disabled button with no explanation.
   */
  probeStyle(
    id: StyleBibleId,
    lane: StyleProbeLane,
    signal?: AbortSignal,
  ): Promise<StyleProbeSheet> {
    return this.transport.send({
      method: 'POST',
      path: `/style/${id}/probe`,
      schema: StyleProbeSheet,
      body: { lane },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * One bible by id.
   *
   * What the Style Lab needs to show a project the style it locked last week. Every
   * other style call on this client *produces* a bible, which is why a returning project
   * used to open on an empty gallery.
   */
  getStyleBible(id: StyleBibleId, signal?: AbortSignal): Promise<StyleBible> {
    return this.transport.send({
      method: 'GET',
      path: `/style/${id}`,
      schema: StyleBible,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Freezes the checksum.
   *
   * The one irreversible action the studio can take from a screen: every asset dedup
   * key downstream is derived from the value this call fixes, so locking a different
   * bible forks the whole asset library rather than reusing it.
   */
  lockStyle(id: StyleBibleId, signal?: AbortSignal): Promise<StyleBible> {
    return this.transport.send({
      method: 'POST',
      path: `/style/${id}/lock`,
      schema: StyleBible,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  loadSettings(scope: SettingsScopeRef, signal?: AbortSignal): Promise<SettingsSnapshot> {
    const query = new URLSearchParams();
    if (scope.projectId !== null) query.set('projectId', scope.projectId);
    if (scope.runId !== null) query.set('runId', scope.runId);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.transport.send({
      method: 'GET',
      path: `/settings${suffix}`,
      schema: SettingsSnapshot,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Writes one layer, named in the path.
   *
   * `PUT /settings/:scope` rather than `PATCH /settings`, because the layer is a
   * property of the *request*, not of each entry: one submission is one all-or-nothing
   * write against one layer. A patch that spread itself across layers could be
   * half-applied, leaving the machine in a state the user never chose and cannot see.
   * The response is the refreshed snapshot, because a write changes provenance as well
   * as values and a client that guessed which rows moved would guess wrong.
   */
  saveSettings(
    scope: WritableSettingsScope,
    patch: SettingsPatch,
    signal?: AbortSignal,
  ): Promise<SettingsSnapshot> {
    return this.transport.send({
      method: 'PUT',
      path: `/settings/${scope}`,
      schema: SettingsSnapshot,
      body: patch,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** SSE endpoint for a run's progress, or `null` when the transport has no stream. */
  // ── S6 assets ───────────────────────────────────────────────────────

  /**
   * The library.
   *
   * `GET /assets` does not exist in `apps/api` yet - see the endpoint table in
   * `schemas/assets.ts`. The call is made anyway rather than stubbed, so the day the
   * controller lands the screen is already pointed at it, and until then the store
   * turns the 404 into a named `unavailable` state instead of a red banner.
   */
  listAssets(query: string, signal?: AbortSignal): Promise<AssetLibraryPage> {
    const suffix = query.trim() === '' ? '' : `?query=${encodeURIComponent(query.trim())}`;
    return this.transport.send({
      method: 'GET',
      path: `/assets${suffix}`,
      schema: AssetLibraryPage,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** One asset with its whole version tree. Live: `AssetsController.findOne`. */
  getAsset(assetId: AssetId, signal?: AbortSignal): Promise<Asset> {
    return this.transport.send({
      method: 'GET',
      path: `/assets/${assetId}`,
      schema: Asset,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Reuse before regrowth.
   *
   * Live, and **not free**: it embeds the query string, which is one provider call. So
   * it is submit-driven rather than keystroke-driven - a search-as-you-type box here
   * would bill for every character.
   */
  searchAssets(query: string, signal?: AbortSignal): Promise<AssetSearchHits> {
    return this.transport.send({
      method: 'POST',
      path: '/assets/search',
      schema: AssetSearchHits,
      body: { query, limit: 10 },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * The plan, before anything is spent.
   *
   * `POST /assets/resolve` is live and is the authoritative one, but it takes a list of
   * `AssetSpec`s and the studio has no source of those - specs come out of the story
   * stage, which has no endpoint. So the screen asks for the plan of the library's
   * current demand, which is the read-only half of the same use-case.
   *
   * **Two path segments, deliberately.** `AssetsController` declares `@Get(':id')`, and
   * Nest matches any single segment under `/assets` against it - so `GET /assets/plan`
   * comes back as a *400 about a malformed AssetId* rather than a 404, and the screen
   * would show a red banner about a server that is merely missing a route. Verified
   * against the running API, not reasoned about: `/assets/plan` answers 400 and
   * `/assets/demand/plan` answers 404.
   */
  planAssets(signal?: AbortSignal): Promise<AssetDemandPlan> {
    return this.transport.send({
      method: 'GET',
      path: '/assets/demand/plan',
      schema: AssetDemandPlan,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Where one take stopped in the eight-step produce chain, and why. */
  getProduceReport(
    assetId: AssetId,
    versionId: AssetVersionId,
    signal?: AbortSignal,
  ): Promise<AssetProduceReport> {
    return this.transport.send({
      method: 'GET',
      path: `/assets/${assetId}/versions/${versionId}/produce`,
      schema: AssetProduceReport,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * A deliberate second take.
   *
   * The body is a `RegenerateIntent` - the contract schema, whose `keepPrevious` is a
   * `z.literal(true)` precisely so that an attempt to set it false is a visible diff
   * rather than a silent overwrite. Nothing in the studio constructs one without a
   * reason the user chose.
   */
  regenerateAsset(
    assetId: AssetId,
    intent: RegenerateIntent,
    signal?: AbortSignal,
  ): Promise<RegenerateOutcome> {
    return this.transport.send({
      method: 'POST',
      path: `/assets/${assetId}/regenerate`,
      schema: RegenerateOutcome,
      body: intent,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  // ── S7 animation ────────────────────────────────────────────────────

  /**
   * Every animation the timeline can open.
   *
   * The route is `/compositions`, not `/animations`. The server calls these compositions
   * because a run references one by content hash; the studio calls them animations
   * because that is what a person opens on a timeline. Both names are right for their own
   * side, so the translation lives here - at the boundary - rather than one side adopting
   * the other's vocabulary.
   *
   * Two identities exist here and they answer different questions. The **sha256** is the
   * address of the bytes: an edited document hashes differently, which is exactly what
   * makes a render reproducible. The **`animationId`** is the document's own id and
   * survives an edit.
   *
   * The timeline opens a document a person then edits, so it carries `animationId` -
   * the thing that stays the same across the edit they are about to make. `getAnimation`
   * therefore has to find a composition *by* animation id, because the store is keyed by
   * hash. That lookup is the cost of the two identities, and it is the right way round:
   * the alternative is a timeline whose selection changes identity every time you touch
   * a keyframe.
   */
  async listAnimations(signal?: AbortSignal): Promise<AnimationIndex> {
    const list = await this.transport.send({
      method: 'GET',
      path: '/compositions',
      schema: CompositionList,
      ...(signal === undefined ? {} : { signal }),
    });
    return AnimationIndex.parse({
      animations: list.compositions.map((composition) => ({
        id: composition.animationId,
        name: composition.label,
        fps: composition.fps,
        durationMs: composition.durationMs,
        sceneSpace: composition.sceneSpace,
        nodeCount: composition.nodeCount,
        // The index deliberately does not fetch each IR to count these - that is its
        // whole reason for existing - and the composition summary does not carry them.
        // Zero here would be a claim; these are counted when a document is opened.
        trackCount: 0,
        behaviourCount: 0,
        markerCount: 0,
        updatedAt: composition.storedAt,
      })),
    });
  }

  /**
   * One `AnimationIR`, parsed by the contract schema.
   *
   * The same object `evaluate(ir, t)` is typed against, and the same one the renderer
   * consumes. A document that does not satisfy the IR's refinements - a cycle in the
   * node hierarchy, a track on an unknown node - never reaches the player.
   */
  async getAnimation(animationId: AnimationId, signal?: AbortSignal): Promise<AnimationIR> {
    // The store is keyed by content hash, and the timeline holds an `animationId`, so the
    // hash is looked up from the index. One extra round trip against a list the screen
    // already fetched to draw its picker - and the alternative, keying the timeline by
    // hash, would change the selected document's identity on every keyframe drag.
    const index = await this.transport.send({
      method: 'GET',
      path: '/compositions',
      schema: CompositionList,
      ...(signal === undefined ? {} : { signal }),
    });
    const match = index.compositions.find((c) => c.animationId === animationId);
    if (match === undefined) {
      throw new ApiError({
        failure: 'api',
        code: 'NOT_FOUND',
        kind: 'not-found',
        status: 404,
        message: `no composition is stored for ${animationId}`,
      });
    }
    const stored = await this.transport.send({
      method: 'GET',
      path: `/compositions/${match.id}`,
      schema: StoredComposition,
      ...(signal === undefined ? {} : { signal }),
    });
    return stored.ir;
  }

  /**
   * Start a pipeline run.
   *
   * The one thing the studio could not do. Every screen could read what a stage produced
   * and none could ask for a stage to happen, so a project's cast existed only if a
   * seeder had written it - and the Characters screen's honest "no states defined yet"
   * had no answer anywhere in the interface.
   *
   * Returns as soon as the run is queued. Progress arrives on the event stream, because a
   * stage that calls a local model takes minutes and a request that waits for it is a
   * request that times out.
   */
  startRun(body: StartRunBody, signal?: AbortSignal): Promise<RunSummary> {
    return this.transport.send({
      method: 'POST',
      path: '/runs',
      body: StartRunBody.parse(body),
      schema: RunSummary,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** One run, for polling a stage to completion when the stream is not wanted. */
  getRun(runId: RunId, signal?: AbortSignal): Promise<RunSummary> {
    return this.transport.send({
      method: 'GET',
      path: `/runs/${runId}`,
      schema: RunSummary,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  runStreamUrl(runId: RunId): string | null {
    return this.transport.eventSourceUrl(`/runs/${runId}/events`);
  }
}

/**
 * Chooses a transport from the environment.
 *
 * `fixture` is opt-in and visible: the shell shows a badge for it, so a screen served
 * from recorded payloads is labelled as one. The default is `http`, because a build
 * that quietly falls back to fixtures when the API is down is a build that reports
 * success for a broken deployment.
 */
export function createTransport(
  env: Pick<ImportMetaEnv, 'VITE_RV_TRANSPORT' | 'VITE_RV_API_BASE_URL'> = import.meta.env,
): StudioTransport {
  if (env.VITE_RV_TRANSPORT === 'fixture') return new FixtureTransport();
  return new HttpTransport(env.VITE_RV_API_BASE_URL ?? '/api');
}

let singleton: StudioApi | undefined;

/** The application-wide client. Stores call this; tests construct their own instead. */
export function useStudioApi(): StudioApi {
  singleton ??= new StudioApi(createTransport());
  return singleton;
}

/** Replaces the singleton. For tests and for the e2e harness only. */
export function setStudioApi(api: StudioApi | undefined): void {
  singleton = api;
}
