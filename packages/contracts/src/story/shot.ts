/**
 * The shot - the sequence unit, per docs/01 §3.4.
 *
 * A shot is authored once, in a **format-agnostic scene space**, and reframed into
 * every deliverable aspect afterwards. That is the single most valuable constraint in
 * this file, so it is worth being precise about what it costs and what it buys.
 *
 * The alternative - composing the same beat separately for 16:9 and 9:16 - is how this
 * normally goes wrong: two compositions drift, the vertical cut loses the prop that the
 * next scene depends on, and every edit is paid for twice. Instead the composer places
 * assets in one canvas that is wider *and* taller than any single crop needs, and
 * declares two things that let a machine find the crop:
 *
 * - `safeArea` - the region no deliverable may cut into. Titles, subtitles, and the
 *   parts of the staging that carry meaning live inside it.
 * - `focusTarget` - what the frame is *about*, either a named asset instance (so a
 *   moving subject is tracked through the shot) or a static region, plus how hard the
 *   solver must fight to keep it.
 *
 * Given `sceneSpace.size`, a target aspect, the safe area and the focus target, the
 * reframer solves for a crop rectangle with no further input. Where the automatic solve
 * is wrong - a two-shot that has to become a single in vertical, say - `sceneSpace`
 * carries a manual crop for that one aspect, and nothing else about the shot changes.
 *
 * Everything else here follows from the same idea: `layout` is z-ordered layers of
 * placed asset instances so parallax is a property of the placement rather than of the
 * render, and `blocking` addresses those instances by a shot-local handle so a clip
 * change never has to know an asset id.
 */

import { z } from 'zod';

import {
  HexColor,
  IsoInstant,
  Label,
  Millis,
  NonNegativeInt,
  NormRect,
  PositiveInt,
  SemanticKey,
  Sha256Hex,
  Size,
  Slug,
  Transform2D,
  Unit01,
} from '../primitives/common';
import { AssetId, AssetVersionId, BeatId, ShotId, VariantId } from '../primitives/ids';
// A clip loops the same way whether it is described on the asset or scheduled in a
// shot, so the enum is the asset library's and this file borrows it rather than
// growing a second one that would drift.
import { AssetRef, LoopMode, PinnedAssetRef, pinsRef } from '../asset/asset';
import { DeliveryAspect, DialogueLine } from './story-bible';

// ── placement ───────────────────────────────────────────────────────────────

/**
 * A shot-local handle for one placed asset, e.g. `kael-left` or `lantern`.
 *
 * Deliberately a slug rather than a minted id. Shots are written by a model, and asking
 * one to emit and then consistently re-quote a ULID across a layout, a blocking list
 * and a focus target is a reliable way to get three ids that nearly match. A name the
 * writer chose is one it can remember, and it stays readable in a diff. Uniqueness is
 * only required within the shot.
 */
export const AssetInstanceKey = Slug.describe(
  'Shot-local name for one placed asset, e.g. "kael-left". Unique within this shot. ' +
    'Reuse exactly this string wherever the shot refers to this instance.',
);
export type AssetInstanceKey = z.infer<typeof AssetInstanceKey>;

/**
 * Distance from the camera, as a parallax divisor.
 *
 * 1 is the focal plane and moves with the camera exactly; below 1 is nearer and
 * over-travels; above 1 is farther and lags. Kept separate from a layer's `z`, which is
 * only paint order: two instances can share a paint order and still travel at different
 * rates, and a background that must sit behind everything can still be at depth 8.
 */
export const ParallaxDepth = z
  .number()
  .min(0.01)
  .max(100)
  .default(1)
  .describe(
    'Parallax distance. 1 is the focal plane, below 1 is nearer the camera and moves ' +
      'more, above 1 is farther and moves less. Use 1 unless the shot has a camera move.',
  );
export type ParallaxDepth = z.infer<typeof ParallaxDepth>;

