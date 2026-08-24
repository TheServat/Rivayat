/**
 * S8: a shot list becomes one `AnimationIR`.
 *
 * The stage the whole animation half of the pipeline hangs off, and the one place
 * where the two documents that describe a film meet. A `Shot` is *authoring*: bands of
 * placed assets, a camera intent, clips named by name, lines of dialogue. An
 * `AnimationIR` is *evaluation*: flat nodes, tracks, behaviours and a camera track,
 * seekable at any instant with no memory of the instant before. Everything below is
 * one of those translations.
 *
 * ## Why this file authors nothing directly
 *
 * Every track and every behaviour it produces goes through a `MotionProvider`
 * (ADR-0008 §1). That is not ceremony: providers *author* motion and the IR *is* the
 * authored motion, so the moment a choreographer starts writing `Track` literals of its
 * own there are two things producing motion and only one of them derives its ids and
 * its seeds from what was asked for. Going through the registry is what makes the same
 * shot list compile to the same document byte for byte - RV-145's last acceptance
 * criterion, and CLAUDE.md #1's whole point.
 *
 * ## The four translations, and the decision inside each
 *
 * **Shots become a timeline.** Shots are concatenated in order; a shot's nodes hang off
 * one group whose `opacity` track is *stepped*, so a cut is a discontinuity rather than
 * a fast fade. One group per shot rather than a window per placed asset means a cut is
 * one track instead of one per instance.
 *
 * **Bands and parallax become one number.** `story/shot.ts` states exactly what that
 * costs: a shot separates *what paints over what* (`ShotLayer.z`) from *how fast a
 * thing travels* (`ParallaxDepth`), `AnimNode.depth` is one field serving both, and the
 * two count in opposite directions. `parallaxContradictsPaintOrder` is called first, as
 * its docstring asks - and its answer is read in two halves, because it reports two
 * different things. A *tie* (two bands at the same parallax depth) is not a
 * contradiction, it is an author who said nothing about relative travel: the nodes are
 * emitted back-to-front and the renderer's stable sort keeps them that way. An
 * *inversion* - a nearer band that travels less than a farther one - is a real
 * contradiction, and it is refused with both instance names rather than compiled into a
 * scene that paints the wrong way round with nothing to say why.
 *
 * **Blocking becomes nodes, not clip changes.** An `AssetInstanceNode` names one clip
 * for the whole timeline, and a shot plays a sequence of them on one instance. So an
 * instance compiles to one node *per performance* - rest, walk, rest - each visible for
 * its own window, which is also what makes `blendMs` expressible at all: a cross-fade
 * is two overlapping opacity ramps and nothing else. Two clips overlapping on one
 * instance is refused, because a character cannot do two things at once and the
 * alternative is choosing one silently.
 *
 * **Clip names become bindings.** With a rig and a library in scope every name is
 * resolved through `resolveClip`: the asset's own clip always wins, a library clip is
 * retargeted onto this rig with `retargetClip`, and a name that resolves to nothing
 * fails the stage. That is the acceptance criterion "every referenced clip exists on
 * the referenced asset", and it is the production economics of a series - a walk cycle
 * authored once and rescaled onto every compatible biped rather than authored forty
 * times. Without a rig the name is carried through unresolved and the check belongs to
 * whoever bakes it; the binding says which of the two happened, so nobody has to guess.
 *
 * ## What it deliberately does not do
 *
 * The IR carries **one** camera track and **one** focus node, so a per-shot subject
 * cannot live in it. That is not a gap in the IR - a focus target is a property of a
 * *shot* and the IR has no shots - so it goes into the `Choreography` record beside the
 * composition, which is what S11 reads to solve a crop per shot.
 */

import {
  AnimationIR,
  irDepthFor,
  parallaxContradictsPaintOrder,
  type AnimationId,
  type Behaviour,
  type BehaviourPlan,
  type CameraKeyframe,
  type CameraMove,
  type Easing,
  type Keyframe,
  type KeyframeCurve,
  type Marker,
  type MarkerId,
  type MotionStyle,
  type NodeId,
  type PhonemeTiming,
  type Shot,
  type ShotAction,
  type ShotFraming,
  type Size,
  type Track,
  type Vec2,
} from '@rv/contracts';
import {
  deriveId,
  deriveSeed,
  resolveClip,
  retargetClip,
  type MotionProviderRegistry,
} from '@rv/anim-engine';
import {
  ValidationError,
  at,
  contentHash,
  createRng,
  err,
  isErr,
  ok,
  type AppError,
  type Result,
} from '@rv/shared-kernel';

import type {
  AmbientAssignment,
  AmbientBehaviourKind,
  InstanceRig,
  LibraryClip,
  SpeakerBinding,
  VariantBinding,
} from './choreograph-stage.contracts';
import type { ClipBinding, ShotTimeline } from './choreography.contracts';

// ── the camera grammar, as data ─────────────────────────────────────────────

