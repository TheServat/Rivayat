/**
 * Which backend draws this composition.
 *
 * ADR-0003 calls this "a capability decision, not a preference", and the decision is
 * recorded rather than made silently: {@link selectBackend} returns *why* it chose,
 * because "the render took nine minutes" and "the render used Chromium" are the same
 * question and a log line is the only place to answer it.
 *
 * ## What the IR actually declares
 *
 * ADR-0003 says `auto` "inspects the IR's declared feature set". There is no such
 * field. `AnimationIR` (`contracts/anim/ir.ts`) declares nodes, tracks, behaviours,
 * markers and a camera - and nothing anywhere in it names a filter, a shader or a blend
 * mode. So the feature set is **derived from what the IR contains**, which is honest
 * for everything the IR can express and cannot see a shader that the IR has no way to
 * request. {@link detectFeatures} therefore accepts explicit extras, so a caller that
 * knows more (a style bible declaring a post-process chain, a future IR field) can say
 * so without this function guessing.
 *
 * That gap is worth closing upstream: an `AnimationIR.features` array would make the
 * routing decision data rather than inference. Reported, not patched - `@rv/contracts`
 * belongs to another agent.
 */

import type { AnimationIR, RenderBackend } from '@rv/contracts';

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
 * The features a composition needs.
 *
 * Derived from node kinds, which is all the IR exposes. `part` and `bone` nodes imply
 * rig-driven deformation rather than a whole-sprite transform, and an `fx-emitter` is a
 * particle system by definition.
 */
export function detectFeatures(
  ir: AnimationIR,
  extra: readonly RenderFeature[] = [],
): ReadonlySet<RenderFeature> {
  const features = new Set<RenderFeature>(extra);
  for (const node of ir.nodes) {
    switch (node.kind) {
      case 'shape':
        features.add('shape');
        break;
      case 'text':
        features.add('text');
        break;
      case 'asset-instance':
        features.add('image');
        if (node.tint !== undefined) features.add('tint');
        break;
      case 'fx-emitter':
        features.add('particles');
        break;
      case 'part':
      case 'bone':
        // An explicit per-part or per-bone override is only meaningful against a
        // deformable rig; a backend that can only move whole sprites will draw the
        // instance unmoved and report success.
        features.add('mesh-deform');
        break;
      case 'group':
        break;
      // No default: `AnimNode` is a closed discriminated union and every member is
      // handled. A new node kind should fail the build here, not fall through to a
      // silent "needs nothing".
    }
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
