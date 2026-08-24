/**
 * Motion providers: the shapes on both sides of the determinism boundary.
 *
 * ADR-0008 §1 answers the question the design document left open - where determinism
 * lives when motion can come from nine different places. The answer is that **providers
 * author motion, the IR *is* the authored motion, and evaluation is pure**. A provider
 * takes a {@link MotionRequest} and returns {@link AuthoredMotion} - tracks and
 * behaviours - which are written into an `AnimationIR` and content-hashed like
 * everything else. Whether the provider was itself deterministic then stops mattering:
 * a mocap import, a physics bake and a model proposing keyframes all produce the same
 * kind of artefact, and the artefact is what replays.
 *
 * That is what makes "a new technology arrives as a provider, not as a new
 * architecture" (§69) safe to adopt rather than merely appealing. Providers sit
 * *outside* the boundary; the IR sits *on* it.
 *
 * The corollary is the rule with teeth: **a provider may not be consulted at evaluation
 * time.** `evaluate(ir, t)` calls nothing. Three things enforce it rather than one:
 *
 *  1. `author` is asynchronous and `evaluate` is synchronous, so a provider cannot be
 *     awaited from inside the evaluator without changing the evaluator's signature -
 *     and its signature is the thing every consumer depends on.
 *  2. The request shapes below carry no notion of "at time t". A provider is asked for
 *     a whole clip's worth of motion, never for a frame.
 *  3. `@rv/anim-engine` carries a fitness test that walks the evaluator's import
 *     closure and fails if it ever reaches the provider registry.
 *
 * A provider that cannot bake is not a motion provider. AI *video* is therefore not one
 * (ADR-0008 §2): footage is frames somebody already chose, not a function of time, and
 * it enters as an asset representation the compositor draws.
 */

import { z } from 'zod';

import { NodeId } from '../primitives/ids';
import { Fps, Millis, NonNegativeInt, Slug, Unit01, Vec2 } from '../primitives/common';
import { RigSignature } from '../asset/clip-library';
import {
  AnimChannel,
  Behaviour,
  BehaviourKind,
  BlinkBehaviour,
  BoilBehaviour,
  BreatheBehaviour,
  Extrapolation,
  FlapBehaviour,
  FollowPathBehaviour,
  Keyframe,
  LipSyncBehaviour,
  LookAtBehaviour,
  OrbitBehaviour,
  ParallaxBehaviour,
  SpringBehaviour,
  SwayBehaviour,
  Track,
  WalkCycleBehaviour,
  WindBehaviour,
} from './ir';

// ── who authors motion ──────────────────────────────────────────────────────

/**
 * The sources of motion we admit, from §17's nine.
 *
 * Four, not nine, and the difference is the whole of ADR-0008's disagreement with the
 * document. Sprite animation and bone animation are not *sources*, they are how a rig
 * is drawn. Motion capture and AI pose/motion produce keyframes, so they are
 * `keyframe` providers with an unusual input, not new kinds. AI video is not motion at
 * all. What is left is four genuinely different ways of arriving at tracks and
 * behaviours.
 */
export const MotionProviderKind = z.enum([
  'keyframe',
  'procedural',
  'physics',
  'retargeted-library',
]);
export type MotionProviderKind = z.infer<typeof MotionProviderKind>;

/**
 * Why each kind exists, total over the union.
 *
 * A fifth source has to justify itself in one sentence before it can be registered,
 * which is a low bar that has nonetheless stopped "we could also just call the model"
 * from becoming an architecture.
 */
export const MOTION_PROVIDER_PURPOSE: Readonly<Record<MotionProviderKind, string>> = {
  keyframe:
    'explicit keys from an author, a timeline edit, a mocap import or a model - normalised into legal tracks',
  procedural:
    'closed-form functions of time: the cheapest motion in the system, and the only kind that costs nothing per second',
  physics:
    'simulation that is baked to keyframes before it is stored, because a solver cannot be seeked',
  'retargeted-library':
    'a clip authored on one skeleton, rescaled onto another, so a walk cycle is written once for the series',
};