/**
 * What each declared move does to the camera, as fractions of the composition.
 *
 * A `Record` over the union rather than a `switch`, so a seventeenth move is a compile
 * error here instead of a move that silently reads as `static` (CLAUDE.md §2).
 *
 * The numbers are a house style rather than physics, and two rows are deliberately
 * imprecise about it:
 *
 *  - **A pan and a truck differ only in amplitude.** In a real camera one rotates and
 *    one translates, and the difference reads as parallax. Here the camera is a 2D
 *    transform over layers whose travel is already divided by their own depth, so the
 *    honest 2D reading of both is "the frame moves sideways", and a truck moves it
 *    further because a truck is the bigger gesture.
 *  - **`rack-focus` does nothing.** It is a lens move and nothing in the renderer has a
 *    lens. Compiling it as a zoom would invent a move the director did not ask for;
 *    leaving it still is the picture a still camera gives, which is what a rack focus
 *    is until there is depth of field to rack.
 */
export interface CameraMoveShape {
  /** Travel across the shot, as a fraction of the composition width. */
  readonly panX: number;
  readonly panY: number;
  /** Positive zooms in over the shot, negative zooms out. */
  readonly zoom: number;
  /** Degrees of roll, applied only where the style bible allows roll. */
  readonly roll: number;
  /** Non-zero for a camera that is held rather than mounted. */
  readonly jitterHz: number;
}

const NO_MOVE: CameraMoveShape = { panX: 0, panY: 0, zoom: 0, roll: 0, jitterHz: 0 };

export const CAMERA_MOVE_SHAPES: Readonly<Record<CameraMove, CameraMoveShape>> = {
  static: NO_MOVE,
  'pan-left': { ...NO_MOVE, panX: -0.12 },
  'pan-right': { ...NO_MOVE, panX: 0.12 },
  'tilt-up': { ...NO_MOVE, panY: -0.1 },
  'tilt-down': { ...NO_MOVE, panY: 0.1 },
  'dolly-in': { ...NO_MOVE, zoom: 0.18 },
  'dolly-out': { ...NO_MOVE, zoom: -0.18 },
  'truck-left': { ...NO_MOVE, panX: -0.22 },
  'truck-right': { ...NO_MOVE, panX: 0.22 },
  'crane-up': { ...NO_MOVE, panY: -0.2 },
  'crane-down': { ...NO_MOVE, panY: 0.2 },
  'zoom-in': { ...NO_MOVE, zoom: 0.25 },
  'zoom-out': { ...NO_MOVE, zoom: -0.25 },
  handheld: { ...NO_MOVE, jitterHz: 6 },
  'whip-pan': { ...NO_MOVE, panX: 0.55 },
  'rack-focus': NO_MOVE,
};

/**
 * How close the master framing sits to the subject, as a zoom.
 *
 * The other half of the camera intent, and the half that does the most visible work: a
 * `close` shot is a camera on the subject at 1.6x, not a wide shot with a note
 * attached. Composed *with* the move rather than replacing it, so a close-up can pan.
 */
export const FRAMING_ZOOM: Readonly<Record<ShotFraming, number>> = {
  establishing: 0.9,
  wide: 1,
  medium: 1.25,
  close: 1.6,
  'extreme-close': 2.2,
  // An insert has no spatial relationship to the rest of the scene, so it is framed as
  // tightly as a close-up and nothing is implied about where it is.
  insert: 1.8,
};

/** `CameraKeyframe.zoom` bounds, honoured here so a framing cannot fail validation. */
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 20;

/** Handheld travel as a fraction of the composition, scaled by the bible's shake. */
const HANDHELD_TRAVEL = 0.02;

/** A hold: the value does not move until the next keyframe, then jumps. A cut. */
const CUT: Easing = { kind: 'stepped', at: 'end', steps: 1 };
/** `linear` is in `DEFAULT_EASINGS`, so a ramp resolves with or without a bible. */
const RAMP: Easing = { kind: 'named', name: 'linear' };

/**
 * The two values a visibility track carries, and why they are not 1 and 0.
 *
 * `evaluate` folds the `opacity` channel as a **multiplier offset** -
 * `opacity = authored * (1 + delta)` - for the reason its own comment gives: "half as
 * bright composes and minus 0.5 alpha does not". So `0` means "exactly as authored" and
 * `-1` means "off", and a track of 1 would mean *twice* as bright, clamped.
 *
 * The payoff is that a shot window preserves the placement's own opacity: a ghost
 * placed at 0.4 is a ghost at 0.4 while its shot is on screen, rather than being
 * forced to 1 by the machinery that decides *when* it is on screen.
 */
const AS_AUTHORED = 0;
const OFF = -1;

// ── input and output ────────────────────────────────────────────────────────

export interface ChoreographInput {
  readonly shots: readonly Shot[];
  readonly fps: number;
  /** The run's seed. Every derived seed in the document descends from it. */
  readonly seed: number;
  readonly name: string;
  readonly motion?: MotionStyle | undefined;
  readonly ambient: readonly AmbientAssignment[];
  readonly speakers: readonly SpeakerBinding[];
  readonly rigs: readonly InstanceRig[];
  readonly library: readonly LibraryClip[];
  readonly variants: readonly VariantBinding[];
}

/** A library clip rescaled for one instance's skeleton, ready to be stored. */
export interface RetargetedFragment {
  readonly instance: string;
  readonly clip: string;
  readonly ir: AnimationIR;
}

