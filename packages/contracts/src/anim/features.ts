/**
 * What an IR document contains, named at the granularity a consumer can fail on.
 *
 * ## Why this is here and not in the exporter
 *
 * An exporter is a lossy projection and the only way to be honest about the loss is to
 * be able to name it; a render backend is a *capability* boundary and the only way to
 * route to one correctly is to know what the composition needs. Those are two questions
 * with one answer, and until now each package derived it separately: `@rv/export-kit`
 * enumerated fifty features exactly, and `@rv/render-engine` inferred six of them from
 * node kinds alone and said so in its own header ("the feature set is derived from what
 * the IR contains ... that gap is worth closing upstream").
 *
 * Two derivations of one fact drift, and they drift asymmetrically: the exporter warns
 * about a feature the renderer silently drops. The vocabulary is a property of the IR,
 * so it belongs beside the IR.
 *
 * There is a second, harder reason. {@link IR_FEATURE_BY_CHANNEL} is a **total**
 * `Record<AnimChannel, IrFeature>`, and the behaviour and node cases below are
 * exhaustive over closed unions declared in `ir.ts`. Downstream, that totality only
 * fails when the downstream package is built - so adding a channel to `AnimChannel` in
 * this package compiles cleanly here and breaks somewhere else, days later. Here, it is
 * a compile error in the same file as the union, which is the only place the decision
 * "and what does this mean for an export?" reliably gets made.
 *
 * ## Derived, not declared
 *
 * There is no `AnimationIR.features` field, deliberately. Every feature below is a
 * projection of nodes, tracks, behaviours, the camera or the markers - data the
 * document already carries - and a declared copy is a second source of truth that goes
 * stale the first time a node is edited without it. That is the same reasoning
 * `remainingStages` in `pipeline/run.ts` records: a stored derivation is wrong exactly
 * when nobody is looking.
 *
 * A stored **checksum** over the nodes was considered and rejected. It detects
 * staleness rather than preventing it, and the only sane recovery from a stale feature
 * list is to re-derive - which is what calling {@link detectIrFeatures} does, without
 * the field. Worse, the IR is edited in the timeline UI on every scrub-and-tweak, so a
 * checksum would turn ordinary authoring into a document that fails validation until
 * something remembers to recompute it.
 *
 * The cost of deriving is real and worth stating: a consumer must run our code to learn
 * what a document needs. That is already true of `.rvanim.json` - `irVersion` means a
 * reader must know our schema, and a feature named `behaviour:lip-sync` is no more
 * interpretable to a stranger than the behaviour record it was derived from.
 *
 * **The one thing derivation cannot see** is a capability requested by a node's
 * *parameters* rather than by its kind - a shader, a filter, a blend mode. Today that
 * is a non-issue because the IR has no way to request one: `RENDER_FEATURES` in
 * `@rv/render-engine` lists `filter` and nothing can ever set it. When the IR gains
 * them, they belong on the node that asks for one, and this function grows a case -
 * *not* a document-level `features` array, which would re-introduce exactly the
 * staleness this file exists to avoid.
 *
 * ## The granularity
 *
 * Chosen to match what a *consumer* can differ on, not what the schema happens to
 * split. `position.x` and `position.y` are one feature because no format supports one
 * without the other, while `depth` is its own feature because Lottie's layer order is
 * static and ours is not.
 */

import { z } from 'zod';

import type { AnimChannel, AnimationIR, BehaviourKind } from './ir';

