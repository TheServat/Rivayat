import type {
  SettingDescriptorMeta,
  SettingModelChoice,
  SettingValue,
} from '../../../api/schemas/settings';

/**
 * The one shape every setting control accepts.
 *
 * Identical across all eleven kinds so `SettingRow` can render `<component :is>`
 * without knowing which one it picked. The moment one control needs a prop the others
 * do not get, the row has to branch - and a branch per control kind in the row is
 * precisely the hand-wired form architecture 7b exists to prevent.
 *
 * `descriptor.control` is a discriminated object, not a string: it carries that
 * control's own render hints (`min`/`max`/`step` for a slider, `stepNanoUsd` for money,
 * `capability`/`providers` for a model picker). Each component narrows on its own
 * `kind` once, with a computed guard, and reads its hints off the narrowed object -
 * never off a cast and never off a schema's internals.
 *
 * `value` is the server's resolved answer and `draft` is what the user is currently
 * looking at. Both are passed because the secret control needs the former (`value.set`)
 * and every other control needs the latter, and because a control that only saw the
 * draft could not tell "unset" from "set to the built-in default".
 */
export interface SettingControlProps {
  readonly descriptor: SettingDescriptorMeta;
  readonly value: SettingValue | undefined;
  readonly draft: unknown;
  readonly invalid: boolean;
  /**
   * The row may be read at this scope but not written.
   *
   * True for every machine-scope setting in a database-backed view: `.env` is not
   * writable through the API. The control must still render its value - hiding the row
   * would break 7b's "every option is configurable from the UI" in the least detectable
   * way - so this disables editing rather than the element wherever the platform allows
   * it. `input`/`textarea` get the native `readonly` attribute, which stays focusable
   * and readable; `select`, `range` and `checkbox` have no such attribute and get
   * `disabled`, which is the only thing that actually stops them.
   */
  readonly readonly: boolean;
  /** Id for the focusable element, so the row's `<label for>` reaches it. */
  readonly inputId: string;
  /** Ids of the help and error text, for `aria-describedby`. */
  readonly describedBy: string;
  readonly models: readonly SettingModelChoice[];
}

export interface SettingControlEmits {
  /** A new value for the setting. Latin-digit numbers and real booleans, never strings. */
  change: [value: unknown];
}