export interface ChoreographOutput {
  readonly ir: AnimationIR;
  /** Per shot: when it is, and what it is about. Filed beside the composition. */
  readonly shots: readonly ShotTimeline[];
  readonly bindings: readonly ClipBinding[];
  readonly fragments: readonly RetargetedFragment[];
}

/** One performance of one instance, or the stretch between two of them. */
interface Segment {
  readonly startMs: number;
  readonly endMs: number;
  readonly action: ShotAction | null;
  /** Cross-fade *into* this segment. Zero for the first, which cuts in with the shot. */
  readonly blendMs: number;
}

/** A behaviour request before it is handed to a provider. */
interface PlanRequest {
  readonly key: string;
  readonly nodeIds: readonly NodeId[];
  readonly plans: readonly BehaviourPlan[];
}

export class ChoreographShotsUseCase {
  readonly #motion: MotionProviderRegistry;

  constructor(motion: MotionProviderRegistry) {
    this.#motion = motion;
  }

  async execute(input: ChoreographInput): Promise<Result<ChoreographOutput, AppError>> {
    const first = input.shots[0];
    if (first === undefined) {
      return err(new ValidationError({ message: 'a composition needs at least one shot' }));
    }

    const scene = first.sceneSpace.size;
    const canvas = sameCanvas(input.shots, scene);
    if (isErr(canvas)) return canvas;

    // Everything derived below hangs off this, so the same request compiles to the same
    // ids, the same document and therefore the same content address. Two runs of one
    // cut share a render rather than drawing it twice.
    const key = requestKey(input);

    const variantKeys = new Map(input.variants.map((binding) => [binding.id, binding.key]));
    const rigs = new Map(input.rigs.map((entry) => [entry.instance, entry]));
    const ambient = new Map(input.ambient.map((entry) => [entry.instance, entry.kinds]));
    const speakers = new Map(input.speakers.map((entry) => [entry.entity, entry.instance]));

    const nodes: Record<string, unknown>[] = [];
    const markers: Marker[] = [];
    const cameraKeys: CameraKeyframe[] = [];
    const curves: KeyframeCurve[] = [];
    const timelines: ShotTimeline[] = [];
    const bindings: ClipBinding[] = [];
    const fragments: RetargetedFragment[] = [];
    const instanceNodes: NodeId[] = [];
    const ambientNodes = new Map<AmbientBehaviourKind, NodeId[]>();
    const lipSync: PlanRequest[] = [];

    let startMs = 0;
    for (const [shotIndex, shot] of input.shots.entries()) {
      const ordering = reconcileDepths(shot);
      if (isErr(ordering)) return ordering;

      const groupId = deriveId<NodeId>('nod', `${key}:group:${shot.id}`);
      nodes.push({
        kind: 'group',
        id: groupId,
        name: `shot-${String(shotIndex)}`,
        parentId: null,
        depth: 0,
      });

      // More than one shot means cuts, and a cut is a stepped edge on the group. One
      // shot needs no track at all: a composition that is one shot is always visible,
      // and a synthetic track would be noise in the document.
      if (input.shots.length > 1) {
        curves.push({
          nodeId: groupId,
          channel: 'opacity',
          keys: shotWindowKeys(startMs, startMs + shot.durationMs),
          before: 'hold',
          after: 'hold',
          additive: false,
        });
      }

      let focusNodeId: NodeId | null = null;
      const nodesByInstance = new Map<string, NodeId[]>();

      // Back to front. The renderer breaks depth ties by authored order, so emitting in
      // band order is what makes two bands at one parallax depth paint correctly.
      const bands = [...shot.layout].sort((left, right) => left.z - right.z);
      for (const band of bands) {
        for (const instance of band.instances) {
          const variantKey =
            instance.variantId === undefined ? undefined : variantKeys.get(instance.variantId);
          if (instance.variantId !== undefined && variantKey === undefined) {
            return err(
              new ValidationError({
                message:
                  `${instance.instance} is placed with variant ${instance.variantId}, which no ` +
                  'binding names: a shot addresses a variant by id and an IR node by key',
                context: {
                  shot: shot.id,
                  instance: instance.instance,
                  variantId: instance.variantId,
                },
              }),
            );
          }

          const segments = segmentsFor(shot, instance.instance);
          if (isErr(segments)) return segments;

          const nodeIds: NodeId[] = [];
          for (const [index, segment] of segments.value.entries()) {
            const nodeId = deriveId<NodeId>(
              'nod',
              `${key}:${shot.id}:${instance.instance}:${String(index)}`,
            );
            nodeIds.push(nodeId);

            const bound = this.#bindClip(segment.action, instance.instance, rigs, input.library);
            if (isErr(bound)) return bound;
            if (bound.value !== null) {
              bindings.push(bound.value.binding);
              if (bound.value.fragment !== null) fragments.push(bound.value.fragment);
            }

            nodes.push({
              kind: 'asset-instance',
              id: nodeId,
              name: segmentName(shotIndex, instance.instance, index, segments.value.length),
              parentId: groupId,
              transform: {
                ...instance.transform,
                ...(instance.opacity === undefined ? {} : { opacity: instance.opacity }),
              },
              depth: irDepthFor(instance.depth),
              asset: {
                assetId: instance.assetId,
                versionId: instance.assetVersionId,
                ...(variantKey === undefined ? {} : { variantKey }),
              },
              ...(segment.action === null
                ? {}
                : {
                    clipName: segment.action.clip,
                    clipLoop: segment.action.loop,
                    clipSpeed: segment.action.speed,
                  }),
              ...(instance.tint === undefined ? {} : { tint: instance.tint }),
            });

            if (segments.value.length > 1) {
              curves.push({
                nodeId,
                channel: 'opacity',
                keys: segmentKeys(startMs, segment, segments.value[index + 1] ?? null),
                before: 'hold',
                after: 'hold',
                additive: false,
              });
            }
          }

          nodesByInstance.set(instance.instance, nodeIds);
          instanceNodes.push(...nodeIds);
          for (const kind of ambient.get(instance.instance) ?? []) {
            const bucket = ambientNodes.get(kind);
            if (bucket === undefined) ambientNodes.set(kind, [...nodeIds]);
            else bucket.push(...nodeIds);
          }

          if (shot.focusTarget.instance === instance.instance) focusNodeId = nodeIds[0] ?? null;
        }
      }

      cameraKeys.push(...cameraFor(shot, startMs, scene, input.seed, input.motion));
      markers.push(...markersFor(shot, shotIndex, startMs, key));

      for (const [lineIndex, line] of shot.dialogue.entries()) {
        // A line with no phonemes has nothing to drive a mouth with. `DialogueLine`
        // says so itself - "empty until the audio exists" - so this is a stage that has
        // not run yet rather than a line that does not speak, and the marker stands.
        if (line.phonemes.length === 0) continue;
        const speaker = speakers.get(line.speakerRef);
        const nodeIds = speaker === undefined ? undefined : nodesByInstance.get(speaker);
        if (nodeIds === undefined || nodeIds.length === 0) continue;
        const plan = lipSyncPlan(line.phonemes, startMs + line.startMs);
        if (isErr(plan)) return plan;
        lipSync.push({
          key: `lip-sync-${String(shotIndex)}-${String(lineIndex)}`,
          nodeIds,
          plans: [plan.value],
        });
      }

      timelines.push({
        shotId: shot.id,
        startMs,
        durationMs: shot.durationMs,
        focusNodeId,
        focusRegion: shot.focusTarget.region,
        safeArea: shot.safeArea,
        overrides: shot.sceneSpace.overrides,
      });

      startMs += shot.durationMs;
    }

    const tracks = await this.#tracks(curves);
    if (isErr(tracks)) return tracks;

    const behaviours = await this.#behaviours({
      seed: input.seed,
      motion: input.motion,
      instanceNodes,
      ambientNodes,
      lipSync,
    });
    if (isErr(behaviours)) return behaviours;

    const focus = timelines[0]?.focusNodeId ?? null;
    const draft = {
      irVersion: 1,
      id: deriveId<AnimationId>('anm', key),
      name: input.name,
      fps: input.fps,
      durationMs: startMs,
      sceneSpace: scene,
      seed: input.seed,
      nodes,
      tracks: tracks.value,
      behaviours: behaviours.value,
      markers,
      camera: {
        keyframes: cameraKeys,
        // The IR has one focus node and a film has one per shot, so this is the first
        // shot's - a default for anything that reads the IR alone. The per-shot answer
        // is in the `Choreography` record, which is what the reframer actually uses.
        ...(focus === null ? {} : { focusNodeId: focus }),
      },
    };

    // Parsed, not asserted. The IR's own refinements - a dangling parent, a cycle, a
    // track on a node that is not there - are this compiler's own bugs, and a document
    // that fails them must never reach a renderer that would draw *most* of it.
    const ir = AnimationIR.safeParse(draft);
    if (!ir.success) {
      return err(
        new ValidationError({
          message: 'the shots compiled to a document the IR schema refuses',
          context: {
            issues: ir.error.issues
              .slice(0, 8)
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          },
        }),
      );
    }

    return ok({ ir: ir.data, shots: timelines, bindings, fragments });
  }

  /** Visibility curves through the keyframe provider, which is what makes them legal. */
  async #tracks(curves: readonly KeyframeCurve[]): Promise<Result<Track[], AppError>> {
    if (curves.length === 0) return ok([]);
    const authored = await this.#motion.author({
      key: 'visibility',
      kind: 'keyframe',
      curves: [...curves],
    });
    return isErr(authored) ? authored : ok([...authored.value.tracks]);
  }

  /**
   * Ambient life, parallax and lip-sync, all through the procedural provider.
   *
   * Nothing here invents a seed. `ProceduralMotionProvider` derives every behaviour's
   * seed from the request's root seed, the request key and the node, which is what the
   * IR's own docstring asks for - "derive it from the node id, never at random" - and
   * what makes forty trees gust differently while the whole run still replays.
   */
  async #behaviours(input: {
    readonly seed: number;
    readonly motion: MotionStyle | undefined;
    readonly instanceNodes: readonly NodeId[];
    readonly ambientNodes: ReadonlyMap<AmbientBehaviourKind, readonly NodeId[]>;
    readonly lipSync: readonly PlanRequest[];
  }): Promise<Result<Behaviour[], AppError>> {
    const requests: PlanRequest[] = [];
    const motion = input.motion;

    if (motion !== undefined && input.instanceNodes.length > 0) {
      if (motion.camera.parallaxStrength > 0) {
        // The behaviour ADR-0008 called out as "already exists and has nothing to
        // consume". A placed instance carries a parallax depth; this is what reads it.
        requests.push({
          key: 'parallax',
          nodeIds: input.instanceNodes,
          plans: [
            {
              kind: 'parallax',
              enabled: true,
              weight: 1,
              strength: motion.camera.parallaxStrength,
              curve: motion.camera.parallaxCurve,
            },
          ],
        });
      }

      if (motion.boil.enabled) {
        // Boil is a property of the drawing rather than of the subject: every hand
        // redrawn line jitters, so it goes on everything the style says it goes on.
        requests.push({
          key: 'boil',
          nodeIds: input.instanceNodes,
          plans: [ambientPlans.boil(motion)],
        });
      }
    }

    for (const [kind, nodeIds] of input.ambientNodes) {
      if (nodeIds.length === 0 || motion === undefined) continue;
      requests.push({ key: `ambient-${kind}`, nodeIds, plans: [ambientPlans[kind](motion)] });
    }

    requests.push(...input.lipSync);

    const behaviours: Behaviour[] = [];
    for (const request of requests) {
      const authored = await this.#motion.author({
        key: request.key,
        kind: 'procedural',
        seed: input.seed,
        nodeIds: [...request.nodeIds],
        plans: [...request.plans],
      });
      if (isErr(authored)) return authored;
      behaviours.push(...authored.value.behaviours);
    }

    return ok(behaviours);
  }

  /**
   * The clip a blocking action names, and where it came from.
   *
   * `null` for a segment that is not a performance. The asset's own clip wins by
   * construction (`resolveClip`), so promoting a clip into the library can never change
   * what an already-produced asset plays.
   */
  #bindClip(
    action: ShotAction | null,
    instance: string,
    rigs: ReadonlyMap<string, InstanceRig>,
    library: readonly LibraryClip[],
  ): Result<{ binding: ClipBinding; fragment: RetargetedFragment | null } | null, AppError> {
    if (action === null) return ok(null);

    const rig = rigs.get(instance);
    if (rig === undefined) {
      // No skeleton in scope, so nothing here can check the name. Recorded as coming
      // from the asset rather than checked: the difference matters to whoever bakes it,
      // and claiming to have checked would be worse than saying we could not.
      return ok({
        binding: { instance, clip: action.clip, origin: 'asset', fragmentId: null },
        fragment: null,
      });
    }

    const resolution = resolveClip({
      name: action.clip,
      rig: rig.rig,
      assetClips: rig.clips,
      library: library.map((clip) => clip.entry),
    });
    if (isErr(resolution)) return resolution;

    if (resolution.value.origin === 'asset') {
      return ok({
        binding: { instance, clip: action.clip, origin: 'asset', fragmentId: null },
        fragment: null,
      });
    }

    const entry = resolution.value.entry;
    const source = library.find((clip) => clip.entry.id === entry.id);
    if (source === undefined) {
      return err(
        new ValidationError({
          message: `the library entry for ${action.clip} arrived without its motion fragment`,
          context: { instance, clip: action.clip, clipId: entry.id },
        }),
      );
    }

    // Angles carry over, lengths are rescaled. Retargeting onto identical proportions
    // is the identity, so a clip authored on this rig's twin costs nothing, and one
    // authored on a taller rig stops this one's feet skating.
    const retargeted = retargetClip(
      source.fragment,
      resolution.value.source,
      resolution.value.target,
    );
    if (isErr(retargeted)) return retargeted;

    return ok({
      binding: {
        instance,
        clip: action.clip,
        origin: 'library',
        fragmentId: contentHash(retargeted.value),
      },
      fragment: { instance, clip: action.clip, ir: retargeted.value },
    });
  }
}