// ── what a provider can serve ───────────────────────────────────────────────

/**
 * What a provider declares it can author.
 *
 * The same shape as a provider adapter's `capabilities` in `@rv/providers`, and for the
 * same reason: the router must be able to refuse a route *before* the call, and an
 * adapter that cannot serve something says so rather than failing at the far end.
 *
 * Two axes because motion has two kinds of output and providers really do differ on
 * them. A keyframe provider declares channels and no behaviours; a procedural one
 * declares behaviours and no channels; a future physics provider will declare
 * `position.x`, `position.y` and `rotation` and nothing else, and a request that asks
 * it for `lip-sync` should be routed elsewhere rather than answered badly.
 */
export const MotionCapabilities = z.object({
  channels: z.array(AnimChannel).default([]),
  behaviours: z.array(BehaviourKind).default([]),
});
export type MotionCapabilities = z.infer<typeof MotionCapabilities>;

// ── requests ────────────────────────────────────────────────────────────────

/**
 * Fields every request carries.
 *
 * `key` is the whole determinism story on the authoring side. Ids and seeds are derived
 * from it, so authoring the same request twice produces the same records rather than
 * two documents that differ only in their identifiers - which would defeat content
 * addressing and make every diff enormous.
 */
const MotionRequestBase = {
  key: Slug.describe('Stable label; ids and seeds are derived from it, never minted at random'),
  kind: MotionProviderKind,
};

/**
 * Keys as they arrive, before they are a legal track.
 *
 * Deliberately *not* a `Track`: `Track` refines its keyframes to be strictly ordered,
 * and keys arriving from a timeline drag, an LLM or a mocap import are not. Making the
 * request carry the refined shape would put the normalisation burden on every caller
 * and leave the provider with nothing to do.
 */
export const KeyframeCurve = z.object({
  nodeId: NodeId,
  channel: AnimChannel,
  keys: z.array(Keyframe).min(1),
  before: Extrapolation.default('hold'),
  after: Extrapolation.default('hold'),
  additive: z.boolean().default(false),
});
export type KeyframeCurve = z.infer<typeof KeyframeCurve>;

export const KeyframeMotionRequest = z.object({
  ...MotionRequestBase,
  kind: z.literal('keyframe'),
  curves: z.array(KeyframeCurve).min(1),
});
export type KeyframeMotionRequest = z.infer<typeof KeyframeMotionRequest>;

/**
 * A behaviour minus the identity a provider mints for it.
 *
 * `id`, `nodeId` and `seed` are removed rather than made optional. A caller supplying
 * its own seed is the failure the IR's own docstring warns about ("derive it from the
 * node id, never at random"), and an optional field is an invitation; removing it makes
 * the derivation the only path.
 */
const PLAN_OMIT = { id: true, nodeId: true, seed: true } as const;

export const BehaviourPlan = z.discriminatedUnion('kind', [
  WindBehaviour.omit(PLAN_OMIT),
  BreatheBehaviour.omit(PLAN_OMIT),
  BlinkBehaviour.omit(PLAN_OMIT),
  SwayBehaviour.omit(PLAN_OMIT),
  WalkCycleBehaviour.omit(PLAN_OMIT),
  FlapBehaviour.omit(PLAN_OMIT),
  OrbitBehaviour.omit(PLAN_OMIT),
  ParallaxBehaviour.omit(PLAN_OMIT),
  BoilBehaviour.omit(PLAN_OMIT),
  SpringBehaviour.omit(PLAN_OMIT),
  LookAtBehaviour.omit(PLAN_OMIT),
  FollowPathBehaviour.omit(PLAN_OMIT),
  LipSyncBehaviour.omit(PLAN_OMIT),
]);
export type BehaviourPlan = z.infer<typeof BehaviourPlan>;

