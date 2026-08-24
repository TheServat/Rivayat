/**
 * Which backend draws this composition.
 *
 * ADR-0003 calls this "a capability decision, not a preference", and the decision is
 * recorded rather than made silently: {@link selectBackend} returns *why* it chose,
 * because "the render took nine minutes" and "the render used Chromium" are the same
 * question and a log line is the only place to answer it.
 *
 * ## What the IR declares, and what a backend can draw
 *
 * These are two different vocabularies and the distinction is load-bearing.
 * `detectIrFeatures` in `@rv/contracts` answers "what does this document *contain*" in
 * fifty terms, at the granularity a *format* differs on. {@link RENDER_FEATURES} answers
 * "what can this backend *draw*" in seven, at the granularity a *rasteriser* differs on.
 * A shape node and an SVG path shape are one drawing capability and two document
 * features; a tint is one drawing capability reachable from two different features.
 *
 * So this module is a **mapping between them**, not a second detector. It used to be a
 * walk over node kinds, which was a third opinion about what a document contains and a
 * provably weaker one: `tint` was read off `node.tint` alone, so an instance tinted
 * entirely by an animated `tint.r/g/b` track routed to the canvas backend with `tint`
 * never marked required. The mapping cannot make that mistake, because every feature the
 * IR can express is in the table or deliberately absent from it.
 *
 * `filter` maps from nothing, and that is a statement rather than an omission: the IR has
 * no way to request a shader, a filter or a blend mode, so no document can imply one.
 * {@link detectFeatures} therefore still accepts explicit extras - a caller that knows
 * about a post-process chain the IR cannot express has to be able to say so, and until
 * the IR can express one that parameter is the only honest route.
 */

import {
  type AnimationIR,
  type IrFeature,
  type RenderBackend,
  detectIrFeatures,
} from '@rv/contracts';

import { RENDER_FEATURES, type FrameBackendId, type RenderFeature } from '../ports/frame-renderer';

/** What the `napi-canvas` backend can draw. Skia in-process: 2D, no GPU, no shaders. */
export const CANVAS_FEATURES: ReadonlySet<RenderFeature> = new Set<RenderFeature>([
  'shape',
  'text',
  'image',
  'tint',
]);

/** What the browser backend can draw: everything, at 8-15 s per 150 frames (research §6). */
export const BROWSER_FEATURES: ReadonlySet<RenderFeature> = new Set<RenderFeature>(RENDER_FEATURES);

/**
 * Which drawing capability each IR feature needs.
 *
 * Only the features that imply one appear. A `behaviour:wind` moves a node the backend
 * was going to draw anyway; `markers` are metadata; `track:position` is arithmetic the
 * evaluator has already done by the time a backend sees anything. Listing those as
 * needing nothing is the correct answer, and leaving them out of the table says it.
 *
 * `node:part` and `node:bone` map to `mesh-deform` because an explicit per-part or
 * per-bone override is only meaningful against a deformable rig: a backend that can only
 * move whole sprites will draw the instance unmoved and report success.
 */
const RENDER_FEATURE_BY_IR_FEATURE: Partial<Readonly<Record<IrFeature, RenderFeature>>> = {
  'node:asset-instance': 'image',
  'node:shape': 'shape',
  'node:text': 'text',
  'node:fx-emitter': 'particles',
  'node:part': 'mesh-deform',
  'node:bone': 'mesh-deform',
  // Both routes to a tint. The second is the one a node-kind walk could not see.
  'node:tint': 'tint',
  'track:tint': 'tint',
};

/**
 * The drawing capabilities a composition needs.
 *
 * A projection of `detectIrFeatures` through {@link RENDER_FEATURE_BY_IR_FEATURE}, so
 * "what is in the document" is answered once, in `@rv/contracts`, and this module only
 * decides what each answer costs a rasteriser.
 *
 * `extra` is additive and never derived: it is how a caller declares a capability the IR
 * has no vocabulary for. See the module note.
 */
export function detectFeatures(
  ir: AnimationIR,
  extra: readonly RenderFeature[] = [],
): ReadonlySet<RenderFeature> {
  const features = new Set<RenderFeature>(extra);
  for (const irFeature of detectIrFeatures(ir).keys()) {
    const needed = RENDER_FEATURE_BY_IR_FEATURE[irFeature];
    if (needed !== undefined) features.add(needed);
  }
  return features;
}

/** The features `backend` cannot satisfy, ascending, for a message a human can act on. */
export function missingFeatures(
  required: ReadonlySet<RenderFeature>,
  supported: ReadonlySet<RenderFeature>,
): readonly RenderFeature[] {
  return RENDER_FEATURES.filter((feature) => required.has(feature) && !supported.has(feature));
}

export interface BackendDecision {
  readonly backend: FrameBackendId;
  /** Everything the composition needs, ascending in {@link RENDER_FEATURES} order. */
  readonly required: readonly RenderFeature[];
  /** What forced the browser, empty when the canvas backend was enough. */
  readonly forcedBy: readonly RenderFeature[];
  readonly reason: 'requested' | 'canvas-sufficient' | 'needs-browser';
}

/**
 * Resolve `RenderBackend` (which includes `auto`) to a concrete backend.
 *
 * An explicit request is honoured even when it cannot work: the *renderer* rejects a
 * composition it cannot draw, at `open`, with the offending features named. Silently
 * overriding a deliberate `--backend canvas` would make the flag a suggestion, and the
 * benchmark in RV-162 - "canvas completes in under half the wall time" - needs to be
 * able to force the slow one.
 */
export function selectBackend(
  ir: AnimationIR,
  requested: RenderBackend,
  extra: readonly RenderFeature[] = [],
): BackendDecision {
  const features = detectFeatures(ir, extra);
  const required = RENDER_FEATURES.filter((feature) => features.has(feature));
  const forcedBy = missingFeatures(features, CANVAS_FEATURES);

  if (requested !== 'auto') {
    return { backend: requested, required, forcedBy, reason: 'requested' };
  }
  return forcedBy.length === 0
    ? { backend: 'napi-canvas', required, forcedBy, reason: 'canvas-sufficient' }
    : { backend: 'pixi-playwright', required, forcedBy, reason: 'needs-browser' };
}