// ── translations ────────────────────────────────────────────────────────────

/**
 * One ambient behaviour, with the bible's own amplitudes.
 *
 * A table over the kinds rather than a `switch`, so the four the payload can ask for
 * and the four that can be built are the same four by construction.
 */
const ambientPlans: Readonly<Record<AmbientBehaviourKind, (motion: MotionStyle) => BehaviourPlan>> =
  {
    wind: (motion) => ({
      kind: 'wind',
      enabled: true,
      weight: 1,
      hz: motion.ambient.windHz,
      amplitude: motion.ambient.windAmplitude,
      gustiness: motion.ambient.windGustiness,
      direction: 0,
      tipBias: 0.7,
    }),
    breathe: (motion) => ({
      kind: 'breathe',
      enabled: true,
      weight: 1,
      hz: motion.ambient.breathHz,
      amplitude: motion.ambient.idleAmplitude,
    }),
    blink: (motion) => ({
      kind: 'blink',
      enabled: true,
      weight: 1,
      intervalMs: motion.ambient.blinkIntervalMs,
      varianceMs: motion.ambient.blinkVarianceMs,
      closeDurationMs: 110,
    }),
    boil: (motion) => ({
      kind: 'boil',
      enabled: true,
      weight: 1,
      amplitude: motion.boil.amplitude,
      hz: motion.boil.hz,
    }),
  };

