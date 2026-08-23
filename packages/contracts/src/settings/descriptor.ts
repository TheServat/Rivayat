/**
 * What a setting *is*, declared once so the UI, the API and the resolver cannot drift.
 *
 * Architecture 7b states the requirement this file answers: **every option is
 * configurable from the UI**, and the failure mode that invites is a hand-built form
 * that drifts from the options the code reads - a checkbox that no longer does
 * anything, an option that exists in code with no way to reach it. So a setting is
 * declared, and the form is generated from the declaration.
 *
 * Two decisions here are load-bearing.
 *
 * **`control` is explicit, not inferred from `schema`.** A descriptor carries a Zod
 * schema, and the obvious shortcut is for the frontend to look inside it - read
 * `_def.typeName`, walk the checks - and pick a control. That couples the UI to a
 * library's private shape, breaks on a minor version, and cannot express the difference
 * between two settings that share a schema and want different controls: `render
 * concurrency` and `api port` are both bounded integers, and one is a slider while the
 * other is a number field. So the descriptor names its control and carries that
 * control's render hints. The schema validates; the control renders; neither guesses at
 * the other.
 *
 * **`scope` is a floor, not a pin.** A descriptor's scope names the *most specific*
 * layer at which the setting may be written - `run` means "machine, global, project or
 * run", `machine` means "machine only". Read as a pin it would make a per-run model
 * override illegal at project level, which is precisely the flexibility the layering
 * exists to provide. `secret` overrides all of it: a secret is machine-only, whatever
 * its scope says, because the layers above machine are database rows that get exported,
 * diffed and shown in a UI.
 */

import { z } from 'zod';

import { Label, LocalisedText, NanoUsdAmount } from '../primitives/common';
import { Capability, ProviderKind } from '../provider/capability';
import { SettingPrimitive } from './values';

// ── addressing ──────────────────────────────────────────────────────────────

/**
 * A dotted, lowercase-headed path: `image.lane`, `provider.ollama.host`.
 *
 * At least two segments, always, so a key names a group and a leaf. A bare `locale`
 * would be unplaceable in a settings screen and unmergeable with a sibling package's
 * settings later.
 */
export const SettingKeyPath = z
  .string()
  .regex(
    /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/,
    'expected a dotted setting key such as "image.lane"',
  )
  .describe('Dotted setting key, e.g. "provider.ollama.host"');
export type SettingKeyPath = z.infer<typeof SettingKeyPath>;

/** Uppercase environment-variable name, as a shell would spell it. */
export const EnvVarName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'expected an UPPER_SNAKE environment variable name');
export type EnvVarName = z.infer<typeof EnvVarName>;

// ── layers ──────────────────────────────────────────────────────────────────

/** A layer a value can be *written* at. */
export const SettingScope = z.enum(['machine', 'global', 'project', 'run']);
export type SettingScope = z.infer<typeof SettingScope>;

/**
 * A layer a value can be *read* from - the scopes plus the built-in default.
 *
 * Distinct from `SettingScope` because `default` is answerable and unwritable: the UI
 * has to be able to say "this came from the built-in default", and nothing may patch it.
 */
export const SettingOrigin = z.enum(['default', 'machine', 'global', 'project', 'run']);
export type SettingOrigin = z.infer<typeof SettingOrigin>;

/**
 * Resolution order, least specific first. Later wins (architecture 7b).
 *
 * Derived from the enum rather than retyped, so a new layer is a one-line change that
 * the rank table below is forced to acknowledge.
 */
export const SETTING_ORIGINS: readonly SettingOrigin[] = SettingOrigin.options;

const ORIGIN_RANK: Readonly<Record<SettingOrigin, number>> = {
  default: 0,
  machine: 1,
  global: 2,
  project: 3,
  run: 4,
};

/** Position in the resolution order. Higher wins. */
export function originRank(origin: SettingOrigin): number {
  return ORIGIN_RANK[origin];
}

/** Which panel a setting appears in. */
export const SettingGroup = z.enum([
  /** Endpoints, API keys and the per-provider default model for each role. */
  'providers',
  /** Per-stage model selection, quality tier, routing policy. */
  'models',
  /** The image lane and everything ComfyUI needs to be reachable. */
  'image',
  /** Spending ceilings and the point at which a run stops and asks. */
  'budget',
  /** Which renderer draws the frames, and how many at once. */
  'render',
  /** Which delivery formats a project ships. */
  'delivery',
  /** Locale and reading direction. */
  'interface',
  /** Machine-wide plumbing: paths, ports, the database, the queue. */
  'runtime',
]);
export type SettingGroup = z.infer<typeof SettingGroup>;