export const IR_FEATURES = [
  // ── node kinds ────────────────────────────────────────────────────────────
  'node:group',
  'node:asset-instance',
  'node:part',
  'node:bone',
  'node:text',
  'node:shape',
  'node:fx-emitter',
  // ── node properties that a consumer may not have ──────────────────────────
  'node:hierarchy',
  'node:anchor-attachment',
  'node:tint',
  'node:flip-x',
  'node:clip-playback',
  'node:text-rtl',
  'node:shape-path',
  // ── animated channels ─────────────────────────────────────────────────────
  'track:position',
  'track:rotation',
  'track:scale',
  'track:skew',
  'track:anchor',
  'track:opacity',
  'track:depth',
  'track:tint',
  'track:clip-speed',
  'track:fx-intensity',
  'track:text-reveal',
  'track:path-progress',
  // ── track semantics ───────────────────────────────────────────────────────
  'track:additive',
  'track:extrapolation',
  'track:stepped-easing',
  // ── procedural behaviours ─────────────────────────────────────────────────
  'behaviour:wind',
  'behaviour:breathe',
  'behaviour:blink',
  'behaviour:sway',
  'behaviour:walk-cycle',
  'behaviour:flap',
  'behaviour:orbit',
  'behaviour:parallax',
  'behaviour:boil',
  'behaviour:spring',
  'behaviour:look-at',
  'behaviour:follow-path',
  'behaviour:lip-sync',
  // ── how an asset instance is drawn ────────────────────────────────────────
  'representation:video',
  // ── scene-level ───────────────────────────────────────────────────────────
  'camera:track',
  'camera:shake',
  'camera:focus-node',
  'camera:projection',
  'markers',
] as const;

/**
 * A feature name, as a schema.
 *
 * An enum rather than a bare union type because these names travel: an export warning
 * carries the feature it lost and the ids that carry it, and the studio renders both.
 * A name the client does not recognise should fail at the boundary, not render as an
 * empty row.
 */
export const IrFeature = z.enum(IR_FEATURES);
export type IrFeature = z.infer<typeof IrFeature>;

/**
 * Which feature an animated channel belongs to.
 *
 * A total `Record`, not a lookup with a fallback: adding a channel to `AnimChannel`
 * without deciding what it means downstream is a compile error here, in the same
 * package as the union, which is the whole reason this table moved.
 */
export const IR_FEATURE_BY_CHANNEL: Readonly<Record<AnimChannel, IrFeature>> = {
  'position.x': 'track:position',
  'position.y': 'track:position',
  rotation: 'track:rotation',
  'scale.x': 'track:scale',
  'scale.y': 'track:scale',
  'skew.x': 'track:skew',
  'skew.y': 'track:skew',
  'anchor.x': 'track:anchor',
  'anchor.y': 'track:anchor',
  opacity: 'track:opacity',
  depth: 'track:depth',
  'tint.r': 'track:tint',
  'tint.g': 'track:tint',
  'tint.b': 'track:tint',
  'clip.speed': 'track:clip-speed',
  'fx.intensity': 'track:fx-intensity',
  'text.reveal': 'track:text-reveal',
  'path.progress': 'track:path-progress',
};

/** The feature a channel belongs to. */
export function irFeatureForChannel(channel: AnimChannel): IrFeature {
  return IR_FEATURE_BY_CHANNEL[channel];
}

/**
 * Every behaviour kind, as the feature that names it.
 *
 * Total over `BehaviourKind` for the same reason the channel table is: a fourteenth
 * behaviour must be a decision, not a string that happens to concatenate.
 */
export const IR_FEATURE_BY_BEHAVIOUR: Readonly<Record<BehaviourKind, IrFeature>> = {
  wind: 'behaviour:wind',
  breathe: 'behaviour:breathe',
  blink: 'behaviour:blink',
  sway: 'behaviour:sway',
  'walk-cycle': 'behaviour:walk-cycle',
  flap: 'behaviour:flap',
  orbit: 'behaviour:orbit',
  parallax: 'behaviour:parallax',
  boil: 'behaviour:boil',
  spring: 'behaviour:spring',
  'look-at': 'behaviour:look-at',
  'follow-path': 'behaviour:follow-path',
  'lip-sync': 'behaviour:lip-sync',
};