/** Every shot has to be composed on one canvas, or there is no composition. */
function sameCanvas(shots: readonly Shot[], scene: Size): Result<void, AppError> {
  for (const shot of shots) {
    if (
      shot.sceneSpace.size.width === scene.width &&
      shot.sceneSpace.size.height === scene.height
    ) {
      continue;
    }
    return err(
      new ValidationError({
        message:
          `shot ${shot.id} is composed on ${String(shot.sceneSpace.size.width)}x` +
          `${String(shot.sceneSpace.size.height)} and the composition is ` +
          `${String(scene.width)}x${String(scene.height)}; one timeline has one canvas`,
        context: { shot: shot.id, expected: scene, actual: shot.sceneSpace.size },
      }),
    );
  }
  return ok(undefined);
}

/**
 * Paint order against parallax order, as `story/shot.ts` asks a compiler to check.
 *
 * Ties are resolvable and inversions are not - see the file header. The pairs are named
 * because "this shot cannot be compiled" without them is a message that costs an hour.
 */
function reconcileDepths(shot: Shot): Result<void, AppError> {
  const reported = parallaxContradictsPaintOrder(shot.layout);
  if (reported.length === 0) return ok(undefined);

  const depthOf = new Map<string, number>();
  for (const band of shot.layout) {
    for (const instance of band.instances) depthOf.set(instance.instance, instance.depth);
  }

  const inversions = reported.filter((pair) => {
    const nearer = depthOf.get(pair.nearer);
    const farther = depthOf.get(pair.farther);
    return nearer !== undefined && farther !== undefined && nearer > farther;
  });
  const worst = inversions[0];
  if (worst === undefined) return ok(undefined);

  return err(
    new ValidationError({
      message:
        `shot ${shot.id} paints ${worst.nearer} in front of ${worst.farther} and gives it the ` +
        'greater parallax depth; one node depth cannot both paint over and travel less',
      context: { shot: shot.id, inversions },
    }),
  );
}

