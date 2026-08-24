/**
 * What S8 Choreograph needs on the job payload, and why so much of it travels inline.
 *
 * The stage itself is `Shot[] → AnimationIR` (RV-145). The shots are the input, and
 * everything else here exists because the thing that would otherwise supply it is not
 * built yet, so the honest choice is between an inline field and a stage that cannot
 * run at all:
 *
 * | field       | belongs to                          | why it is on the payload today                              |
 * | ----------- | ----------------------------------- | ----------------------------------------------------------- |
 * | `motion`    | the locked `StyleBible` (S1)        | `StyleBibleReader` answers one question, `isLocked`          |
 * | `rigs`      | the `AssetVersion` (S6)             | nothing in this build stores a rigged version                |
 * | `library`   | the clip library (ADR-0008 §5)      | the library has a shape and no store                         |
 * | `variants`  | `ShotAssetPin` (S7 compilation)     | a shot names a `VariantId`, an IR node names a `variantKey`  |
 * | `speakers`  | the cast (S3)                       | a line names an entity, a layout names an instance           |
 *
 * Each is optional, and the compiler is explicit about what it can and cannot do
 * without it: no rig and no library means a blocking action is compiled as a *named*
 * clip on the instance and the name is checked by whoever bakes it; a rig and a library
 * means the name is resolved here, retargeted onto this rig, and a name that resolves
 * to nothing fails the stage with the shot to point at. That is the acceptance
 * criterion "every referenced clip exists on the referenced asset", and it is only
 * enforceable where the rig is in scope.
 *
 * `seed` is absent on purpose: the run already has one, and a stage that let the
 * payload name a second seed would make two runs of one run's payload diverge.
 */

import {
  AnimationIR,
  AnimationClip,
  AssetInstanceKey,
  ClipLibraryEntry,
  EntityId,
  Fps,
  Label,
  MotionStyle,
  Rig,
  Shot,
  Slug,
  VariantId,
} from '@rv/contracts';
import { z } from 'zod';

/** The ambient behaviours the style bible parameterises, from RV-145. */
export const AmbientBehaviourKind = z.enum(['wind', 'breathe', 'blink', 'boil']);
export type AmbientBehaviourKind = z.infer<typeof AmbientBehaviourKind>;

/**
 * Which instances are alive, and how.
 *
 * The bible says *how much* a thing moves; only the story knows *which* placed things
 * breathe and which are scenery. A `Shot` carries neither - an `AssetInstance` names an
 * asset and a transform - so attaching `breathe` to everything would have the fence
 * posts breathing, and attaching it to nothing would waste the cheapest life in the
 * system.
 */
export const AmbientAssignment = z.strictObject({
  instance: AssetInstanceKey,
  kinds: z.array(AmbientBehaviourKind).min(1),
});
export type AmbientAssignment = z.infer<typeof AmbientAssignment>;

/** Who a dialogue line belongs to, in the shot's own vocabulary. */
export const SpeakerBinding = z.strictObject({
  entity: EntityId,
  instance: AssetInstanceKey,
});
export type SpeakerBinding = z.infer<typeof SpeakerBinding>;

/**
 * The skeleton a placed instance is drawn on, plus the clips its own asset carries.
 *
 * Both together, because clip resolution needs both: the asset's own clip always wins
 * (it was authored on this exact skeleton and needs no rescaling), and the rig is what
 * a library clip has to be compatible *with*.
 */
export const InstanceRig = z.strictObject({
  instance: AssetInstanceKey,
  rig: Rig,
  clips: z.array(AnimationClip).default([]),
});
export type InstanceRig = z.infer<typeof InstanceRig>;

/**
 * One library clip: the entry that says which skeletons it fits, and the motion itself.
 *
 * The fragment travels with the entry because `AnimationClip.irHash` addresses it in a
 * content store this build does not have. Retargeting needs the document, not the hash.
 */
export const LibraryClip = z.strictObject({
  entry: ClipLibraryEntry,
  fragment: AnimationIR,
});
export type LibraryClip = z.infer<typeof LibraryClip>;

/** The two spellings of one variant, which `ShotAssetPin` would otherwise reconcile. */
export const VariantBinding = z.strictObject({
  id: VariantId,
  key: Slug,
});
export type VariantBinding = z.infer<typeof VariantBinding>;

export const ChoreographStageRequest = z.strictObject({
  shots: z.array(Shot).min(1).describe('In timeline order. Concatenated into one timeline.'),
  /** The composition's name. Falls back to the first shot's beat. */
  name: Label.optional(),
  /**
   * Frame rate of the composition. Defaults to the style's own.
   *
   * On the composition rather than on the render because it changes the *document*: a
   * 12 fps cut and a 24 fps cut of the same shots are two films, and which one was
   * authored has to be recorded rather than chosen at render time.
   */
  fps: Fps.optional(),
  motion: MotionStyle.optional().describe(
    'The style bible’s motion block: easings, tempo, ambient amplitudes, camera grammar.',
  ),
  ambient: z.array(AmbientAssignment).default([]),
  speakers: z.array(SpeakerBinding).default([]),
  rigs: z.array(InstanceRig).default([]),
  library: z.array(LibraryClip).default([]),
  variants: z.array(VariantBinding).default([]),
});
export type ChoreographStageRequest = z.infer<typeof ChoreographStageRequest>;