/**
 * One asset placed in the scene, **already compiled for render**.
 *
 * It names the exact `AssetVersion` rather than the asset, because a render has to be
 * bit-reproducible and "the current version" is not a thing a replay can resolve.
 *
 * This is the locked end of the floating/locked pair documented on `AssetRef`
 * (`asset/asset.ts`): an author writes an `AssetRef`, whose `versionId` is optional and
 * therefore means "whatever is current"; compilation resolves it and records the
 * resolution as a {@link ShotAssetPin}; what lands here - and in `AssetInstanceNode` in
 * `anim/ir.ts` - carries the concrete version and nothing floating. A shot that still
 * holds an unpinned reference has not been compiled and cannot be rendered.
 *
 * One deliberate difference from `AssetRef`: the variant is addressed here by its
 * minted `VariantId` rather than by the `variantKey` slug the author wrote, because
 * the render resolves nothing. `ShotAssetPin` is where the two spellings meet.
 */
export const AssetInstance = z.strictObject({
  instance: AssetInstanceKey,
  assetId: AssetId.describe('The asset in the library.'),
  assetVersionId: AssetVersionId.describe(
    'The exact version placed here. Pinning the version is what makes a re-render of ' +
      'this shot reproduce this shot.',
  ),
  variantId: VariantId.optional().describe(
    'The variant - wardrobe, expression, damage state. Omit for the asset default.',
  ),
  transform: Transform2D.describe(
    'Placement in scene-space units. The origin is the top-left of the scene space and ' +
      'the anchor is normalised within the asset itself.',
  ),
  depth: ParallaxDepth,
  tint: HexColor.optional().describe(
    'Multiplied over the asset for this placement only, e.g. cooling a character in ' +
      'moonlight. Omit to leave the asset as generated - a tint is never a substitute ' +
      'for the right variant.',
  ),
  opacity: Unit01.optional().describe(
    'Overrides the transform opacity for this placement. Omit unless the instance is ' +
      'deliberately semi-transparent, as for a ghost or a reflection.',
  ),
});
export type AssetInstance = z.infer<typeof AssetInstance>;

/**
 * A z-ordered band of the layout.
 *
 * Grouping exists so a whole band can be re-lit, hidden, or re-parallaxed as a unit -
 * "everything behind the characters" is a thing a director says, and it should be a
 * thing the data can express.
 */
export const ShotLayer = z.strictObject({
  z: NonNegativeInt.describe(
    'Paint order. 0 is painted first and is therefore furthest back; higher numbers ' +
      'paint over lower ones. Unique within the shot.',
  ),
  name: Label.optional().describe(
    'What this band is, e.g. "far background", "foreground occluders". For humans only.',
  ),
  instances: z
    .array(AssetInstance)
    .min(1)
    .describe('The assets placed in this band. A band with nothing in it should not exist.'),
});
export type ShotLayer = z.infer<typeof ShotLayer>;

// ── format-agnostic authoring ───────────────────────────────────────────────

/**
 * How hard the reframer must fight to keep the focus in frame.
 *
 * Three levels rather than a boolean because the solver has to break ties: when a 9:16
 * crop cannot hold both faces of a two-shot, it needs to know which face was the point.
 */
export const FOCUS_PRIORITIES = ['must-keep', 'prefer', 'optional'] as const;

export const FocusPriority = z.enum(FOCUS_PRIORITIES);
export type FocusPriority = z.infer<typeof FocusPriority>;

/**
 * What the frame is about.
 *
 * Naming an `instance` is the better answer whenever there is one: the reframer can
 * then follow that instance's animated transform through the shot, so a character who
 * crosses the scene stays framed instead of walking out of a crop that was solved once
 * at frame zero. `region` is the static fallback and the tie-breaker for the frames the
 * instance does not exist in.
 */