/** A stepped window: invisible, visible for the shot, invisible again. */
function shotWindowKeys(startMs: number, endMs: number): Keyframe[] {
  const keys: Keyframe[] = [];
  if (startMs > 0) keys.push({ timeMs: 0, value: OFF, easing: CUT });
  keys.push({ timeMs: startMs, value: AS_AUTHORED, easing: CUT });
  keys.push({ timeMs: endMs, value: OFF, easing: CUT });
  return keys;
}

/**
 * One segment's visibility, including the cross-fades at both ends.
 *
 * A blend is a ramp on *this* node and the mirror ramp on its neighbour, which is what
 * makes `ShotAction.blendMs` - "a non-zero blend is what stops a pose change from
 * popping" - something the document expresses rather than a note nobody can act on.
 */
function segmentKeys(shotStartMs: number, segment: Segment, next: Segment | null): Keyframe[] {
  const start = shotStartMs + segment.startMs;
  const end = shotStartMs + segment.endMs;
  const keys: Keyframe[] = [];

  if (segment.blendMs > 0) {
    keys.push({ timeMs: start, value: OFF, easing: RAMP });
    keys.push({ timeMs: start + segment.blendMs, value: AS_AUTHORED, easing: CUT });
  } else {
    if (segment.startMs > 0) keys.push({ timeMs: start - 1, value: OFF, easing: CUT });
    keys.push({ timeMs: start, value: AS_AUTHORED, easing: CUT });
  }

  const blendOut = next?.blendMs ?? 0;
  if (blendOut > 0) {
    keys.push({ timeMs: end, value: AS_AUTHORED, easing: RAMP });
    keys.push({ timeMs: end + blendOut, value: OFF, easing: CUT });
  } else {
    keys.push({ timeMs: end, value: OFF, easing: CUT });
  }

  return keys;
}

/**
 * One instance's performances across a shot, in order, with the gaps filled.
 *
 * Overlapping actions on one instance are refused rather than layered: two clips on one
 * character at one instant is two poses, and a compiler that picked one would be making
 * a directing decision with no way to say it had.
 */
function segmentsFor(shot: Shot, instance: string): Result<Segment[], AppError> {
  const actions = shot.blocking
    .filter((action) => action.instance === instance)
    .sort((left, right) => left.startMs - right.startMs);

  const segments: Segment[] = [];
  let cursor = 0;

  for (const action of actions) {
    if (action.startMs >= shot.durationMs) {
      return err(
        new ValidationError({
          message:
            `${instance} plays ${action.clip} from ${String(action.startMs)}ms in a shot that ` +
            `is ${String(shot.durationMs)}ms long, so it never plays`,
          context: { shot: shot.id, instance, clip: action.clip },
        }),
      );
    }
    if (action.startMs < cursor) {
      return err(
        new ValidationError({
          message: `${instance} is asked to play ${action.clip} while another clip is still running`,
          context: { shot: shot.id, instance, clip: action.clip, freeFromMs: cursor },
        }),
      );
    }

    if (action.startMs > cursor) {
      segments.push({ startMs: cursor, endMs: action.startMs, action: null, blendMs: 0 });
    }

    const end = Math.min(action.startMs + action.durationMs, shot.durationMs);
    segments.push({
      startMs: action.startMs,
      endMs: end,
      action,
      blendMs: blendFor(action.blendMs, end - action.startMs, segments[segments.length - 1]),
    });
    cursor = end;
  }

  if (segments.length === 0 || cursor < shot.durationMs) {
    segments.push({ startMs: cursor, endMs: shot.durationMs, action: null, blendMs: 0 });
  }
  return ok(segments);
}