// ── the form control ────────────────────────────────────────────────────────

/**
 * One discrete choice, with the localised text the UI needs to render it.
 *
 * `hint` is deliberately not localised: it holds a price, a context window, a model id -
 * strings that are already language-neutral and that would be actively worse translated.
 */
export const SettingOption = z.strictObject({
  value: SettingPrimitive,
  label: LocalisedText,
  /** Secondary text: a price summary, a context window, a "free" marker. */
  hint: Label.optional(),
});
export type SettingOption = z.infer<typeof SettingOption>;

/**
 * How to render this setting, and the hints that control needs.
 *
 * A discriminated union rather than a `type` string plus a bag of optional numbers,
 * because "a slider with no maximum" is not a thing that can be drawn and a schema that
 * can express it will eventually be handed it.
 */
export const SettingControl = z.discriminatedUnion('kind', [
  /** A boolean switch. */
  z.strictObject({ kind: z.literal('toggle') }),

  /** Exactly one of `options`. */
  z.strictObject({
    kind: z.literal('select'),
    /** Long lists get a filter box; three radio buttons do not. */
    searchable: z.boolean().optional(),
  }),

  /** Any subset of `options`. */
  z.strictObject({
    kind: z.literal('multi-select'),
    minSelected: z.number().int().nonnegative().optional(),
    maxSelected: z.number().int().positive().optional(),
  }),

  /** A bounded number field. */
  z.strictObject({
    kind: z.literal('number'),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    /** Suffix shown inside the field: `ms`, `px`, `frames`. */
    unit: Label.optional(),
  }),

  /** A number whose range is small and whose feel matters more than its digits. */
  z.strictObject({
    kind: z.literal('slider'),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    unit: Label.optional(),
  }),

  z.strictObject({
    kind: z.literal('text'),
    placeholder: Label.optional(),
    multiline: z.boolean().optional(),
  }),

  /**
   * A write-only field.
   *
   * The control that never receives a value: the client is told whether one is *set*
   * and can replace it, never read it back.
   */
  z.strictObject({ kind: z.literal('secret'), placeholder: Label.optional() }),

  z.strictObject({ kind: z.literal('url'), placeholder: Label.optional() }),

  /**
   * Money. The stored value is integer nano-dollars; the control shows dollars.
   *
   * The conversion is the control's job precisely because the storage unit must not
   * leak into a form: a user typing `5` means five dollars, and every place that
   * decides for itself how many zeroes that is becomes a place it can be wrong.
   */
  z.strictObject({
    kind: z.literal('money'),
    minNanoUsd: NanoUsdAmount.optional(),
    maxNanoUsd: NanoUsdAmount.optional(),
    /** Increment in nano-dollars. 10_000_000 is one cent. */
    stepNanoUsd: NanoUsdAmount,
    /** `true` when clearing the field means "no ceiling" rather than "zero". */
    nullable: z.boolean().optional(),
  }),

  /**
   * A model chosen from the live catalogue.
   *
   * Distinct from `select` because the choices are **not** closed: `options` seeds the
   * picker from `KNOWN_MODELS`, and OpenRouter's `/api/v1/models` sync replaces it at
   * runtime. A `select` promises the schema accepts exactly its options; this one
   * promises only that the options are currently believed to exist.
   */
  z.strictObject({
    kind: z.literal('model-picker'),
    /** Only models declaring this capability belong in the list. */
    capability: Capability,
    /** Which providers this particular slot may be filled from. */
    providers: z.array(ProviderKind).min(1),
    /** Whether a model id absent from the catalogue may be typed in. */
    allowCustom: z.boolean(),
    /** `true` when "let the router decide" is a legal answer. */
    nullable: z.boolean().optional(),
  }),

  /** Free-form JSON, for the escape hatches. Rendered as a validated code editor. */
  z.strictObject({ kind: z.literal('json'), placeholder: Label.optional() }),
]);
export type SettingControl = z.infer<typeof SettingControl>;

