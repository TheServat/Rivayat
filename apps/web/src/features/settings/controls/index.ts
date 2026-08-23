import type { Component } from 'vue';

import type { SettingControl } from '../../../api/schemas/settings';

import JsonControl from './JsonControl.vue';
import ModelPickerControl from './ModelPickerControl.vue';
import MoneyControl from './MoneyControl.vue';
import MultiSelectControl from './MultiSelectControl.vue';
import NumberControl from './NumberControl.vue';
import SecretControl from './SecretControl.vue';
import SelectControl from './SelectControl.vue';
import SliderControl from './SliderControl.vue';
import TextControl from './TextControl.vue';
import ToggleControl from './ToggleControl.vue';
import UrlControl from './UrlControl.vue';

/** The discriminant of `SettingControl` - which component renders a setting. */
export type SettingControlKind = SettingControl['kind'];

/**
 * Every kind the registry can declare, in one list the map below is checked against.
 *
 * A literal tuple rather than a derivation, so both directions are guarded: `satisfies`
 * proves every member is a real control kind, and `MissingKinds` fails to compile if
 * `@rv/contracts` gains one this list has not heard of. Either error is better than a
 * setting that renders no input.
 */
export const RENDERABLE_CONTROLS = [
  'toggle',
  'select',
  'multi-select',
  'number',
  'slider',
  'text',
  'secret',
  'url',
  'money',
  'model-picker',
  'json',
] as const satisfies readonly SettingControlKind[];

type MissingKinds = Exclude<SettingControlKind, (typeof RENDERABLE_CONTROLS)[number]>;
const _kindsAreExhaustive: MissingKinds extends never ? true : never = true;
void _kindsAreExhaustive;

/**
 * Control kind to component. The registry, not a `v-if` ladder.
 *
 * `Record<SettingControlKind, Component>` is total by type, so adding a member to the
 * control union upstream and forgetting the component is a compile error - the same
 * open/closed discipline CLAUDE.md §2 requires of the domain layer, applied to the
 * form. It is what makes the settings screen generated rather than hand-written: the
 * row picks a component by key and never learns what any of them do.
 */
export const SETTING_CONTROL_COMPONENTS: Readonly<Record<SettingControlKind, Component>> = {
  toggle: ToggleControl,
  select: SelectControl,
  'multi-select': MultiSelectControl,
  number: NumberControl,
  slider: SliderControl,
  text: TextControl,
  secret: SecretControl,
  url: UrlControl,
  money: MoneyControl,
  'model-picker': ModelPickerControl,
  json: JsonControl,
};

export function componentForControl(control: SettingControlKind): Component {
  return SETTING_CONTROL_COMPONENTS[control];
}
