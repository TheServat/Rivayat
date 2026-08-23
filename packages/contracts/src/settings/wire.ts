/**
 * The envelope the settings screen and the settings route agree on.
 *
 * `descriptor.ts` says what a setting *is* and `registry.ts` lists them; this file is
 * the third thing architecture 7b needs and the one that had no home: the document
 * `GET /api/settings` answers with, and the patch it accepts.
 *
 * It lived in two hand-maintained copies - the API module and the studio's api/schemas
 * folder - each of whose headers named the other as the authority and asked for exactly
 * this file. Two `strictObject`s either side of a wire fail loudly when they drift,
 * which is better than failing quietly, but it is still two places to change and the
 * failure lands on a user rather than on CI. One schema, imported by both, is the only
 * version of that guarantee that cannot drift.
 *
 * **What crosses the wire is `SettingDescriptorMeta`, not `SettingDescriptor`.** A
 * browser cannot receive a live Zod schema or a default typed by it. The serialisable
 * half is already a real schema upstream, so the client validates the declaration it
 * renders from rather than trusting it.
 *
 * **The secret branch has no `value` property at all.** {@link SettingValue} is a
 * discriminated union on `secret` with both halves strict, mirroring `ClientSetting` in
 * `@rv/settings`. That is stronger than redaction: a secret carrying a value fails
 * validation on the way out *and* on the way in, instead of depending on a redaction
 * step remembering to run. 7b's "the UI can report that a key is present, never what it
 * is" is a one-way door, and this is the hinge.
 */

import { z } from 'zod';

import { Label } from '../primitives/common';
import { ProjectId, RunId } from '../primitives/ids';
import { Capability, ModelRef, ProviderKind, ProviderModelId } from '../provider/capability';
import { SettingDescriptorMeta, SettingKeyPath, SettingOrigin, SettingScope } from './descriptor';

/**
 * Any JSON value.
 *
 * A setting's value is validated by its own descriptor, never by this: the envelope's
 * job is to carry sixty differently-typed values in one array, and a schema that tried
 * to be more specific here would have to be the union of the whole registry.
 */
export const SettingJsonValue = z.json();
export type SettingJsonValue = z.infer<typeof SettingJsonValue>;

/** Which project or run the values were resolved for. Both `null` is the global view. */
export const SettingsScopeRef = z.strictObject({
  projectId: ProjectId.nullable().default(null),
  runId: RunId.nullable().default(null),
});
export type SettingsScopeRef = z.infer<typeof SettingsScopeRef>;

/**
 * A stored value the resolver refused, reported rather than hidden.
 *
 * The global and project layers are rows an older build wrote. A settings screen that
 * silently fell back would leave the operator looking at a value the database does not
 * contain, with no way to find out why.
 */
export const SettingIgnoredValue = z.strictObject({
  scope: SettingScope,
  issuePaths: z.array(z.string()),
  message: z.string(),
});
export type SettingIgnoredValue = z.infer<typeof SettingIgnoredValue>;

const provenance = {
  key: SettingKeyPath,
  origin: SettingOrigin,
  /** Layers that held a value for this key and lost to a more specific one. */
  shadowed: z.array(SettingScope),
  /** Layers whose stored value failed the schema and was skipped. */
  ignored: z.array(SettingIgnoredValue),
};

/**
 * One setting as the client receives it: the value, and the receipt for it.
 *
 * `origin` is the answer to "why is this model being used", which 7b says is otherwise
 * unanswerable once four layers exist. `shadowed` is what makes "clear this override"
 * decidable: without it the UI cannot tell an inherited value from one that happens to
 * equal its parent, and "I changed it and nothing happened" is indistinguishable from
 * "the change did not save".
 */
export const SettingValue = z.discriminatedUnion('secret', [
  z.strictObject({ ...provenance, secret: z.literal(false), value: SettingJsonValue }),
  z.strictObject({
    ...provenance,
    secret: z.literal(true),
    /** Whether a value exists at all. The only bit a secret is allowed to emit. */
    set: z.boolean(),
  }),
]);
export type SettingValue = z.infer<typeof SettingValue>;

