/**
 * The settings surface's wire shapes, composed from the registry rather than restated.
 *
 * Architecture 7b says a setting is declared once and read by three consumers. Two of
 * them - the resolver and the validator - share the *live* declaration through
 * `@rv/contracts`. The third is a browser, which cannot receive a Zod schema, so what
 * crosses the wire is `SettingDescriptorMeta`: the serialisable half of the same
 * declaration, already a real schema upstream. Nothing here re-describes a descriptor;
 * this file only names the envelope the three parts travel in.
 *
 * **The secret branch has no `value` property at all.** `SettingValue` is a
 * discriminated union on `secret`, mirroring `ClientSetting` in `@rv/settings`, and
 * both halves are `strictObject`. A secret carrying a value therefore fails validation
 * on the way out *and* on the way in, rather than relying on a redaction step nobody
 * re-reads. 7b's "the UI can report that a key is present, never what it is" is a
 * one-way door, and this is the hinge.
 *
 * **Report:** this envelope belongs in `@rv/contracts/src/settings/` next to the
 * registry, so `apps/web` imports it instead of parsing a copy. It is here because the
 * task that produced it may not edit `packages/**`; `apps/web/src/api/schemas/settings.ts`
 * carries the mirror, and its header says the same thing.
 */

import {
  Capability,
  Label,
  ModelRef,
  ProjectId,
  ProviderKind,
  ProviderModelId,
  RunId,
  SettingDescriptorMeta,
  SettingKeyPath,
  SettingOrigin,
  SettingScope,
} from '@rv/contracts';
import { z } from 'zod';

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
   * `project` when a project is, `global` otherwise. Sent because every row's
   * read-only state and every "clear override" button depends on it, and a client that
   * re-derived it would be a second place the rule lives.
   */
  target: SettingScope,
  descriptors: z.array(SettingDescriptorMeta),
  values: z.array(SettingValue),
  /** The live model catalogue, so `model-picker` is not a free-text box. */
  models: z.array(SettingModelChoice),
  /** Machine-layer complaints from `loadMachineLayer`. Empty when `.env` is clean. */
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
 * `machine` is absent by construction, not by omission: it is `.env`, the repository
 * refuses to store it (see the `SettingsRepository` port), and a route that accepted
 * the word and then could not honour it would be worse than one that never offered it.
 */
export const WritableSettingsScope = z.enum(['global', 'project', 'run']);
export type WritableSettingsScope = z.infer<typeof WritableSettingsScope>;

/** Optional `?projectId=` / `?runId=` on the read. */
export const ProjectIdQuery = ProjectId.optional();
export const RunIdQuery = RunId.optional();
