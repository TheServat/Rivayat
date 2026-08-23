import { type Locale, isVisible as dependenciesHold } from '@rv/contracts';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import { z } from 'zod';

import { useStudioApi } from '../api/client';
import { ApiError, isApiError } from '../api/errors';
import {
  type AnySettingDescriptor,
  SETTING_GROUPS,
  type SettingDescriptorMeta,
  type SettingEnvWarning,
  type SettingGroup,
  type SettingModelChoice,
  type SettingScope,
  type SettingValue,
  SettingsPatch,
  type SettingsScopeRef,
  type SettingsSnapshot,
  isWritableAt,
  isWritableScope,
} from '../api/schemas/settings';
import { settingValidator } from '../api/schemas/setting-validator';
import { localised } from '../i18n/localised';

export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * One edit waiting to be sent.
 *
 * No layer: the layer is `snapshot.target`, the same one for every row in the view, and
 * it is the API that derives it from the scope. A per-edit layer was how this used to
 * work and it let one submission write two layers, which cannot be all-or-nothing and
 * therefore cannot be safely retried.
 */
export interface SettingDraft {
  readonly kind: 'set' | 'clear';
  readonly value: unknown;
}

export interface SettingsPanel {
  readonly group: SettingGroup;
  readonly descriptors: readonly SettingDescriptorMeta[];
}

export interface SettingsStore {
  readonly status: Ref<SettingsStatus>;
  readonly error: Ref<ApiError | null>;
  readonly descriptors: Ref<readonly SettingDescriptorMeta[]>;
  readonly models: Ref<readonly SettingModelChoice[]>;
  readonly warnings: Ref<readonly SettingEnvWarning[]>;
  /** Not `readonly`: a scoped screen points this at a project or a run before loading. */
  scope: Ref<SettingsScopeRef>;
  /** The layer this view writes to. Derived by the API from `scope`, never chosen here. */
  readonly target: Ref<SettingScope>;
  /** Not `readonly`: the search box binds to it with `v-model`. */
  query: Ref<string>;
  readonly drafts: Ref<ReadonlyMap<string, SettingDraft>>;
  readonly dirtyCount: ComputedRef<number>;
  readonly panels: ComputedRef<readonly SettingsPanel[]>;
  readonly invalidKeys: ComputedRef<readonly string[]>;
  readonly saving: Ref<boolean>;
  readonly savedAt: Ref<number>;
  valueOf: (key: string) => SettingValue | undefined;
  draftOf: (key: string) => unknown;
  isDirty: (key: string) => boolean;
  canClear: (key: string) => boolean;
  isEditable: (key: string) => boolean;
  isVisible: (descriptor: SettingDescriptorMeta) => boolean;
  validate: (key: string) => string | null;
  load: (locale: Locale) => Promise<void>;
  setValue: (key: string, value: unknown) => void;
  clearOverride: (key: string) => void;
  revert: (key: string) => void;
  discardAll: () => void;
  save: () => Promise<boolean>;
}

const EMPTY_VALUES: readonly SettingValue[] = [];

/**
 * A stand-in for the two members that deliberately do not cross the wire.
 *
 * `isVisible`, `isWritableAt` and `writableScopes` read only `dependsOn`, `secret` and
 * `scope`, every one of which `SettingDescriptorMeta` carries - but all three are typed
 * against `AnySettingDescriptor`, which additionally demands the live Zod `schema` and
 * the `default`. Neither can be sent to a browser and neither is read by any of the
 * three functions, so this pair exists only to satisfy the signature.
 *
 * **Report:** widening those three signatures to `SettingDescriptorMeta` upstream
 * deletes this. It is here because the work that needs it may not edit `packages/**`.
 */
const UNUSED_SCHEMA = z.unknown();

function withRuleFields(meta: SettingDescriptorMeta): AnySettingDescriptor {
  return { ...meta, schema: UNUSED_SCHEMA, default: undefined };
}

/**
 * The settings screen's state.
 *
 * Three decisions are worth stating, because each is what stops this screen from
 * drifting the way architecture 7b warns about.
 *
 * **Drafts are separate from resolved values.** The server's answer - value, origin,
 * which layers were shadowed, which were ignored - is never mutated in place. An edit
 * is a draft keyed by setting, and the screen renders `draft ?? resolved`. That is why
 * "clear this override" can be a *pending* action, and why discarding restores the
 * server's provenance exactly rather than a remembered copy of it.
 *
 * **One view writes one layer.** `snapshot.target` names it, and every row in the view
 * shares it. A row the target may not write is shown *read-only* rather than hidden:
 * 7b's promise is that every option is visible, and twenty-three machine-scope settings
 * that silently vanished because `.env` is not writable through an API would break that
 * promise in the least detectable way possible.
 *
 * **Nothing here re-implements a rule.** Visibility is `isVisible` from `@rv/contracts`,
 * editability is `isWritableAt`, validation is the descriptor's own schema. A second
 * copy of any of the three would be a second thing to keep in step with the registry.
 */