export const ProceduralMotionRequest = z.object({
  ...MotionRequestBase,
  kind: z.literal('procedural'),
  /** Root seed. Each behaviour's own seed is derived from this, the key and the node. */
  seed: NonNegativeInt,
  /** Every plan is applied to every node, which is what makes a forest one request. */
  nodeIds: z.array(NodeId).min(1),
  plans: z.array(BehaviourPlan).min(1),
});
export type ProceduralMotionRequest = z.infer<typeof ProceduralMotionRequest>;

/**
 * One simulated body.
 *
 * Declared, not implemented (ADR-0008, "what we are not doing"): the `spring`, `sway`,
 * `wind` and `boil` behaviours already cover the secondary motion this product needs,
 * and they are pure, seeded and free. A real solver earns its place when something
 * needs collision, and when it does it arrives here - as a provider that **bakes**,
 * because a solver integrates over its own history and `evaluate` can be seeked.
 */
export const PhysicsBody = z.object({
  nodeId: NodeId,
  massKg: z.number().positive(),
  restitution: Unit01.default(0.2),
  drag: Unit01.default(0.05),
  /** A pinned body is a constraint, not a participant - a nail in a cloth corner. */
  pinned: z.boolean().default(false),
});
export type PhysicsBody = z.infer<typeof PhysicsBody>;

export const PhysicsMotionRequest = z.object({
  ...MotionRequestBase,
  kind: z.literal('physics'),
  seed: NonNegativeInt,
  gravity: Vec2.default({ x: 0, y: 980 }),
  bodies: z.array(PhysicsBody).min(1),
  durationMs: Millis,
  /**
   * The rate the simulation is sampled at on the way out.
   *
   * Present in the *request* because it changes the artefact, not the run: a bake at
   * 12 fps and a bake at 24 fps are two different documents, and which one was made has
   * to be recorded rather than inferred from the keyframe spacing.
   */
  sampleFps: Fps,
});
export type PhysicsMotionRequest = z.infer<typeof PhysicsMotionRequest>;

/**
 * Play a library clip on a skeleton it was not authored on.
 *
 * Declared here as a request shape; the arithmetic that answers it is
 * `retargetClip` in `@rv/anim-engine`, which is pure and lives at the 100 % tier. A
 * provider wrapping it needs a clip *store* to resolve `clipName` against, and a store
 * is infrastructure - which is why the shape is declared and the adapter is not.
 */
export const RetargetedLibraryMotionRequest = z.object({
  ...MotionRequestBase,
  kind: z.literal('retargeted-library'),
  clipName: Slug,
  /** The skeleton the motion has to end up on. The source is whatever the library holds. */
  targetRig: RigSignature,
});
export type RetargetedLibraryMotionRequest = z.infer<typeof RetargetedLibraryMotionRequest>;

export const MotionRequest = z.discriminatedUnion('kind', [
  KeyframeMotionRequest,
  ProceduralMotionRequest,
  PhysicsMotionRequest,
  RetargetedLibraryMotionRequest,
]);
export type MotionRequest = z.infer<typeof MotionRequest>;

// ── results ─────────────────────────────────────────────────────────────────

/**
 * What a provider hands back: the two things an IR can hold.
 *
 * Nothing else. Not a frame, not a sampler, not a callback the evaluator could invoke
 * later - those are all ways of putting the provider back inside the boundary. A
 * provider that wants to contribute anything an `AnimationIR` cannot express is asking
 * for a change to the IR, which is a decision, not an extension point.
 */
export const AuthoredMotion = z.object({
  tracks: z.array(Track).default([]),
  behaviours: z.array(Behaviour).default([]),
});
export type AuthoredMotion = z.infer<typeof AuthoredMotion>;

/** Nothing at all - a provider that legitimately had no opinion. */
export const NO_MOTION: AuthoredMotion = { tracks: [], behaviours: [] };
