/**
 * Settings, served from the registry that architecture 7b says is the only declaration.
 *
 * The whole of this file is assembly: `@rv/contracts` declares the settings,
 * `@rv/settings` resolves and validates them, `@rv/persistence` stores the three
 * database layers, and `.env` supplies the fourth. Nothing here re-decides any of that.
 * The two things it *does* decide are worth stating, because both were bugs in the
 * shape this module used to have.
 *
 * **A read never merges.** `resolveAll` returns a winner *and* the layers that lost, and
 * both travel. 7b: "The UI shows which layer a value came from, because 'why is this
 * model being used' is otherwise unanswerable once four layers exist." A merged document
 * has already thrown that away, and no amount of care downstream puts it back.
 *
 * **A write is one layer, all-or-nothing, and reports every fault.** `applyPatch`
 * collects rather than short-circuits, so a form marks all its bad fields in one round
 * trip; and because a patch is one form submission, applying the half that parsed would
 * leave the machine in a state the user never chose and cannot see.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  KNOWN_MODELS,
  SETTINGS_REGISTRY,
  SettingDescriptorMeta,
  type SettingScope,
  describePricing,
  isSettingKey,
  isWritableAt,
  modelRef,
  settingFor,
  writableScopes,
} from '@rv/contracts';
import {
  applyPatch,
  layer,
  redactSetting,
  resolveAll,
  type MachineLayerLoad,
  type ResolvedSetting,
  type SettingIssue,
  type SettingsLayer,
  type SettingsRepository,
} from '@rv/settings';
import { ValidationError, err, isErr, ok, toIso, type Clock, type Result } from '@rv/shared-kernel';

import { MACHINE_SETTINGS, SETTINGS_REPOSITORY, CLOCK } from '../../tokens';

import {
  SettingJsonValue,
  type SettingModelChoice,
  type SettingValue,
  type SettingsPatch,
  type SettingsScopeRef,
  type SettingsSnapshot,
  type WritableSettingsScope,
} from './settings.contracts';

/**
 * The model catalogue a `model-picker` chooses from.
 *
 * Derived from `KNOWN_MODELS` once, at module load, because the table is a frozen
 * constant and rebuilding it per request would be sixty allocations for an answer that
 * cannot have changed. The OpenRouter sync in `@rv/providers` (`buildSnapshot` /
 * `reconcile`) replaces entries at runtime once something schedules it and stores the
 * result; there is no such store yet, and fetching `/api/v1/models` inside a `GET
 * /settings` would put a network round trip - and a provider outage - between the
 * operator and the screen they open *to fix the provider*.
 */
const MODEL_CHOICES: SettingModelChoice[] = KNOWN_MODELS.map((model) => ({
  ref: modelRef(model.provider, model.id),
  provider: model.provider,
  model: model.id,
  label: model.label,
  capabilities: model.capabilities,
  free: model.pricing.free,
  pricing: describePricing(model.pricing),
}));

/**
 * The descriptors, serialised once.
 *
 * The two unserialisable members are removed **by name**, and everything else is parsed
 * through `SettingDescriptorMeta`, which is a `strictObject`. That pairing is the point:
 * dropping `schema` and `default` is deliberate - a Zod schema cannot cross the wire and
 * a client that received one would start executing it - while any *other* member a
 * future descriptor grows fails here, at boot, with the key in the message, rather than
 * arriving in a browser as a field nothing renders.
 */
const DESCRIPTOR_META: SettingDescriptorMeta[] = SETTINGS_REGISTRY.map((descriptor) => {
  const { schema: _schema, default: _default, ...meta } = descriptor;
  return SettingDescriptorMeta.parse(meta);
});

/** The serialised registry, for a caller that wants it without a resolution pass. */
export function descriptorMeta(): readonly SettingDescriptorMeta[] {
  return DESCRIPTOR_META;
}