export const useSettingsStore = defineStore('settings', (): SettingsStore => {
  const status = ref<SettingsStatus>('idle');
  const error = shallowRef<ApiError | null>(null);
  // `shallowRef`, not `ref`: these hold whole snapshots that are replaced, never
  // mutated in place, so deep reactivity would buy nothing - and a setting value is
  // arbitrary JSON, whose recursive type makes `UnwrapRef` blow the instantiation
  // depth limit.
  const descriptors = shallowRef<readonly SettingDescriptorMeta[]>([]);
  const values = shallowRef<readonly SettingValue[]>(EMPTY_VALUES);
  const models = shallowRef<readonly SettingModelChoice[]>([]);
  const warnings = shallowRef<readonly SettingEnvWarning[]>([]);
  const scope = shallowRef<SettingsScopeRef>({ projectId: null, runId: null });
  const target = shallowRef<SettingScope>('global');
  const query = ref('');
  const drafts = shallowRef<ReadonlyMap<string, SettingDraft>>(new Map());
  const saving = ref(false);
  const savedAt = ref(0);
  const locale = ref<Locale>('fa');

  const byKey = computed(() => new Map(values.value.map((value) => [value.key, value])));
  const rules = computed(
    () => new Map(descriptors.value.map((meta) => [meta.key, withRuleFields(meta)])),
  );

  /**
   * Fields the server named when it last refused a save, keyed by setting.
   *
   * The envelope carries `issues`, so "three entries were invalid" can be shown on the
   * three rows instead of once at the top of a sixty-row form.
   */
  const rejections = computed(() => {
    const found = new Map<string, string>();
    for (const issue of error.value?.issues ?? []) {
      if (!found.has(issue.path)) found.set(issue.path, issue.message);
    }
    return found;
  });

  function valueOf(key: string): SettingValue | undefined {
    return byKey.value.get(key);
  }

  /**
   * What the control should show.
   *
   * A pending edit wins; otherwise the server's resolved value, unless it is a secret -
   * a secret has no value to show, by construction, so there is nothing to fall back
   * to. A pending *clear* also shows nothing: the client genuinely does not know what
   * the layer underneath holds, and inventing a preview would be guessing at the one
   * answer only the server has.
   */
  function draftOf(key: string): unknown {
    const draft = drafts.value.get(key);
    if (draft !== undefined) return draft.value;
    const resolved = byKey.value.get(key);
    if (resolved === undefined || resolved.secret) return undefined;
    return resolved.value;
  }

  function isDirty(key: string): boolean {
    return drafts.value.has(key);
  }

  /** Whether a write from this view can reach this setting at all. */
  function isEditable(key: string): boolean {
    const rule = rules.value.get(key);
    return rule !== undefined && isWritableAt(rule, target.value);
  }

  /**
   * An override can be cleared only where this view's own layer holds one.
   *
   * `shadowed` is half the answer: a value this layer holds and lost to a more specific
   * one is still an override, and still worth removing. Without it the row would offer
   * nothing for a setting the user can see they set.
   *
   * `ignored` is the third case and the one that would otherwise be unreachable: a
   * layer whose stored value no longer parses still holds an override, and "clear it"
   * is exactly what someone looking at "this layer stores an invalid value" wants to
   * do. The server already allows it - a clear is checked against `isWritableAt`, never
   * against the value - so refusing here would be the client inventing a restriction.
   */
  function canClear(key: string): boolean {
    if (!isEditable(key)) return false;
    const resolved = byKey.value.get(key);
    if (resolved === undefined) return false;
    if (drafts.value.get(key)?.kind === 'clear') return false;
    return (
      resolved.origin === target.value ||
      resolved.shadowed.includes(target.value) ||
      resolved.ignored.some((entry) => entry.scope === target.value)
    );
  }

  /** `dependsOn`, evaluated against the values the user is currently looking at. */
  function isVisible(descriptor: SettingDescriptorMeta): boolean {
    const rule = rules.value.get(descriptor.key) ?? withRuleFields(descriptor);
    return dependenciesHold(rule, draftOf);
  }

  /**
   * The first thing wrong with this row, or `null`.
   *
   * Two sources, in order: the draft against the descriptor's own schema - the same
   * object the API validates with - and then whatever the server said when it last
   * refused this key. A clear is always valid on its own: it restores whatever the
   * layer below holds, and that value was validated when it was written.
   */
  function validate(key: string): string | null {
    const draft = drafts.value.get(key);
    if (draft?.kind === 'set') {
      const result = settingValidator(key).safeParse(draft.value);
      if (!result.success) return result.error.issues[0]?.message ?? 'invalid';
    }
    return rejections.value.get(key) ?? null;
  }

  const invalidKeys = computed(() =>
    [...drafts.value.keys()].filter((key) => validate(key) !== null),
  );

  const dirtyCount = computed(() => drafts.value.size);

  /**
   * The visible descriptors, grouped into panels.
   *
   * Registry order is preserved within a group and never re-sorted: the declaration
   * order *is* the render order now that descriptors carry no `order` field, and a
   * client that sorted by key would scatter `model.stage.*` alphabetically instead of
   * leaving it in pipeline order.
   *
   * Filtering happens here rather than in the view because "which settings are visible"
   * depends on other settings (`dependsOn`) and on the search text, and a component
   * that recomputed that per panel would answer it inconsistently.
   */
  const panels = computed<readonly SettingsPanel[]>(() => {
    const needle = query.value.trim().toLowerCase();
    const matches = (descriptor: SettingDescriptorMeta): boolean => {
      if (needle.length === 0) return true;
      const haystack = [
        descriptor.key,
        localised(descriptor.label, locale.value),
        localised(descriptor.help, locale.value),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    };

    const visible = descriptors.value.filter(
      (descriptor) => isVisible(descriptor) && matches(descriptor),
    );

    return SETTING_GROUPS.map((group) => ({
      group,
      descriptors: visible.filter((descriptor) => descriptor.group === group),
    })).filter((panel) => panel.descriptors.length > 0);
  });

  function apply(snapshot: SettingsSnapshot): void {
    descriptors.value = snapshot.descriptors;
    values.value = snapshot.values;
    models.value = snapshot.models;
    warnings.value = snapshot.warnings;
    scope.value = snapshot.scope;
    target.value = snapshot.target;
    drafts.value = new Map();
    status.value = 'ready';
    error.value = null;
  }

  async function load(active: Locale): Promise<void> {
    locale.value = active;
    status.value = 'loading';
    error.value = null;
    try {
      apply(await useStudioApi().loadSettings(scope.value));
    } catch (caught) {
      status.value = 'error';
      error.value = isApiError(caught)
        ? caught
        : new ApiError({
            failure: 'network',
            code: 'settings-load-failed',
            message: 'the setting registry could not be loaded',
            cause: caught,
          });
    }
  }

  function writeDraft(key: string, draft: SettingDraft | null): void {
    const next = new Map(drafts.value);
    if (draft === null) next.delete(key);
    else next.set(key, draft);
    drafts.value = next;
    // Any edit invalidates the server's last verdict: the fields it named may no longer
    // be the fields that are wrong, and a stale rejection would block a save the server
    // would now accept.
    if (error.value?.failure === 'api') error.value = null;
  }

  function setValue(key: string, value: unknown): void {
    const resolved = byKey.value.get(key);
    if (!isEditable(key)) return;
    // Setting a value back to what the server already resolved *at this layer* is not
    // an edit. Without this the dirty count counts round trips rather than changes, and
    // "discard" starts offering to undo nothing. A secret is exempt: it has no value to
    // compare against, so typing one is always a change.
    if (
      resolved !== undefined &&
      !resolved.secret &&
      resolved.origin === target.value &&
      Object.is(resolved.value, value)
    ) {
      writeDraft(key, null);
      return;
    }
    writeDraft(key, { kind: 'set', value });
  }

  function clearOverride(key: string): void {
    if (!isEditable(key)) return;
    writeDraft(key, { kind: 'clear', value: undefined });
  }

  function revert(key: string): void {
    writeDraft(key, null);
  }

  function discardAll(): void {
    drafts.value = new Map();
    if (error.value?.failure === 'api') error.value = null;
  }

  async function save(): Promise<boolean> {
    if (drafts.value.size === 0 || invalidKeys.value.length > 0) return false;
    const layer = target.value;
    // `machine` is `.env`. The API has no route that would honour it and the rows it
    // owns are read-only, so there is nothing here to send.
    if (!isWritableScope(layer)) return false;

    saving.value = true;
    try {
      const set: { key: string; value: unknown }[] = [];
      const clear: string[] = [];
      for (const [key, draft] of drafts.value) {
        if (draft.kind === 'clear') clear.push(key);
        else set.push({ key, value: draft.value });
      }
      // Parsed rather than cast: a draft that is not JSON - `undefined` from a control
      // that emitted nothing - is a bug worth catching here rather than sending.
      const patch = SettingsPatch.parse({ scope: scope.value, set, clear });
      apply(await useStudioApi().saveSettings(layer, patch));
      savedAt.value += 1;
      return true;
    } catch (caught) {
      error.value = isApiError(caught)
        ? caught
        : new ApiError({
            failure: 'network',
            code: 'settings-save-failed',
            message: 'saving settings failed',
            cause: caught,
          });
      return false;
    } finally {
      saving.value = false;
    }
  }

  return {
    status,
    error,
    descriptors,
    models,
    warnings,
    scope,
    target,
    query,
    drafts,
    dirtyCount,
    panels,
    invalidKeys,
    saving,
    savedAt,
    valueOf,
    draftOf,
    isDirty,
    canClear,
    isEditable,
    isVisible,
    validate,
    load,
    setValue,
    clearOverride,
    revert,
    discardAll,
    save,
  };
});
