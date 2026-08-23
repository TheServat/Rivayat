/**
 * What an IR document actually contains, named at the granularity an export can lose.
 *
 * An exporter is a lossy projection, and the only way to be honest about the loss is to
 * be able to name it. So the IR's capabilities are enumerated once, here, as a closed
 * list; every exporter declares which of them it can carry; and anything present in a
 * document but absent from the declaration becomes a warning that names the feature and
 * the nodes that carry it.
 *
 * The granularity is chosen to match what a *format* can differ on, not what the schema
 * happens to split. `position.x` and `position.y` are one feature because no format
 * supports one without the other, while `depth` is its own feature because Lottie's
 * layer order is static and ours is not.
 */

import type { AnimChannel, AnimationIR } from '@rv/contracts';

export const IR_FEATURES = [
  // ── node kinds ────────────────────────────────────────────────────────────
  'node:group',
  'node:asset-instance',
  'node:part',
  'node:bone',
  'node:text',
  'node:shape',
  'node:fx-emitter',
  // ── node properties that a format may not have ────────────────────────────
  'node:hierarchy',
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
  // ── scene-level ───────────────────────────────────────────────────────────
  'camera:track',
  'camera:shake',
  'camera:focus-node',
  'markers',
] as const;

export type IrFeature = (typeof IR_FEATURES)[number];

/**
 * Which feature an animated channel belongs to.
 *
 * A total `Record`, not a lookup with a fallback: adding a channel to the IR without
 * deciding what it means for an export is a compile error here, which is the only place
 * that decision reliably gets made.
 */
const FEATURE_BY_CHANNEL: Readonly<Record<AnimChannel, IrFeature>> = {
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
export function featureForChannel(channel: AnimChannel): IrFeature {
  return FEATURE_BY_CHANNEL[channel];
}

const FEATURE_DESCRIPTIONS: Readonly<Record<IrFeature, string>> = {
  'node:group': 'group nodes',
  'node:asset-instance': 'asset-instance nodes (a rigged asset placed in the scene)',
  'node:part': 'part-override nodes (direct control of one part inside an instance)',
  'node:bone': 'bone-override nodes (direct control of one bone inside an instance)',
  'node:text': 'text nodes',
  'node:shape': 'shape nodes',
  'node:fx-emitter': 'particle emitters',
  'node:hierarchy': 'the parent/child node hierarchy',
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
  'camera:track': 'the camera track (pan / zoom / roll)',
  'camera:shake': 'seeded camera shake',
  'camera:focus-node': 'the camera’s focus node, which drives per-format reframing',
  markers: 'timeline markers',
};

/** Human-readable text for a feature, for warning messages and UI. */
export function describeFeature(feature: IrFeature): string {
  return FEATURE_DESCRIPTIONS[feature];
}

/** Feature → the ids of the nodes, tracks or behaviours that carry it. */
export type FeatureUse = ReadonlyMap<IrFeature, readonly string[]>;

/**
 * Everything this document uses, with the ids that use it.
 *
 * The ids matter: "text is approximated" is a footnote, "text is approximated on
 * `title-card` and `subtitle`" is something a reviewer can act on.
 */
export function detectFeatures(ir: AnimationIR): FeatureUse {
  const uses = new Map<IrFeature, string[]>();
  const note = (feature: IrFeature, id: string): void => {
    const bucket = uses.get(feature);
    if (bucket === undefined) uses.set(feature, [id]);
    else if (!bucket.includes(id)) bucket.push(id);
  };

  for (const node of ir.nodes) {
    note(`node:${node.kind}`, node.id);
    if (node.parentId !== null) note('node:hierarchy', node.id);

    switch (node.kind) {
      case 'asset-instance': {
        if (node.tint !== undefined) note('node:tint', node.id);
        if (node.flipX) note('node:flip-x', node.id);
        if (node.clipName !== undefined) note('node:clip-playback', node.id);
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
    }
  }

  for (const track of ir.tracks) {
    note(featureForChannel(track.channel), track.id);
    if (track.additive) note('track:additive', track.id);
    if (track.before !== 'hold' || track.after !== 'hold') note('track:extrapolation', track.id);
    for (const keyframe of track.keyframes) {
      const easing = keyframe.easing;
      if (easing?.kind === 'stepped' && (easing.steps > 1 || easing.at === 'start')) {
        note('track:stepped-easing', track.id);
      }
    }
  }

  for (const behaviour of ir.behaviours) {
    if (!behaviour.enabled) continue;
    note(`behaviour:${behaviour.kind}`, behaviour.id);
  }

  if (ir.camera !== undefined) {
    note('camera:track', ir.id);
    if (ir.camera.shakeAmplitude > 0) note('camera:shake', ir.id);
    if (ir.camera.focusNodeId !== undefined) note('camera:focus-node', ir.camera.focusNodeId);
  }

  if (ir.markers.length > 0) {
    for (const marker of ir.markers) note('markers', marker.id);
  }

  return uses;
}