const IR_FEATURE_DESCRIPTIONS: Readonly<Record<IrFeature, string>> = {
  'node:group': 'group nodes',
  'node:asset-instance': 'asset-instance nodes (a rigged asset placed in the scene)',
  'node:part': 'part-override nodes (direct control of one part inside an instance)',
  'node:bone': 'bone-override nodes (direct control of one bone inside an instance)',
  'node:text': 'text nodes',
  'node:shape': 'shape nodes',
  'node:fx-emitter': 'particle emitters',
  'node:hierarchy': 'the parent/child node hierarchy',
  'node:anchor-attachment':
    'a node hung off a named anchor on its parent instance’s rig, e.g. a prop held at `grip-right`',
  'node:tint': 'per-instance tint',
  'node:flip-x': 'horizontal flip on an asset instance',
  'node:clip-playback': 'a named rig clip playing on an instance (loop, offset, speed)',
  'node:text-rtl': 'right-to-left text direction',
  'node:shape-path': 'SVG path geometry on a shape node',
  'track:position': 'position keyframes',
  'track:rotation': 'rotation keyframes',
  'track:scale': 'scale keyframes',
  'track:skew': 'skew keyframes',
  'track:anchor': 'anchor (pivot) keyframes',
  'track:opacity': 'opacity keyframes',
  'track:depth': 'animated depth (paint order changing over time)',
  'track:tint': 'animated tint channels',
  'track:clip-speed': 'animated rig-clip playback speed',
  'track:fx-intensity': 'animated particle intensity',
  'track:text-reveal': 'animated text reveal',
  'track:path-progress': 'animated progress along a path',
  'track:additive': 'additive tracks (layered on top of a behaviour rather than replacing it)',
  'track:extrapolation': 'loop / ping-pong extrapolation outside a track’s keyframe span',
  'track:stepped-easing': 'stepped easing with more than one jump, or a jump at the interval start',
  'behaviour:wind': 'the procedural `wind` behaviour',
  'behaviour:breathe': 'the procedural `breathe` behaviour',
  'behaviour:blink': 'the procedural `blink` behaviour',
  'behaviour:sway': 'the procedural `sway` behaviour',
  'behaviour:walk-cycle': 'the procedural `walk-cycle` behaviour',
  'behaviour:flap': 'the procedural `flap` behaviour',
  'behaviour:orbit': 'the procedural `orbit` behaviour',
  'behaviour:parallax': 'the procedural `parallax` behaviour',
  'behaviour:boil': 'the procedural `boil` behaviour',
  'behaviour:spring': 'the procedural `spring` behaviour',
  'behaviour:look-at': 'the procedural `look-at` behaviour',
  'behaviour:follow-path': 'the procedural `follow-path` behaviour',
  'behaviour:lip-sync': 'the procedural `lip-sync` behaviour',
  'representation:video':
    'an asset instance drawn as pre-rendered footage rather than as artwork the engine composes',
  'camera:track': 'the camera track (pan / zoom / roll)',
  'camera:shake': 'seeded camera shake',
  'camera:focus-node': 'the camera’s focus node, which drives per-format reframing',
  'camera:projection': 'a non-orthographic camera projection, e.g. isometric',
  markers: 'timeline markers',
};

/** Human-readable text for a feature, for warning messages and UI. */
export function describeIrFeature(feature: IrFeature): string {
  return IR_FEATURE_DESCRIPTIONS[feature];
}

/** Feature → the ids of the nodes, tracks or behaviours that carry it. */
export type IrFeatureUse = ReadonlyMap<IrFeature, readonly string[]>;

/**
 * Everything this document uses, with the ids that use it.
 *
 * The ids matter: "text is approximated" is a footnote, "text is approximated on
 * `title-card` and `subtitle`" is something a reviewer can act on. The renderer wants
 * only the keys; the exporters want the values; one pass serves both.
 *
 * Named `detectIrFeatures` rather than `detectFeatures` because `@rv/render-engine`
 * exports a `detectFeatures` that answers a *different* question in a *different*
 * vocabulary - which backend capabilities are needed, not which IR features are
 * present. Two functions with one name returning two vocabularies is the confusion this
 * file exists to end, and reproducing it in the barrel every app imports would be a
 * poor start.
 */