/**
 * One model a `model-picker` may offer.
 *
 * `ref` is carried alongside `provider` and `model` because `provider:model` is the
 * form that lands in the cost ledger, and a client that assembled it itself would be a
 * second place the separator is decided.
 */
export const SettingModelChoice = z.strictObject({
  ref: ModelRef,
  provider: ProviderKind,
  model: ProviderModelId,
  label: Label,
  capabilities: z.array(Capability).min(1),
  free: z.boolean(),
  /** One-line price summary, from `describePricing`. Language-neutral on purpose. */
  pricing: z.string(),
});
export type SettingModelChoice = z.infer<typeof SettingModelChoice>;

/**
 * Something in the environment the operator should be told about.
 *
 * Surfaced in the response, not only in the log: an unknown `RV_*` variable that
 * silently does nothing is the exact failure the registry exists to prevent, and a
 * warning nobody opens a terminal to read prevents nothing.
 */
export const SettingEnvWarning = z.strictObject({
  variable: z.string(),
  reason: z.enum(['unknown', 'unparseable']),
  message: z.string(),
});
export type SettingEnvWarning = z.infer<typeof SettingEnvWarning>;

/** Everything the settings screen renders, in one response. */
export const SettingsSnapshot = z.strictObject({
  scope: SettingsScopeRef,
  /**
   * The layer a write from this view lands on.
   *
   * Derived from `scope`, not chosen by the client: `run` when a run is addressed,
   * `project` when a project is, `global` otherwise. Sent because every row's read-only
   * state and every "clear override" button depends on it, and a client that re-derived
   * it would be a second place the rule lives.
   */
  target: SettingScope,
  descriptors: z.array(SettingDescriptorMeta),
  values: z.array(SettingValue),
  /** The live model catalogue, so `model-picker` is not a free-text box. */
  models: z.array(SettingModelChoice),
  /** Machine-layer complaints from `loadMachineLayer`. Empty when the environment is clean. */
  warnings: z.array(SettingEnvWarning),
});
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;

/**
 * A batch of edits.
 *
 * Set and clear are separate lists rather than one list with a nullable value, because
 * `null` is a legitimate setting value - `budget.perRunNanoUsd: null` means "no
 * ceiling" - and "clear the override" is not the same request as "store null here".
 *
 * There is no per-entry layer. The layer is the request's, named in the path, so one
 * submission is one `applyPatch` against one layer and therefore all-or-nothing.
 * Spreading a form across layers would mean a rejected patch that had already written
 * half of itself somewhere the user cannot see.
 *
 * **Not the same `SettingsPatch` as `@rv/settings`.** That one is the *resolved* write -
 * `{scope, scopeId, values}` - which `applyPatch` validates key by key against the
 * registry. This one is what arrives from a browser, before a layer has been chosen or
 * a value has been looked at. The name is kept identical to the two copies it replaces
 * so re-pointing them is an import line and nothing else; a file that genuinely needs
 * both must alias one, and this paragraph is why.
 */
export const SettingsPatch = z.strictObject({
  scope: SettingsScopeRef,
  set: z.array(z.strictObject({ key: SettingKeyPath, value: SettingJsonValue })).default([]),
  clear: z.array(SettingKeyPath).default([]),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/**
 * The layer a write addresses.
 *
 * `machine` is absent by construction, not by omission: it is the process environment,
 * the repository refuses to store it (see `SettingsRepository` in `@rv/settings`), and
 * a route that accepted the word and then could not honour it would be worse than one
 * that never offered it.
 */
export const WritableSettingsScope = z.enum(['global', 'project', 'run']);
export type WritableSettingsScope = z.infer<typeof WritableSettingsScope>;

/**
 * Whether this layer can be written at all.
 *
 * A type guard rather than a bare comparison, so the narrowing from `SettingScope` to
 * `WritableSettingsScope` happens once here instead of at every call site that has the
 * first and needs the second.
 */
export function isWritableScope(scope: SettingScope): scope is WritableSettingsScope {
  return scope !== 'machine';
}