export const FocusTarget = z.strictObject({
  instance: AssetInstanceKey.nullable().describe(
    'The asset instance the frame is about, by its shot-local name. Null when the ' +
      'subject is not a single asset - a landscape, an empty room - and only region applies.',
  ),
  region: NormRect.describe(
    'The subject region as fractions of the scene space, used when no instance is named ' +
      'and as the tie-breaker when one is. Keep it tight: a region covering the whole ' +
      'canvas tells the reframer nothing.',
  ),
  priority: FocusPriority.default('must-keep').describe(
    'How the solver treats a crop that would cut this. "must-keep" fails the crop, ' +
      '"prefer" penalises it, "optional" ignores it.',
  ),
});
export type FocusTarget = z.infer<typeof FocusTarget>;

/**
 * The canvas the shot is composed in, and the crops it owes.
 *
 * Carried on every shot rather than once per series so a shot travels as a complete
 * reframing problem: the delivery stage can crop a single shot without loading the
 * bible, and a shot that legitimately needs a different canvas - a title card, an
 * insert - can have one without an exception mechanism.
 *
 * The canvas is normally composed larger than the master aspect in *both* dimensions,
 * so that the vertical crop has head-room and the wide crop has shoulder-room. That is
 * a composition convention rather than a schema rule, because a 1:1-only series has no
 * reason to pay for it.
 */
export const SceneSpace = z
  .strictObject({
    size: Size.describe(
      'The authoring canvas in scene units. Every transform in the layout is expressed in ' +
        'these units. Compose it wider and taller than any single deliverable needs.',
    ),
    masterAspect: DeliveryAspect.describe(
      'The aspect this shot was composed for. The crop for this aspect is the one the ' +
        'director actually saw.',
    ),
    reframeTargets: z
      .array(DeliveryAspect)
      .min(1)
      .describe(
        'Every aspect this shot must be croppable to. Include the master aspect. The ' +
          'composer is obliged to keep the safe area legible in all of them.',
      ),
    overrides: z
      .partialRecord(DeliveryAspect, NormRect)
      .default({})
      .describe(
        'Manual crop rectangle for a target aspect the automatic solve gets wrong, as ' +
          'fractions of the scene space. Anything absent is solved from safeArea and ' +
          'focusTarget. Add an entry only after seeing the automatic crop fail.',
      ),
  })
  // The three sentences of prose above ("Include the master aspect", "Anything absent
  // is solved") are obligations, and prose is not enforcement: `.superRefine` is
  // dropped from the JSON Schema a model is constrained by (see docs/00-research.md
  // §1), so an LLM will occasionally emit an override for an aspect this shot does not
  // ship. Caught here or discovered at delivery.
  .superRefine((space, ctx) => {
    // `.min(1)` already reports an empty list; repeating it at the same path only
    // gives the repair loop two issues to fix for one mistake.
    if (space.reframeTargets.length > 0 && !space.reframeTargets.includes(space.masterAspect)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reframeTargets'],
        message: `reframeTargets must include the master aspect ${space.masterAspect}`,
      });
    }
    if (new Set(space.reframeTargets).size !== space.reframeTargets.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['reframeTargets'],
        message: 'reframeTargets must not repeat an aspect',
      });
    }
    for (const aspect of Object.keys(space.overrides)) {
      if (!space.reframeTargets.includes(aspect as DeliveryAspect)) {
        ctx.addIssue({
          code: 'custom',
          path: ['overrides', aspect],
          message: `cannot override the crop for ${aspect}, which this shot does not ship`,
        });
      }
    }
  });
export type SceneSpace = z.infer<typeof SceneSpace>;

// ── camera ──────────────────────────────────────────────────────────────────

export const SHOT_FRAMINGS = [
  'establishing',
  'wide',
  'medium',
  'close',
  'extreme-close',
  'insert',
] as const;

export const ShotFraming = z.enum(SHOT_FRAMINGS);
export type ShotFraming = z.infer<typeof ShotFraming>;