/**
 * A blend that fits inside both clips it joins.
 *
 * Half of the shorter of the two at most: a cross-fade longer than the clip is not a
 * cross-fade, it is a dissolve with nothing under it - and it would also put two
 * keyframes on one instant, which `Track` refuses.
 */
function blendFor(requested: number, length: number, previous: Segment | undefined): number {
  if (previous === undefined || requested <= 0) return 0;
  const room = Math.min(
    Math.floor(length / 2),
    Math.floor((previous.endMs - previous.startMs) / 2),
  );
  return Math.max(0, Math.min(requested, room));
}

/** `shot-index-instance`, kept a slug because `AnimNode.name` is one. */
function segmentName(shotIndex: number, instance: string, index: number, total: number): string {
  const base = `${String(shotIndex)}-${instance}`;
  return total > 1 ? `${base}-${String(index)}` : base;
}

/** The camera keyframes one shot contributes, from its framing and its declared move. */
function cameraFor(
  shot: Shot,
  startMs: number,
  scene: Size,
  seed: number,
  motion: MotionStyle | undefined,
): CameraKeyframe[] {
  const shape = CAMERA_MOVE_SHAPES[shot.camera.move];
  const grammar = motion?.camera;
  const allowZoom = grammar?.allowZoom ?? true;
  const allowRoll = grammar?.allowRoll ?? false;

  // Scene space has its origin at the centre of the canvas - the renderer's convention,
  // fixed in `frames/draw-list.ts` - so a normalised region maps to it by subtracting a
  // half. A camera on the subject is what makes a close-up a close-up.
  const region = shot.camera.focusTarget.region;
  const base: Vec2 = {
    x: (region.x + region.width / 2 - 0.5) * scene.width,
    y: (region.y + region.height / 2 - 0.5) * scene.height,
  };
  const framing = allowZoom ? FRAMING_ZOOM[shot.camera.framing] : 1;
  const travel = allowZoom ? shape.zoom : 0;
  const roll = allowRoll ? shape.roll : 0;

  // The move is centred on the framing the composer saw: half of it before, half after,
  // so the middle of the shot is the frame they actually composed.
  const from = {
    position: {
      x: base.x - (shape.panX * scene.width) / 2,
      y: base.y - (shape.panY * scene.height) / 2,
    },
    zoom: clampZoom(framing * (travel >= 0 ? 1 : 1 - travel)),
    rotation: -roll / 2,
  };
  const to = {
    position: {
      x: base.x + (shape.panX * scene.width) / 2,
      y: base.y + (shape.panY * scene.height) / 2,
    },
    zoom: clampZoom(framing * (travel >= 0 ? 1 + travel : 1)),
    rotation: roll / 2,
  };

  // A shot too short to hold a pair of keyframes is a still camera rather than a
  // degenerate tween.
  if (shot.durationMs < 2) return [{ timeMs: startMs, ...from, easing: CUT }];

  const endMs = startMs + shot.durationMs;
  if (shape.jitterHz > 0) {
    return handheldKeys({
      startMs,
      endMs,
      from,
      to,
      hz: shape.jitterHz,
      scene,
      seed,
      shotId: shot.id,
      shake: grammar?.shakeAmplitude ?? 0.05,
    });
  }

  // The outgoing keyframe sits one millisecond before the cut and holds, so the next
  // shot's first keyframe is a jump rather than a tween across the cut.
  return [
    { timeMs: startMs, ...from, easing: grammar === undefined ? RAMP : namedEase(grammar.panEase) },
    { timeMs: endMs - 1, ...to, easing: CUT },
  ];
}

function namedEase(name: string): Easing {
  return { kind: 'named', name };
}

/**
 * A camera somebody is holding.
 *
 * Seeded from the shot, never from a clock: the same shot shakes the same way on every
 * machine and on every re-render, which is the only kind of handheld a bit-reproducible
 * renderer can have.
 */
