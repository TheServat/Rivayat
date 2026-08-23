/**
 * What one wizard answer does.
 *
 * A patch is a shallow-per-block override, not a free-form deep merge. That is a
 * deliberate limit: an answer may say "outlines are thick and black" by setting three
 * fields of `line`, and may not say "change one leaf six levels down", because a UI
 * cannot render the second kind and a reviewer cannot audit it.
 *
 * `negative` is the one field that accumulates rather than replaces - every answer that
 * rules something out should rule it out, and the last answer wins is the wrong rule
 * for a list of prohibitions.
 */

import type {
  AmbientMotion,
  BoilSettings,
  CameraGrammar,
  Fps,
  LineStyle,
  MotionPrinciples,
  MotionStyle,
  Palette,
  Shading,
  ShapeLanguage,
  StepMode,
  Texture,
  VisualStyle,
} from '@rv/contracts';

export interface MotionPatch {
  readonly fps?: Fps;
  readonly stepMode?: StepMode;
  readonly tempo?: number;
  readonly principles?: Partial<MotionPrinciples>;
  readonly boil?: Partial<BoilSettings>;
  readonly ambient?: Partial<AmbientMotion>;
  readonly camera?: Partial<CameraGrammar>;
}

export interface StyleFieldPatch {
  readonly palette?: Partial<Palette>;
  readonly line?: Partial<LineStyle>;
  readonly shading?: Partial<Shading>;
  readonly texture?: Partial<Texture>;
  readonly shape?: Partial<ShapeLanguage>;
  readonly backgroundTreatment?: VisualStyle['backgroundTreatment'];
  /** Appended and de-duplicated, never replaced. */
  readonly negative?: readonly string[];
  readonly motion?: MotionPatch;
}

/**
 * Copies `patch` over `base`, ignoring keys whose value is `undefined`.
 *
 * `exactOptionalPropertyTypes` makes "absent" and "present but undefined" different
 * things, and a plain spread of a `Partial` would let the second silently erase a real
 * value. The cast is confined to this one function.
 */
function overlay<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (patch === undefined) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

export function applyVisualPatch(visual: VisualStyle, patch: StyleFieldPatch): VisualStyle {
  return {
    ...visual,
    palette: overlay(visual.palette, patch.palette),
    line: overlay(visual.line, patch.line),
    shading: overlay(visual.shading, patch.shading),
    texture: overlay(visual.texture, patch.texture),
    shape: overlay(visual.shape, patch.shape),
    backgroundTreatment: patch.backgroundTreatment ?? visual.backgroundTreatment,
    negative:
      patch.negative === undefined
        ? visual.negative
        : [...new Set([...visual.negative, ...patch.negative])],
  };
}

export function applyMotionPatch(motion: MotionStyle, patch: StyleFieldPatch): MotionStyle {
  const motionPatch = patch.motion;
  if (motionPatch === undefined) return motion;
  return {
    ...motion,
    fps: motionPatch.fps ?? motion.fps,
    stepMode: motionPatch.stepMode ?? motion.stepMode,
    tempo: motionPatch.tempo ?? motion.tempo,
    principles: overlay(motion.principles, motionPatch.principles),
    boil: overlay(motion.boil, motionPatch.boil),
    ambient: overlay(motion.ambient, motionPatch.ambient),
    camera: overlay(motion.camera, motionPatch.camera),
  };
}