export const CAMERA_MOVES = [
  'static',
  'pan-left',
  'pan-right',
  'tilt-up',
  'tilt-down',
  'dolly-in',
  'dolly-out',
  'truck-left',
  'truck-right',
  'crane-up',
  'crane-down',
  'zoom-in',
  'zoom-out',
  'handheld',
  'whip-pan',
  'rack-focus',
] as const;

export const CameraMove = z.enum(CAMERA_MOVES);
export type CameraMove = z.infer<typeof CameraMove>;

/**
 * The camera as an intent, not as a matrix.
 *
 * Framing and move are enumerated because the choreographer turns them into concrete
 * parallax and easing from the style bible's motion direction - which is how two series
 * built from the same schema still move differently.
 */
export const ShotCamera = z.strictObject({
  framing: ShotFraming.describe(
    'How close the master framing sits to the subject. "insert" is a detail with no ' +
      'spatial relationship to the rest of the scene.',
  ),
  move: CameraMove.describe(
    'The camera move over the shot. Use "static" unless the move does something - a ' +
      'move that only decorates costs render time and reads as noise.',
  ),
  focusTarget: FocusTarget.describe(
    'What the camera is on. This is composition intent; the shot-level focusTarget is ' +
      'what the reframer solves against, and the two are normally the same.',
  ),
});
export type ShotCamera = z.infer<typeof ShotCamera>;

// ── blocking ────────────────────────────────────────────────────────────────

/**
 * One clip played on one instance, over one span of the shot.
 *
 * The clip is named rather than referenced by id for the same reason instances are:
 * `walk-cycle` is a thing the writer of the shot knows, and the resolver maps it to a
 * registered `Clip` on the instance's rig at choreograph time. A name that does not
 * resolve is caught there, with the shot to point at.
 */
export const ShotAction = z.strictObject({
  instance: AssetInstanceKey.describe(
    'Which placed instance performs. Must match an instance declared in the layout.',
  ),
  clip: Slug.describe(
    'The clip to play, by its registered name on the rig of that asset, e.g. ' +
      '"walk-cycle", "reach-left", "flinch".',
  ),
  startMs: Millis.describe('When the clip starts, as an offset from the start of the shot.'),
  durationMs: PositiveInt.describe(
    'How long the clip runs for. Must be greater than zero and should not run past the ' +
      'end of the shot.',
  ),
  loop: LoopMode.default('once').describe(
    'What happens when the clip reaches its end before durationMs is up. "hold-last" ' +
      'freezes on the final pose, "once" returns to idle.',
  ),
  speed: z
    .number()
    .min(0.05)
    .max(8)
    .default(1)
    .describe('Playback rate. 1 is as authored; 0.5 is half speed.'),
  blendMs: Millis.default(0).describe(
    'Cross-fade into this clip from whatever the instance was doing, in milliseconds. ' +
      'A non-zero blend is what stops a pose change from popping.',
  ),
});
export type ShotAction = z.infer<typeof ShotAction>;

// ── audio ───────────────────────────────────────────────────────────────────

export const SfxCue = z.strictObject({
  key: SemanticKey.describe('Library address of the effect, e.g. "sfx/door-creak/slow".'),
  startMs: Millis.describe('When it fires, as an offset from the start of the shot.'),
  gain: Unit01.default(1).describe('Level, 0 to 1, before loudness normalisation.'),
  loop: z
    .boolean()
    .default(false)
    .describe('True for a bed that runs to the end of the shot, e.g. rain.'),
});
export type SfxCue = z.infer<typeof SfxCue>;

/**
 * What the score does across this shot.
 *
 * Expressed as a transition rather than as a track, because music is continuous across
 * shots and a shot only ever changes what was already playing.
 */