/** Controls whose `options` are a closed set the schema must agree with exactly. */
export const CLOSED_CHOICE_CONTROLS: readonly SettingControl['kind'][] = ['select', 'multi-select'];

// ── conditional visibility ──────────────────────────────────────────────────

/**
 * "Show this only when another setting holds one of these values."
 *
 * The ComfyUI auth token is meaningless on the local lane and mandatory on the Colab
 * one; rendering it unconditionally is how a field that is ignored gets filled in and
 * trusted. `equals` is a list because the same field is usually relevant to several
 * values of the same parent - the ComfyUI host matters for `local-comfyui` *and*
 * `colab`, and not at all for `cloud-api`.
 */
export const SettingDependency = z.strictObject({
  /** Another setting's key. The registry spec asserts it names one that exists. */
  key: SettingKeyPath,
  /** Visible when the referenced setting resolves to any of these. */
  equals: z.array(SettingPrimitive).min(1),
});
export type SettingDependency = z.infer<typeof SettingDependency>;

// ── the machine layer ───────────────────────────────────────────────────────

/**
 * How to read this setting out of a string-valued environment.
 *
 * `format` rather than a parse function because a descriptor has to survive being sent
 * to a browser: a closure cannot be serialised, cannot be diffed against `.env.example`
 * by a test, and cannot be shown to an operator asking what `RV_BUDGET_USD_PER_RUN`
 * expects.
 */
export const SettingEnvFormat = z.enum([
  /** Used verbatim. */
  'string',
  /** Base-10 integer. */
  'integer',
  /** `true`/`false`, `1`/`0`, `yes`/`no`, case-insensitive. */
  'boolean',
  /**
   * Decimal **dollars** in the file, integer nano-dollars in the value.
   *
   * `.env` quotes budgets the way a human writes them (`5.00`) and the ledger stores
   * them the way money has to be stored. The conversion has exactly one home, and this
   * is the declaration that points at it.
   */
  'usd-dollars',
]);
export type SettingEnvFormat = z.infer<typeof SettingEnvFormat>;

export const SettingEnvBinding = z.strictObject({
  name: EnvVarName,
  format: SettingEnvFormat,
});
export type SettingEnvBinding = z.infer<typeof SettingEnvBinding>;

// ── the descriptor ──────────────────────────────────────────────────────────

/**
 * Everything about a setting except its schema and its default.
 *
 * Split out as a real schema, rather than left as a TypeScript interface, because this
 * is exactly the part that travels: the API serves it to the settings screen, and a
 * malformed label or an unrenderable control should fail at the boundary rather than as
 * a blank row in the UI. The registry spec parses every declaration through it.
 */
export const SettingDescriptorMeta = z.strictObject({
  key: SettingKeyPath,
  group: SettingGroup,
  /** Persian is required; English is optional. The UI is Persian-first. */
  label: LocalisedText,
  /** Why you would change it - not what it is. The label already says what it is. */
  help: LocalisedText,
  /** The most specific layer this may be written at. See the file header. */
  scope: SettingScope,
  /** Never returned to a client, never logged, never exported. Implies machine scope. */
  secret: z.boolean(),
  /** Changing it takes effect only after the process restarts. */
  requiresRestart: z.boolean(),
  /** All conditions must hold for the field to be shown. Empty means always shown. */
  dependsOn: z.array(SettingDependency),
  control: SettingControl,
  /** Present for every choice-shaped control. Absent otherwise. */
  options: z.array(SettingOption).optional(),
  /** Present for anything the machine layer can seed. Required when `scope` is machine. */
  env: SettingEnvBinding.optional(),
});
export type SettingDescriptorMeta = z.infer<typeof SettingDescriptorMeta>;

/**
 * One setting, whole.
 *
 * An interface rather than a schema because two of its members cannot be described by
 * one: `schema` is a live Zod object, and `default` is typed by it. `SettingDescriptorMeta`
 * covers everything that *can* be validated, and the registry spec runs every
 * declaration through it.
 */
export interface SettingDescriptor<TValue = unknown> extends SettingDescriptorMeta {
  /** The schema the API validates a patch with and the resolver validates a layer with. */
  readonly schema: z.ZodType<TValue>;
  /** The value when nothing overrides it. Must satisfy `schema` - the spec asserts it. */
  readonly default: TValue;
}

/** A descriptor whose value type is not known at the call site. */
export type AnySettingDescriptor = SettingDescriptor<unknown>;

