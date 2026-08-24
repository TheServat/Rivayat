import { StyleBible } from '@rv/contracts';

import { ApiError } from '../errors';
import { NewProjectDraft } from '../schemas/projects';
import {
  type AnySettingDescriptor,
  SETTINGS_REGISTRY,
  type SettingIgnoredValue,
  type SettingOrigin,
  type SettingScope,
  SettingsPatch,
  SettingsScopeRef,
  WritableSettingsScope,
  isSettingKey,
  isWritableAt,
  settingFor,
  writableScopes,
} from '../schemas/settings';
import { parseOrThrow, type StudioTransport, type TransportRequest } from '../transport';

import { PROJECT_FIXTURES } from './projects.fixture';
import { MODEL_CHOICES, SETTING_DESCRIPTORS, SETTING_LAYER_VALUES } from './settings.fixture';
import { renderRoutes } from './render-routes';
import { StudioFixtureRoutes, isNotFound } from './studio-routes';
import { STYLE_PRESET_FIXTURES } from './style.fixture';

/**
 * The backend-free transport.
 *
 * It is a small, honest server rather than a table of canned responses: it holds the
 * layers, resolves them the way the API does, and applies patches. That matters because
 * the three behaviours the settings screen is judged on - saying which layer a value
 * came from, clearing an override back to the inherited value, and admitting that a
 * stored value no longer parses - are only observable if something is actually
 * resolving layers. A canned snapshot would let all three be broken and still look
 * right.
 *
 * **The resolution is re-implemented here, deliberately.** The real one lives in the
 * server-side settings package, which the studio may not depend on: it reads `.env` and
 * a database, and `app.spec.ts` fails the build if a server-only workspace package is
 * imported. So this walks `SETTINGS_REGISTRY` itself and validates each layer with the
 * descriptor's *own* `schema` - the same object the API validates with - so `origin`,
 * `shadowed` and `ignored` are genuinely computed rather than asserted.
 *
 * Secrets are the other reason. Here is where "never returned to the client" is
 * enforced: the machine layer holds the value, and the resolver replaces it with a
 * single `set` bit. A test that the UI does not render a secret is worth little if the
 * secret never reached the UI by accident; here it is withheld on purpose, in the same
 * place the real API withholds it.
 */
export class FixtureTransport implements StudioTransport {
  readonly kind = 'fixture' as const;
  readonly #layers: Record<SettingScope, Map<string, unknown>>;
  /**
   * Projects created during this session.
   *
   * Held rather than discarded because "the list is empty, create one, the list has one
   * row" is the behaviour the projects screen is judged on, and a transport that
   * accepted the POST and then answered the same two rows would let that break silently.
   */
  readonly #created: unknown[] = [];
  /**
   * Style bibles materialised from a preset, keyed by id.
   *
   * Parsed `StyleBible` values rather than loose objects: the fixture is validated on the
   * way in as well as on the way out, so a preset that could not become a legal bible
   * fails here instead of producing a response that happens to satisfy the response
   * schema. It also means everything downstream reads `bible.visual.palette` rather than
   * walking `unknown` by hand.
   */
  readonly #bibles = new Map<string, StyleBible>();
  /**
   * The asset library and the animation index, in a table of their own.
   *
   * An instance field rather than a module singleton, for the same reason `#created` is
   * one: regenerating an asset genuinely appends a version, and a shared store would
   * leak that append into the next test's version count.
   */
  readonly #studio = new StudioFixtureRoutes();
  #minted = 0;