function handheldKeys(input: {
  readonly startMs: number;
  readonly endMs: number;
  readonly from: { readonly position: Vec2; readonly zoom: number; readonly rotation: number };
  readonly to: { readonly position: Vec2; readonly zoom: number; readonly rotation: number };
  readonly hz: number;
  readonly scene: Size;
  readonly seed: number;
  readonly shotId: string;
  readonly shake: number;
}): CameraKeyframe[] {
  const rng = createRng(deriveSeed([input.seed, 'handheld', input.shotId]));
  const amplitude = input.shake * HANDHELD_TRAVEL;
  const step = Math.max(1, Math.round(1000 / input.hz));
  const span = input.endMs - 1 - input.startMs;

  const keys: CameraKeyframe[] = [];
  for (let offset = 0; offset < span; offset += step) {
    const progress = span === 0 ? 0 : offset / span;
    keys.push({
      timeMs: input.startMs + offset,
      position: {
        x:
          lerp(input.from.position.x, input.to.position.x, progress) +
          rng.float(-1, 1) * amplitude * input.scene.width,
        y:
          lerp(input.from.position.y, input.to.position.y, progress) +
          rng.float(-1, 1) * amplitude * input.scene.height,
      },
      zoom: clampZoom(lerp(input.from.zoom, input.to.zoom, progress)),
      rotation: lerp(input.from.rotation, input.to.rotation, progress),
      easing: RAMP,
    });
  }
  keys.push({ timeMs: input.endMs - 1, ...input.to, easing: CUT });
  return keys;
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * The markers a shot contributes.
 *
 * A `cut` at every shot boundary including the first, a `beat` naming the beat the shot
 * carries, and one marker per line, effect and score change. They are the IR's only
 * record of *why* the timeline is shaped the way it is, and the timeline UI is not the
 * only consumer: a re-cut compares beats.
 */
function markersFor(shot: Shot, shotIndex: number, startMs: number, key: string): Marker[] {
  const markers: Marker[] = [
    {
      id: deriveId<MarkerId>('mrk', `${key}:cut:${shot.id}`),
      timeMs: startMs,
      kind: 'cut',
      label: `shot ${String(shotIndex)}`,
    },
    {
      id: deriveId<MarkerId>('mrk', `${key}:beat:${shot.id}`),
      timeMs: startMs,
      kind: 'beat',
      label: shot.beatRef,
    },
  ];

  for (const [index, line] of shot.dialogue.entries()) {
    markers.push({
      id: deriveId<MarkerId>('mrk', `${key}:line:${shot.id}:${String(index)}`),
      timeMs: startMs + line.startMs,
      kind: 'dialogue',
      label: shorten(line.text),
    });
  }

  for (const [index, cue] of shot.audio.sfx.entries()) {
    markers.push({
      id: deriveId<MarkerId>('mrk', `${key}:sfx:${shot.id}:${String(index)}`),
      timeMs: startMs + cue.startMs,
      kind: 'sfx',
      label: cue.key,
    });
  }

  const music = shot.audio.music;
  // "continue" means the previous cue simply carries on, so there is nothing to mark: a
  // marker per shot for music that did not change is noise on the timeline.
  if (music !== null && music.action !== 'continue') {
    markers.push({
      id: deriveId<MarkerId>('mrk', `${key}:music:${shot.id}`),
      timeMs: startMs,
      kind: 'music',
      label: `${music.action} ${music.key}`,
    });
  }

  return markers;
}

/** `Label` is 120 characters, and a line of dialogue is not. */
function shorten(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117)}...`;
}

/**
 * The phoneme timeline, moved onto the composition's clock and into its vocabulary.
 *
 * Three translations, all real. A `PhonemeTiming` is `(phoneme, startMs)` relative to
 * its line; `LipSyncBehaviour` wants `(viseme, timeMs)` on the composition's clock,
 * because `behaviourWeight` and the behaviour are both handed the absolute time the
 * evaluator is at. Shifting here rather than at evaluation is what keeps the behaviour
 * a pure function of `t`.
 *
 * And the symbol becomes a slug, because a viseme is looked up in the rig's mouth chart
 * and the IR spells every name that way. An aligner emits `AH1`; the chart has `ah1`. A
 * symbol that cannot be spelled as a slug at all - an IPA glyph - fails here rather than
 * silently animating nothing, because a line that was voiced and does not move its mouth
 * is the kind of defect nobody notices until the episode is watched.
 */
function lipSyncPlan(
  phonemes: readonly PhonemeTiming[],
  startMs: number,
): Result<BehaviourPlan, AppError> {
  const shifted: { timeMs: number; viseme: string; durationMs: number }[] = [];
  for (const phoneme of phonemes) {
    const viseme = toViseme(phoneme.phoneme);
    if (viseme === null) {
      return err(
        new ValidationError({
          message: `the phoneme "${phoneme.phoneme}" cannot be named as a viseme slug`,
          context: { phoneme: phoneme.phoneme },
        }),
      );
    }
    shifted.push({ timeMs: startMs + phoneme.startMs, viseme, durationMs: phoneme.durationMs });
  }

  // `phonemes.min(1)` on the behaviour, and a caller that only calls this for a
  // non-empty line: `at` states that rather than inventing a resting mouth shape.
  const last = at(shifted, shifted.length - 1, 'phoneme');
  return ok({
    kind: 'lip-sync',
    enabled: true,
    weight: 1,
    intensity: 0.8,
    phonemes: shifted,
    startMs,
    endMs: last.timeMs + last.durationMs,
  });
}

/** `AH1` to `ah1`, `T_CL` to `t-cl`, an IPA glyph to `null`. */
function toViseme(phoneme: string): string | null {
  const slug = phoneme
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' ? null : slug;
}

/**
 * The address every derived id hangs off: everything that changes the document.
 *
 * An absent field is spelled `null` because `stableStringify` drops an undefined key,
 * and two requests differing only by an absent field would otherwise share a key and
 * therefore share every id in the document.
 */
function requestKey(input: ChoreographInput): string {
  return contentHash({
    shots: input.shots,
    fps: input.fps,
    seed: input.seed,
    name: input.name,
    motion: input.motion ?? null,
    ambient: input.ambient,
    speakers: input.speakers,
    rigs: input.rigs,
    library: input.library.map((clip) => clip.entry),
    variants: input.variants,
  });
}
