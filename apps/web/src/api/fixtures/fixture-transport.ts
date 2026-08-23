import { ApiError } from '../errors';
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
      return this.#respond(request, { projects: PROJECT_FIXTURES });
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

    throw new ApiError({
      failure: 'api',
      code: 'fixture-route-missing',
      kind: 'not-found',
      status: 404,
      message: `the fixture transport has no route for ${request.method} ${path}`,
    });
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