  constructor() {
    this.#layers = {
      machine: new Map(Object.entries(SETTING_LAYER_VALUES.machine)),
      global: new Map(Object.entries(SETTING_LAYER_VALUES.global)),
      project: new Map(Object.entries(SETTING_LAYER_VALUES.project)),
      run: new Map(Object.entries(SETTING_LAYER_VALUES.run)),
    };
  }

  eventSourceUrl(): null {
    return null;
  }

  async send<T>(request: TransportRequest<T>): Promise<T> {
    // `await` so the signature is honest about being asynchronous and so callers
    // exercise the same suspense states they will against a real server.
    await Promise.resolve();

    const [path = '', query = ''] = request.path.split('?');

    if (request.method === 'GET' && path === '/projects') {
      return this.#respond(request, { projects: [...PROJECT_FIXTURES, ...this.#created] });
    }
    if (request.method === 'POST' && path === '/projects') {
      return this.#respond(request, this.#createProject(request.body));
    }
    if (request.method === 'GET' && path === '/style/presets') {
      return this.#respond(request, { presets: STYLE_PRESET_FIXTURES });
    }
    if (request.method === 'POST' && path === '/style/from-preset') {
      return this.#respond(request, this.#fromPreset(request.body));
    }
    if (request.method === 'POST' && /^\/style\/[^/]+\/probe$/.test(path)) {
      return this.#respond(request, this.#probe(path.split('/')[2] ?? '', request.body));
    }
    if (request.method === 'POST' && /^\/style\/[^/]+\/lock$/.test(path)) {
      return this.#respond(request, this.#lock(path.split('/')[2] ?? ''));
    }
    if (request.method === 'GET' && path === '/settings') {
      return this.#respond(request, this.#snapshot(scopeRefFrom(query)));
    }
    if (request.method === 'PUT' && path.startsWith('/settings/')) {
      const patch = SettingsPatch.parse(request.body);
      const scope = WritableSettingsScope.parse(path.slice('/settings/'.length));
      this.#applyPatch(scope, patch);
      return this.#respond(request, this.#snapshot(patch.scope));
    }

    // The render screen's formats, runs and cost, in their own table.
    const render = renderRoutes({
      method: request.method,
      path,
      query: new URLSearchParams(query),
      body: request.body,
    });
    if (render !== undefined) return this.#respond(request, render.payload);

    // The asset library and the animation index, in their own table. Last, so a route
    // declared above always wins and this can never shadow one.
    const studio = this.#studio.handle({
      method: request.method,
      path,
      query: new URLSearchParams(query),
      body: request.body,
    });
    if (studio !== undefined) {
      if (isNotFound(studio.payload)) {
        throw new ApiError({
          failure: 'api',
          code: 'NOT_FOUND',
          kind: 'not-found',
          status: 404,
          message: `nothing is stored at ${path}`,
        });
      }
      return this.#respond(request, studio.payload);
    }

    throw new ApiError({
      failure: 'api',
      code: 'fixture-route-missing',
      kind: 'not-found',
      status: 404,
      message: `the fixture transport has no route for ${request.method} ${path}`,
    });
  }

  /**
   * Mints a project the way the API does: validate the body, stamp both clocks, answer
   * the aggregate.
   *
   * The body goes through `NewProjectDraft` - the same schema the form validates with -
   * so a fixture session refuses exactly what a live one refuses. A transport that
   * accepted anything would make the form's error path untestable, and the error path
   * is where a filled form gets lost.
   */
  #createProject(body: unknown): unknown {
    const parsed = NewProjectDraft.safeParse(body);
    if (!parsed.success) {
      throw new ApiError({
        failure: 'api',
        code: 'VALIDATION_FAILED',
        kind: 'validation',
        status: 400,
        message: 'body failed validation',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }
    this.#minted += 1;
    const now = FIXTURE_INSTANT;
    const created = {
      id: `prj_01JQZM5P9R7S2T4V6W8X0YB${String(this.#minted).padStart(2, '0')}Z`,
      name: parsed.data.name,
      description: parsed.data.description,
      locale: 'fa',
      styleBibleId: null,
      budgetNanoUsd: parsed.data.budgetNanoUsd,
      createdAt: now,
      updatedAt: now,
    };
    this.#created.push({
      id: created.id,
      name: created.name,
      logline: created.description.slice(0, 400),
      locale: 'fa',
      styleBibleId: null,
      styleLocked: false,
      episodeCount: 0,
      spentNanoUsd: 0,
      updatedAt: now,
    });
    return created;
  }

  /**
   * A preset becomes a bible: the draft, plus the three things only the server can mint.
   *
   * The checksum is a fixed, obviously-synthetic hex rather than a computed one. The
   * studio cannot hash - `src/shims/node-crypto.ts` makes `createHash` throw on purpose,
   * because a plausible-but-wrong dedup key is the one failure non-negotiable #2 cannot
   * tolerate - so a fixture that produced a *convincing* checksum would be modelling the
   * exact mistake that shim exists to prevent.
   */
  #fromPreset(body: unknown): unknown {
    const preset = STYLE_PRESET_FIXTURES.find(
      (candidate) => candidate.id === (body as { preset?: unknown }).preset,
    );
    if (preset === undefined) {
      throw new ApiError({
        failure: 'api',
        code: 'NOT_FOUND',
        kind: 'not-found',
        status: 404,
        message: 'no such style preset',
      });
    }
    const id = `sty_01JQZK4A1B2C3D4E5F6G7H8J${String(this.#bibles.size + 1).padStart(2, '0')}`;
    const bible = StyleBible.parse({
      ...preset.draft,
      id,
      version: 1,
      checksum: FIXTURE_CHECKSUM,
      lockedAt: null,
      createdAt: FIXTURE_INSTANT,
    });
    this.#bibles.set(id, bible);
    return bible;
  }

  /**
   * Four tiles, drawn rather than generated.
   *
   * Each tile is an inline SVG in the style's own palette - unmistakably a placeholder,
   * and deliberately so. The purpose of a fixture probe is to exercise the parts of the
   * screen that are hard to get right (the 2x2 skeleton, the per-tile cost, the "priced"
   * distinction, the lane the sheet was run on), not to pretend an image model ran.
   *
   * The paid lane charges the catalogue's cheapest credible image price from research 2
   * - $0.0336 a tile on `google/gemini-3.1-flash-lite-image` - so the difference between
   * the two lanes on screen is the difference a real run would show.
   */
  #probe(id: string, body: unknown): unknown {
    const bible = this.#bibles.get(id);
    if (bible === undefined) {
      throw new ApiError({
        failure: 'api',
        code: 'NOT_FOUND',
        kind: 'not-found',
        status: 404,
        message: 'no such style bible',
      });
    }
    const lane = (body as { lane?: unknown }).lane === 'paid' ? 'paid' : 'free';
    const perTile = lane === 'paid' ? 33_600_000 : 0;
    const swatches = bible.visual.palette.colors.map((colour) => colour.hex);

    const tiles = PROBE_FIXTURE_SUBJECTS.map((subject, index) => ({
      subject: subject.key,
      label: subject.label,
      imageUrl: probeTileSvg(swatches, index),
      provider: lane === 'paid' ? 'openrouter' : 'comfyui',
      model: lane === 'paid' ? 'google/gemini-3.1-flash-lite-image' : 'sdxl-turbo',
      seed: bible.seed + index,
      costNanoUsd: perTile,
      priced: true,
    }));

    return {
      styleBibleId: id,
      styleChecksum: bible.checksum,
      lane,
      width: 512,
      height: 512,
      tiles,
      totalCostNanoUsd: perTile * tiles.length,
      costIsComplete: true,
      generatedAt: FIXTURE_INSTANT,
    };
  }

  #lock(id: string): unknown {
    const bible = this.#bibles.get(id);
    if (bible === undefined) {
      throw new ApiError({
        failure: 'api',
        code: 'NOT_FOUND',
        kind: 'not-found',
        status: 404,
        message: 'no such style bible',
      });
    }
    const locked = { ...bible, lockedAt: FIXTURE_INSTANT };
    this.#bibles.set(id, locked);
    return locked;
  }

  #respond<T>(request: TransportRequest<T>, payload: unknown): T {
    // Fixtures go through the same validation as a live response. A fixture that
    // drifts from the schema is a bug worth failing on, not a convenience worth
    // keeping.
    return parseOrThrow(request.path, request.schema, payload);
  }

  #snapshot(scope: SettingsScopeRef): unknown {
    const stack = stackFor(scope);
    return {
      scope,
      target: targetScopeFor(scope),
      descriptors: SETTING_DESCRIPTORS,
      values: SETTINGS_REGISTRY.map((descriptor) => this.#resolve(descriptor, stack)),
      models: MODEL_CHOICES,
      warnings: ENV_WARNINGS,
    };
  }

  /**
   * Walks the stack least-specific first; the last layer whose value *parses* wins.
   *
   * Least-specific first rather than backwards-and-stop, because the losers are part of
   * the answer: knowing that the machine layer holds a value and lost to a global one is
   * exactly what "why is this model being used" turns into. A layer whose value fails
   * the descriptor's schema is skipped and reported on `ignored` rather than being
   * fatal - a settings screen that refuses to open because one stored value no longer
   * parses cannot be used to fix that value.
   */
  #resolve(descriptor: AnySettingDescriptor, stack: readonly SettingScope[]): ResolvedForClient {
    let value: unknown = descriptor.default;
    let origin: SettingOrigin = 'default';
    const shadowed: SettingScope[] = [];
    const ignored: SettingIgnoredValue[] = [];

    for (const scope of stack) {
      const layer = this.#layers[scope];
      // `has`, not `get() !== undefined`: a layer that explicitly stores `null` for
      // `budget.perRunNanoUsd` means "no ceiling", which is a different answer from
      // "this layer says nothing".
      if (!layer.has(descriptor.key)) continue;

      const parsed = descriptor.schema.safeParse(layer.get(descriptor.key));
      if (!parsed.success) {
        ignored.push({
          scope,
          issuePaths: parsed.error.issues.map((issue) => issue.path.join('.')),
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
        });
        continue;
      }

      if (origin !== 'default') shadowed.push(origin);
      value = parsed.data;
      origin = scope;
    }

    const provenance = { key: descriptor.key, origin, shadowed, ignored };
    return descriptor.secret
      ? { ...provenance, secret: true, set: isPresent(value) }
      : { ...provenance, secret: false, value };
  }

  /**
   * One layer, all or nothing, validated the way the API validates it.
   *
   * The fixture refuses the same three things the real service refuses - an unknown
   * key, a key that may not be written at this layer, and a value its own schema
   * rejects - and it collects every fault instead of stopping at the first, because a
   * form has to be able to mark all of its bad fields in one round trip.
   */
  #applyPatch(scope: WritableSettingsScope, patch: SettingsPatch): void {
    const issues = [
      ...patch.set.flatMap((entry) => issuesFor(scope, entry.key, { value: entry.value })),
      ...patch.clear.flatMap((key) => issuesFor(scope, key, {})),
    ];
    if (issues.length > 0) {
      throw new ApiError({
        failure: 'api',
        code: 'settings.patch-rejected',
        kind: 'validation',
        status: 400,
        message: `settings patch rejected: ${String(issues.length)} invalid entries`,
        issues,
      });
    }

    const layer = this.#layers[scope];
    for (const entry of patch.set) layer.set(entry.key, entry.value);
    for (const key of patch.clear) layer.delete(key);
  }
}