/**
 * Which layer a view of this scope writes to.
 *
 * Derived, never chosen by the caller: a client that picked its own target would be a
 * second place the rule lives, and the rule is what decides whether a row is editable.
 */
export function targetScopeFor(ref: SettingsScopeRef): SettingScope {
  if (ref.runId !== null) return 'run';
  if (ref.projectId !== null) return 'project';
  return 'global';
}

@Injectable()
export class SettingsService {
  readonly #repository: SettingsRepository;
  readonly #machine: MachineLayerLoad;
  readonly #clock: Clock;

  constructor(
    @Inject(SETTINGS_REPOSITORY) repository: SettingsRepository,
    @Inject(MACHINE_SETTINGS) machine: MachineLayerLoad,
    @Inject(CLOCK) clock: Clock,
  ) {
    this.#repository = repository;
    this.#machine = machine;
    this.#clock = clock;
  }

  /** Everything the settings screen renders, resolved through the whole stack. */
  async snapshot(ref: SettingsScopeRef): Promise<Result<SettingsSnapshot>> {
    const layers = await this.#stack(ref);
    if (isErr(layers)) return layers;

    return ok({
      scope: ref,
      target: targetScopeFor(ref),
      descriptors: DESCRIPTOR_META,
      values: toClientValues(resolveAll(layers.value)),
      models: MODEL_CHOICES,
      warnings: this.#machine.warnings.map((warning) => ({ ...warning })),
    });
  }

  /**
   * Validates a whole patch, stores it, and answers with the refreshed snapshot.
   *
   * Answering with the snapshot rather than `204` is not a convenience. A write changes
   * *provenance*, not only values: storing `model.stage.story` at project scope moves
   * every run-scope reader of that key from `default` to `project`, and a client that
   * had to guess which rows changed would guess wrong.
   */
  async write(
    scope: WritableSettingsScope,
    patch: SettingsPatch,
  ): Promise<Result<SettingsSnapshot>> {
    const scopeId = scopeIdFor(scope, patch.scope);
    if (isErr(scopeId)) return scopeId;

    const values: Record<string, unknown> = {};
    for (const entry of patch.set) values[entry.key] = entry.value;

    // Both halves are validated before either is applied, and their issues are
    // concatenated, because a form must be able to mark every bad field at once - and a
    // patch that set one illegal key and cleared another would otherwise need two round
    // trips to show both.
    const parsed = applyPatch({ scope, scopeId: scopeId.value, values });
    const clearIssues = clearableIssues(scope, patch.clear);
    const setIssues = isErr(parsed) ? parsed.error.issues : [];
    const issues = [...setIssues, ...clearIssues];
    if (issues.length > 0) return err(patchRejected(issues));

    const accepted: SettingsLayer = isErr(parsed) ? layer(scope, {}, scopeId.value) : parsed.value;

    const now = toIso(this.#clock.now());
    const ref = { scope, scopeId: scopeId.value } as const;

    if (Object.keys(accepted.values).length > 0) {
      const saved = await this.#repository.save(ref, accepted.values, now);
      if (isErr(saved)) return saved;
    }
    if (patch.clear.length > 0) {
      const cleared = await this.#repository.clear(ref, patch.clear);
      if (isErr(cleared)) return cleared;
    }

    return this.snapshot(patch.scope);
  }

  /**
   * The four layers, least specific first.
   *
   * The machine layer comes from `loadMachineLayer` at boot and is never read from the
   * repository: the port refuses to store it, and a stack assembled without it would
   * silently resolve every `.env` value to its built-in default.
   */
  async #stack(ref: SettingsScopeRef): Promise<Result<readonly SettingsLayer[]>> {
    const stored = await this.#repository.loadStack({
      projectId: ref.projectId,
      runId: ref.runId,
    });
    if (isErr(stored)) return stored;
    return ok([this.#machine.layer, ...stored.value]);
  }
}

