/**
 * The preset registry.
 *
 * A `Map` keyed by slug rather than a `switch` anywhere, per CLAUDE.md §2: adding a
 * style is adding an entry to `PRESET_DEFINITIONS`, and nothing else in the system
 * learns its name.
 *
 * Compiled once at module load. Compilation is pure - `toStylePreset` parses the two
 * blocks and derives the prompts - so this costs a few milliseconds and buys a hard
 * guarantee that a malformed preset cannot reach a user.
 */

import type { ArtMedium, Slug } from '@rv/contracts';
import { NotFoundError, type Result, err, ok } from '@rv/shared-kernel';

import { PRESET_DEFINITIONS } from './library';
import { type StylePreset, toStylePreset } from './preset';

export const STYLE_PRESETS: readonly StylePreset[] = PRESET_DEFINITIONS.map((definition) =>
  toStylePreset(definition),
);

const BY_ID: ReadonlyMap<string, StylePreset> = new Map(
  STYLE_PRESETS.map((preset) => [preset.id, preset]),
);

/** Every preset id, in shelf order. */
export function presetIds(): readonly Slug[] {
  return STYLE_PRESETS.map((preset) => preset.id);
}

/**
 * Looks a preset up.
 *
 * A `Result` rather than `undefined`: the id usually arrives from an API request or a
 * CLI flag, so a miss is expected input, not programmer error.
 */
export function findPreset(id: string): Result<StylePreset, NotFoundError> {
  const preset = BY_ID.get(id);
  if (preset === undefined) return err(new NotFoundError('style preset', id));
  return ok(preset);
}

/** Presets that imitate a given physical medium. */
export function presetsForMedium(medium: ArtMedium): readonly StylePreset[] {
  return STYLE_PRESETS.filter((preset) => preset.medium === medium);
}

export type { StylePreset, StylePresetDefinition, PresetDraftOptions } from './preset';
export { toStylePreset } from './preset';
export { PRESET_DEFINITIONS } from './library';
export type { MotionSignature } from './motion-signature';
export {
  MOTION_DISTINCTNESS_FLOOR,
  motionDifferences,
  coreMotionDistance,
  motionDistance,
  motionSignature,
} from './motion-signature';