/**
 * Which layers a request of this scope resolves through.
 *
 * `machine` and `global` always; the narrower two only when the request names one.
 * Asking for the global view and being shown a run override would make the screen a
 * liar about the layer it is editing.
 */
function stackFor(scope: SettingsScopeRef): readonly SettingScope[] {
  const stack: SettingScope[] = ['machine', 'global'];
  if (scope.projectId !== null) stack.push('project');
  if (scope.runId !== null) stack.push('run');
  return stack;
}

/** The layer a view of this scope writes to. Derived, never chosen by the caller. */
function targetScopeFor(scope: SettingsScopeRef): SettingScope {
  if (scope.runId !== null) return 'run';
  if (scope.projectId !== null) return 'project';
  return 'global';
}

/**
 * The scope a `GET /settings` query names.
 *
 * Parsed rather than cast: the ids are branded and a query string is not, so this is
 * the boundary where `?projectId=nonsense` becomes a failure instead of a layer nobody
 * can explain.
 */
function scopeRefFrom(query: string): SettingsScopeRef {
  const params = new URLSearchParams(query);
  return SettingsScopeRef.parse({
    projectId: params.get('projectId'),
    runId: params.get('runId'),
  });
}

/**
 * One resolved setting, before the envelope schema sees it.
 *
 * Mirrors `SettingValue` but keeps the value as `unknown`: this is the *producing*
 * side, so the discriminant and the provenance are worth type-checking while the value
 * is by definition sixty different types. `parseOrThrow` is what turns it into a
 * `SettingValue`.
 */