// ── rules that follow from a descriptor ─────────────────────────────────────

/*
 * Three of the five take `SettingDescriptorMeta`, not `AnySettingDescriptor`.
 *
 * `isWritableAt`, `writableScopes` and `isVisible` read `secret`, `scope` and
 * `dependsOn` - every one of which is on the wire. Demanding the live descriptor, with
 * its Zod `schema` and its typed `default`, made them uncallable from the one place
 * that most needs them: a browser has a `SettingDescriptorMeta` and can never have the
 * other two, so the studio grew a shim that faked a schema to satisfy the signature.
 * A shim that fabricates the argument a function does not read is a shim that will
 * eventually fabricate one it does.
 *
 * `defaultIsValid` keeps the full descriptor because it genuinely needs both halves.
 * `closedChoiceValues` reads only `control` and `options` and could widen too; it has
 * not, because nothing has asked, and widening on speculation is how a signature ends
 * up describing no caller.
 */

/**
 * Whether `layer` may hold a value for this setting.
 *
 * The secret rule comes first and is absolute. Architecture 7b: "Secrets live only in
 * the machine layer; the UI can report that a key is *present*, never what it is." A
 * secret written at project scope would be a database row that gets exported with the
 * project, and no amount of redaction downstream can put that back.
 */
export function isWritableAt(descriptor: SettingDescriptorMeta, layer: SettingScope): boolean {
  if (descriptor.secret) return layer === 'machine';
  return originRank(layer) <= originRank(descriptor.scope);
}

/**
 * The layers this setting may be written at, least specific first.
 *
 * Exists so the settings screen can render "project · run" next to a field instead of
 * re-deriving the rule above and getting the secret case wrong.
 */
export function writableScopes(descriptor: SettingDescriptorMeta): readonly SettingScope[] {
  return SettingScope.options.filter((scope) => isWritableAt(descriptor, scope));
}

/**
 * Whether every `dependsOn` condition holds against already-resolved values.
 *
 * Takes a lookup rather than the layer stack because visibility is computed against the
 * *effective* values the user is looking at, and re-resolving inside a render loop
 * would be quadratic in the size of the registry.
 */
export function isVisible(
  descriptor: SettingDescriptorMeta,
  valueOf: (key: string) => unknown,
): boolean {
  return descriptor.dependsOn.every((dependency) => {
    const current = valueOf(dependency.key);
    return dependency.equals.some((candidate) => candidate === current);
  });
}

/**
 * The serialisable half of a descriptor, as one function instead of three copies.
 *
 * The two unserialisable members are removed **by name** and the rest is parsed through
 * {@link SettingDescriptorMeta}, which is a `strictObject`. Both halves of that matter.
 * Dropping `schema` and `default` is deliberate - a live Zod schema cannot cross a wire
 * and a client that received one would be executing code it was sent - while any
 * *other* member a future descriptor grows fails here, at boot, naming the key, instead
 * of arriving in a browser as a field nothing renders.
 *
 * It is here rather than in the API because three places were already doing it: the
 * settings service, the registry spec, and any test that needs a wire-shaped
 * descriptor. Three spellings of "strip the two unserialisable fields" is three places
 * to forget the third one when it appears.
 */
export function toDescriptorMeta(descriptor: AnySettingDescriptor): SettingDescriptorMeta {
  const { schema: _schema, default: _default, ...meta } = descriptor;
  return SettingDescriptorMeta.parse(meta);
}

/**
 * A default that fails its own schema is a booby trap.
 *
 * It survives every code path that never writes the setting, and detonates the first
 * time someone opens the form and saves it unchanged. Exported so the registry spec can
 * assert it over every declaration rather than sampling.
 */
export function defaultIsValid(descriptor: AnySettingDescriptor): boolean {
  return descriptor.schema.safeParse(descriptor.default).success;
}

/**
 * The values a closed-choice control offers, or `null` when the control is open.
 *
 * `null` and `[]` are different answers: an open control (a model picker, a text field)
 * has no closed option set to check, while a select with no options is a bug.
 */
export function closedChoiceValues(
  descriptor: AnySettingDescriptor,
): readonly SettingPrimitive[] | null {
  if (!CLOSED_CHOICE_CONTROLS.includes(descriptor.control.kind)) return null;
  return (descriptor.options ?? []).map((option) => option.value);
}