export const MusicCue = z.strictObject({
  key: SemanticKey.describe('Library address of the cue, e.g. "music/theme-kael/low".'),
  action: z
    .enum(['start', 'continue', 'swell', 'fade', 'stop'])
    .describe(
      'What the score does here. "continue" means it was already playing and is unchanged.',
    ),
  mood: Label.describe('One word for what the cue has to feel like, e.g. "unresolved".'),
  intensity: Unit01.describe('How present the music is, 0 for barely there to 1 for full.'),
});
export type MusicCue = z.infer<typeof MusicCue>;

export const ShotAudio = z.strictObject({
  sfx: z.array(SfxCue).default([]).describe('Effects fired in this shot, in any order.'),
  music: MusicCue.nullable()
    .default(null)
    .describe(
      'The music cue for this shot. Null for silence, which is a choice - use it. Use ' +
        'action "continue" when the previous cue simply carries on.',
    ),
});
export type ShotAudio = z.infer<typeof ShotAudio>;

// ── the shot ────────────────────────────────────────────────────────────────

/**
 * One continuous camera setup.
 *
 * `beatRef` is what ties it back to the story: every shot exists to carry exactly one
 * beat, and a beat with no shot is an unrealised beat. That one-to-many link is what
 * lets an edit to the outline invalidate precisely the shots it affects rather than the
 * whole episode.
 */
export const Shot = z
  .strictObject({
    id: ShotId,
    index: NonNegativeInt.describe(
      'Position in the scene shot list, starting at 0. Contiguous, no gaps.',
    ),
    durationMs: PositiveInt.describe(
      'How long the shot is on screen, in milliseconds. Must be greater than zero - a ' +
        'zero-length shot is a deleted shot.',
    ),
    beatRef: BeatId.describe('The single beat this shot carries.'),
    sceneSpace: SceneSpace.describe('The authoring canvas and the crops this shot owes.'),
    camera: ShotCamera.describe('Framing, move, and what the camera is on.'),
    layout: z
      .array(ShotLayer)
      .min(1)
      .describe('The staging, as z-ordered bands of placed assets. At least one band.'),
    blocking: z
      .array(ShotAction)
      .default([])
      .describe(
        'Timed clips played on the placed instances. An empty list is a held frame, which ' +
          'is legal and should be deliberate.',
      ),
    dialogue: z
      .array(DialogueLine)
      .default([])
      .describe('Lines spoken during this shot, timed from the start of the shot.'),
    audio: ShotAudio.describe('Effects and score for this shot.'),
    safeArea: NormRect.describe(
      'The region of the scene space no deliverable crop may cut into, as fractions of ' +
        'the canvas. Everything that carries meaning - faces, the prop the next scene ' +
        'needs, burned-in text - goes inside it.',
    ),
    focusTarget: FocusTarget.describe(
      'What every reframe must keep. Normally the same as the camera focus target; they ' +
        'differ when the composition is about one thing and the crop has to protect another.',
    ),
  })
  /**
   * The shot-local handles have to resolve, and nothing else can check that.
   *
   * `AssetInstanceKey` buys readability by being a name the writer chose rather than a
   * minted id, and the price of that choice is that a typo is a *valid slug*. Three
   * fields quote a handle back - `blocking[].instance`, `camera.focusTarget.instance`
   * and `focusTarget.instance` - and each one that does not resolve is a silent
   * failure much later: an action that plays on nothing, or a reframe solved against a
   * subject that is not in the shot. The rig and the IR already refuse a dangling
   * internal reference; a shot is no different.
   */
  .superRefine((shot, ctx) => {
    // With no layout at all, `layout.min(1)` is the actionable finding: every handle
    // dangles by construction and repeating that three times helps nobody.
    if (shot.layout.length === 0) return;

    const placed = new Set<string>();
    shot.layout.forEach((layer, layerIndex) => {
      layer.instances.forEach((instance, instanceIndex) => {
        if (placed.has(instance.instance)) {
          ctx.addIssue({
            code: 'custom',
            path: ['layout', layerIndex, 'instances', instanceIndex, 'instance'],
            message: `duplicate instance name ${instance.instance}; handles are unique within a shot`,
          });
        }
        placed.add(instance.instance);
      });
    });

    const paintOrders = new Set<number>();
    shot.layout.forEach((layer, layerIndex) => {
      if (paintOrders.has(layer.z)) {
        ctx.addIssue({
          code: 'custom',
          path: ['layout', layerIndex, 'z'],
          message: `duplicate paint order ${String(layer.z)}; two bands cannot both be painted at once`,
        });
      }
      paintOrders.add(layer.z);
    });

    shot.blocking.forEach((action, index) => {
      if (!placed.has(action.instance)) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocking', index, 'instance'],
          message: `${action.instance} is not placed in this shot's layout`,
        });
      }
    });

    for (const [path, target] of [
      [['camera', 'focusTarget', 'instance'], shot.camera.focusTarget],
      [['focusTarget', 'instance'], shot.focusTarget],
    ] as const) {
      if (target.instance !== null && !placed.has(target.instance)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path],
          message: `${target.instance} is not placed in this shot's layout`,
        });
      }
    }
  });