type ResolvedForClient =
  | {
      key: string;
      origin: SettingOrigin;
      shadowed: readonly SettingScope[];
      ignored: readonly SettingIgnoredValue[];
      secret: true;
      set: boolean;
    }
  | {
      key: string;
      origin: SettingOrigin;
      shadowed: readonly SettingScope[];
      ignored: readonly SettingIgnoredValue[];
      secret: false;
      value: unknown;
    };

/**
 * Whether a resolved secret counts as configured.
 *
 * An empty string is *not* set. Every credential in `.env.example` ships as
 * `GEMINI_API_KEY=` with nothing after it, and reporting that as set would tell the
 * operator the lane is configured when the very next provider call fails
 * unauthenticated.
 */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function issuesFor(
  scope: WritableSettingsScope,
  key: string,
  entry: { value?: unknown },
): { path: string; message: string; code: string }[] {
  if (!isSettingKey(key)) {
    return [{ path: key, code: 'unknown-key', message: 'No setting is declared under this key.' }];
  }
  const descriptor: AnySettingDescriptor = settingFor(key);
  if (!isWritableAt(descriptor, scope)) {
    return [
      {
        path: key,
        code: descriptor.secret ? 'secret-scope' : 'scope-violation',
        message: descriptor.secret
          ? 'A secret can only be set on the machine layer.'
          : `This setting can only be set at: ${writableScopes(descriptor).join(', ')}.`,
      },
    ];
  }
  if (!('value' in entry)) return [];
  const parsed = descriptor.schema.safeParse(entry.value);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    path: key,
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * One `.env` complaint, so the screen's warning banner is not dead markup.
 *
 * A variable that looks like a setting and is not one does nothing at all, silently,
 * which is the exact failure the registry exists to prevent - and a warning nobody
 * opens a terminal to read prevents nothing.
 */
const ENV_WARNINGS = [
  {
    variable: 'RV_BUDGET_USD_PER_WEEK',
    reason: 'unknown' as const,
    message: 'No setting reads this variable. Did you mean RV_BUDGET_USD_PER_DAY?',
  },
];

/**
 * The fixture's clock reading and its stand-in checksum.
 *
 * Constants rather than `Date.now()` and a hash: a transport whose answers change with
 * the wall clock produces a visual-regression diff on every run, and non-negotiable #1
 * bans the read outright. Sixty-four zeroes is a valid `Sha256Hex` and an impossible
 * one, which is the right property for a value nobody should mistake for real.
 */
const FIXTURE_INSTANT = '2026-08-22T09:05:00Z';
const FIXTURE_FALLBACK_HEX = '#888888';
const FIXTURE_CHECKSUM = '0'.repeat(64);

/**
 * The four subjects every candidate style is tested on.
 *
 * Fixed forever, and mirrored from `@rv/style-engine`'s `PROBE_SUBJECTS` for the same
 * reason the presets are: the studio may not import the engine. A character is the only
 * subject with an identity to keep, a tree is the test of whether the style splits into
 * riggable parts, a prop has to survive at thumbnail size, and a sky is the one subject
 * with no line work, so the palette has nothing to hide behind.
 */
const PROBE_FIXTURE_SUBJECTS = [
  { key: 'character', label: { fa: 'شخصیت ایستاده', en: 'Standing figure' } },
  { key: 'tree', label: { fa: 'درخت پهن‌برگ', en: 'Broadleaf tree' } },
  { key: 'prop', label: { fa: 'کوزهٔ آب', en: 'Water jug' } },
  { key: 'sky', label: { fa: 'آسمان روز', en: 'Daytime sky' } },
] as const;

/** A flat composition in the style's palette, as a data URL. Obviously not a render. */
function probeTileSvg(swatches: readonly string[], index: number): string {
  // `Palette` guarantees at least three colours, so the fallback is unreachable for a
  // parsed bible and present because `noUncheckedIndexedAccess` is on.
  const at = (offset: number): string =>
    swatches[(index + offset) % swatches.length] ?? FIXTURE_FALLBACK_HEX;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${at(4)}"/>` +
    `<circle cx="${22 + index * 6}" cy="26" r="${11 + (index % 3) * 3}" fill="${at(0)}"/>` +
    `<rect x="${14 + index * 4}" y="34" width="${20 + (index % 2) * 10}" height="22" fill="${at(1)}"/>` +
    `<rect x="0" y="${52 + (index % 3)}" width="64" height="12" fill="${at(3)}"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