/**
 * Resolved settings, redacted, with their provenance kept.
 *
 * `redactSetting` owns the secret decision - it keys off `descriptor.secret`, never off
 * the key's spelling - and this only re-attaches the two provenance fields it does not
 * carry. Re-implementing the redaction here to add them would be the second place a
 * secret could leak from.
 */
function toClientValues(resolved: ReadonlyMap<string, ResolvedSetting>): SettingValue[] {
  const values: SettingValue[] = [];
  for (const descriptor of SETTINGS_REGISTRY) {
    const entry = resolved.get(descriptor.key);
    if (entry === undefined) continue;
    const client = redactSetting(entry);
    const provenance = {
      key: entry.key,
      origin: entry.origin,
      shadowed: [...entry.shadowed],
      ignored: entry.ignored.map((ignored) => ({
        scope: ignored.scope,
        issuePaths: [...ignored.issuePaths],
        message: ignored.message,
      })),
    };
    values.push(
      client.secret
        ? { ...provenance, secret: true, set: client.set }
        : // Parsed, not cast. A resolved value is whatever the descriptor's own schema
          // accepted, and every descriptor in the registry accepts JSON - so a failure
          // here is a declaration that cannot be sent to a browser, which is a
          // programmer error and is meant to throw.
          { ...provenance, secret: false, value: SettingJsonValue.parse(client.value) },
    );
  }
  return values;
}

/**
 * Which keys may not be cleared at this scope, and why.
 *
 * `applyPatch` cannot answer this: a clear has no value to validate, so it never
 * reaches the schema. The three refusals are the same three, checked against the same
 * `isWritableAt`, so "you may not write it" and "you may not unwrite it" can never
 * disagree.
 */
function clearableIssues(scope: SettingScope, keys: readonly string[]): readonly SettingIssue[] {
  const issues: SettingIssue[] = [];
  for (const key of keys) {
    if (!isSettingKey(key)) {
      issues.push({
        key,
        code: 'unknown-key',
        message: 'No setting is declared under this key.',
        paths: [],
      });
      continue;
    }
    const descriptor = settingFor(key);
    if (isWritableAt(descriptor, scope)) continue;
    issues.push({
      key,
      code: descriptor.secret ? 'secret-scope' : 'scope-violation',
      message: descriptor.secret
        ? 'A secret can only be set on the machine layer.'
        : `This setting can only be set at: ${writableScopes(descriptor).join(', ')}.`,
      paths: [],
    });
  }
  return issues;
}

/**
 * Every fault, in the envelope's own `issues` shape.
 *
 * `SettingsPatchError` keeps its issues on a typed field; `AppErrorFilter` reads
 * `context.issues`. Translating here rather than widening either is what lets a
 * settings form receive `{path, code, message}` per bad field through the same envelope
 * as every other validation failure in the API.
 */
function patchRejected(issues: readonly SettingIssue[]): ValidationError {
  return new ValidationError({
    message: `Settings patch rejected: ${String(issues.length)} invalid ${
      issues.length === 1 ? 'entry' : 'entries'
    }.`,
    context: {
      issues: issues.map((issue) => ({
        path: issue.key,
        code: issue.code,
        message: issue.message,
        ...(issue.paths.length > 0 ? { paths: issue.paths } : {}),
      })),
    },
    issues: issues.map((issue) => `${issue.key}: ${issue.message}`),
  });
}

/**
 * The layer instance a write addresses.
 *
 * A project write with no project is a request that names no row. Refusing it here,
 * rather than storing under the empty string, is what stops "the project layer" from
 * quietly becoming a second global one.
 */
function scopeIdFor(scope: WritableSettingsScope, ref: SettingsScopeRef): Result<string | null> {
  if (scope === 'global') return ok(null);
  if (scope === 'project') {
    return ref.projectId === null
      ? err(new ValidationError({ message: 'Writing the project layer needs a projectId.' }))
      : ok(ref.projectId);
  }
  return ref.runId === null
    ? err(new ValidationError({ message: 'Writing the run layer needs a runId.' }))
    : ok(ref.runId);
}