export function detectIrFeatures(ir: AnimationIR): IrFeatureUse {
  const uses = new Map<IrFeature, string[]>();
  const note = (feature: IrFeature, id: string): void => {
    const bucket = uses.get(feature);
    if (bucket === undefined) uses.set(feature, [id]);
    else if (!bucket.includes(id)) bucket.push(id);
  };

  for (const node of ir.nodes) {
    note(`node:${node.kind}`, node.id);
    if (node.parentId !== null) note('node:hierarchy', node.id);
    // On `NodeBase`, so it is detected before the per-kind switch: a prop is an
    // asset-instance, a speech balloon is a text node, and an emitter can sit at an
    // anchor too. Any of them is something a format without rigs has to be warned about.
    if (node.attachment !== undefined) note('node:anchor-attachment', node.id);

    switch (node.kind) {
      case 'asset-instance': {
        if (node.tint !== undefined) note('node:tint', node.id);
        if (node.flipX) note('node:flip-x', node.id);
        if (node.clipName !== undefined) note('node:clip-playback', node.id);
        // Only video is noted. The other representations are different arrangements of
        // still images and every consumer that can draw one can draw them all, so a
        // feature for each would be four rows nobody can ever fail on. Footage is a
        // real capability: a canvas backend cannot decode it and cannot approximate it
        // either, and a format that silently drops it ships a hole in the timeline.
        if (node.asset.representation === 'video') note('representation:video', node.id);
        break;
      }
      case 'text': {
        if (node.direction === 'rtl') note('node:text-rtl', node.id);
        break;
      }
      case 'shape': {
        if (node.shape === 'path') note('node:shape-path', node.id);
        break;
      }
      case 'group':
      case 'part':
      case 'bone':
      case 'fx-emitter':
        break;
      // No default: `AnimNode` is a closed union and every member is handled. A new
      // node kind must fail the build here rather than fall through to "needs nothing".
    }
  }

  for (const track of ir.tracks) {
    note(irFeatureForChannel(track.channel), track.id);
    if (track.additive) note('track:additive', track.id);
    if (track.before !== 'hold' || track.after !== 'hold') note('track:extrapolation', track.id);
    for (const keyframe of track.keyframes) {
      const easing = keyframe.easing;
      // One jump at the end of an interval is what every format calls a hold; more than
      // one, or a jump at the start, is something most of them cannot express.
      if (easing?.kind === 'stepped' && (easing.steps > 1 || easing.at === 'start')) {
        note('track:stepped-easing', track.id);
      }
    }
  }

  for (const behaviour of ir.behaviours) {
    // A disabled behaviour is not a feature of the document: nothing evaluates it, so
    // warning that an export loses it would be a warning about nothing.
    if (!behaviour.enabled) continue;
    note(IR_FEATURE_BY_BEHAVIOUR[behaviour.kind], behaviour.id);
  }

  if (ir.camera !== undefined) {
    note('camera:track', ir.id);
    if (ir.camera.shakeAmplitude > 0) note('camera:shake', ir.id);
    if (ir.camera.focusNodeId !== undefined) note('camera:focus-node', ir.camera.focusNodeId);
    // Orthographic is the identity and changes nothing, so it is not a feature. Any
    // other projection is: a format that cannot express one renders the composition
    // from a different point of view, which is a bigger loss than most of the rows
    // above and would otherwise be the only silent one.
    if (ir.camera.projection !== 'orthographic') note('camera:projection', ir.id);
  }

  for (const marker of ir.markers) note('markers', marker.id);

  return uses;
}

/**
 * The features present, in {@link IR_FEATURES} order, without the ids.
 *
 * The shape a *router* wants. `selectBackend` needs a stable, comparable list and does
 * not care which node carries what; making it iterate a map and sort would be three
 * lines repeated at every call site, and the ordering is what makes a decision log
 * diffable between two runs.
 */
export function irFeatureList(uses: IrFeatureUse): readonly IrFeature[] {
  return IR_FEATURES.filter((feature) => uses.has(feature));
}