export type Shot = z.infer<typeof Shot>;

// ── compilation: floating references become pinned ones ─────────────────────

/**
 * One authoring reference and the concrete version compilation resolved it to.
 *
 * The pinning step recorded as a value rather than performed as a side effect, for the
 * same reason `ReframePlan` is a value: it can be shown, diffed and replayed. Given
 * these pins and the shot as authored, a re-render a year later reproduces the frames
 * even after the library has moved on - and when it does not, the diff says which
 * asset moved.
 *
 * `authored` may be floating (`AssetRef.versionId` absent, meaning "whatever is
 * current"); `pinned` never is. See {@link pinsRef} for what makes the pair legal.
 */
export const ShotAssetPin = z
  .strictObject({
    instance: AssetInstanceKey.describe(
      'The placed instance this pin is for. Must name an instance in the compiled shot.',
    ),
    authored: AssetRef.describe('The reference exactly as the author wrote it.'),
    pinned: PinnedAssetRef.describe('The version it resolved to. Never floating.'),
  })
  .superRefine((pin, ctx) => {
    if (!pinsRef(pin.authored, pin.pinned)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pinned'],
        message:
          'a pin may only resolve what the author left open: the asset, the variant, ' +
          'and any version the author already froze must survive compilation unchanged',
      });
    }
  });
export type ShotAssetPin = z.infer<typeof ShotAssetPin>;

/**
 * The record of compiling one shot for render.
 *
 * `styleChecksum` is on the record rather than left implicit because it is half of the
 * answer: a pin is only valid for the style the assets were generated under, so a
 * restyle invalidates every compilation rather than quietly re-serving artwork from
 * the wrong library (docs/02 §5).
 *
 * The instance handles are unique for the same reason they are inside a `Shot` - a
 * compilation that pinned `kael-left` twice has pinned it to one of two versions and
 * nobody can tell which.
 */
export const ShotCompilation = z
  .strictObject({
    shotId: ShotId.describe('The shot these pins were resolved for.'),
    styleChecksum: Sha256Hex.describe(
      'The locked style the versions were resolved against. A different checksum ' +
        'invalidates every pin below.',
    ),
    compiledAt: IsoInstant.describe('Authoring time of the resolution, from the injected clock.'),
    pins: z
      .array(ShotAssetPin)
      .min(1)
      .describe('One pin per placed instance. A shot with nothing placed cannot be compiled.'),
  })
  .superRefine((compilation, ctx) => {
    const seen = new Set<string>();
    compilation.pins.forEach((pin, index) => {
      if (seen.has(pin.instance)) {
        ctx.addIssue({
          code: 'custom',
          path: ['pins', index, 'instance'],
          message: `${pin.instance} is pinned twice`,
        });
      }
      seen.add(pin.instance);
    });
  });
export type ShotCompilation = z.infer<typeof ShotCompilation>;
