import { describe, expect, it } from 'vitest';
import type { AnimationIR } from '@rv/contracts';

import { assetIr, particlesIr, pure2dIr, testId } from '../__fixtures__/ir';
import type { RenderFeature } from '../ports/frame-renderer';
import {
  BROWSER_FEATURES,
  CANVAS_FEATURES,
  detectFeatures,
  missingFeatures,
  selectBackend,
} from './selector';

describe('detectFeatures', () => {
  it('reads shapes and text out of a pure 2D composition', () => {
    expect([...detectFeatures(pure2dIr())].sort()).toEqual(['shape', 'text']);
  });

  it('reports a tint separately from an image', () => {
    expect(detectFeatures(assetIr()).has('tint')).toBe(false);
    expect(detectFeatures(assetIr({ tint: '#ff0000' })).has('tint')).toBe(true);
  });

  it('treats an fx-emitter as particles', () => {
    expect(detectFeatures(particlesIr()).has('particles')).toBe(true);
  });

  it('treats a part override as mesh deformation', () => {
    const base = assetIr();
    const withPart = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          kind: 'part' as const,
          id: testId('nod', 'PART') as never,
          name: 'ear',
          parentId: null,
          instanceId: base.nodes[0]!.id,
          partId: testId('prt', 'EAR') as never,
          transform: base.nodes[0]!.transform,
          visible: true,
          depth: 0,
        },
      ],
    };
    expect(detectFeatures(withPart).has('mesh-deform')).toBe(true);
  });

  it('reports a tint that only exists as an animated track', () => {
    // The routing bug this replaced the node-kind walk to fix. `tint.r/g/b` are animatable
    // channels, so an instance can be tinted for the whole shot without ever carrying a
    // static `node.tint` - and a walk that only reads node fields sees no tint at all,
    // calls the canvas backend sufficient, and renders the shot untinted.
    const base = assetIr();
    const animated = {
      ...base,
      tracks: [
        {
          id: testId('trk', 'TINTR') as never,
          nodeId: base.nodes[0]!.id,
          channel: 'tint.r' as const,
          keyframes: [
            { timeMs: 0, value: 0 },
            { timeMs: 1000, value: 1 },
          ],
          before: 'hold' as const,
          after: 'hold' as const,
          additive: false,
        },
      ],
    };

    expect(base.nodes[0]?.kind === 'asset-instance' && base.nodes[0].tint).toBeUndefined();
    expect(detectFeatures(animated).has('tint')).toBe(true);
  });

  it('sends an animated tint to a backend that can tint', () => {
    // The consequence, stated where it costs money: the canvas backend declares `tint`, so
    // this must not be the reason a shot goes to the browser - but it must be *required*,
    // so that a backend which could not tint would be rejected at `open` rather than
    // producing a grey fox.
    const base = assetIr();
    const animated = {
      ...base,
      tracks: [
        {
          id: testId('trk', 'TINTG') as never,
          nodeId: base.nodes[0]!.id,
          channel: 'tint.g' as const,
          keyframes: [
            { timeMs: 0, value: 0 },
            { timeMs: 1000, value: 1 },
          ],
          before: 'hold' as const,
          after: 'hold' as const,
          additive: false,
        },
      ],
    };

    expect(selectBackend(animated, 'auto').required).toContain('tint');
  });

  it('accepts features the IR has no way to declare', () => {
    // The IR carries no filter or shader field at all, so a caller that knows about a
    // post-process chain has to be able to say so rather than have this guess.
    expect(detectFeatures(pure2dIr(), ['filter']).has('filter')).toBe(true);
  });
});

describe('the mapping between the two vocabularies', () => {
  it('needs a drawing capability for every node kind that draws something', () => {
    // The mapping is a `Partial` record, so a feature with no entry needs nothing - which
    // is right for `behaviour:wind` and wrong for a node kind. Asserted through the
    // public function rather than against the table, so it survives the table being
    // restructured.
    const cases: readonly (readonly [AnimationIR, RenderFeature])[] = [
      [pure2dIr(), 'shape'],
      [pure2dIr(), 'text'],
      [assetIr(), 'image'],
      [particlesIr(), 'particles'],
    ];
    for (const [ir, expected] of cases) {
      expect(detectFeatures(ir).has(expected), `nothing required ${expected}`).toBe(true);
    }
  });

  it('asks for nothing on account of a procedural behaviour or a marker', () => {
    // A behaviour moves a node the backend was already drawing, and a marker is metadata.
    // Routing a shot to Chromium because a tree sways would be a real cost for nothing.
    const base = pure2dIr();
    const withBehaviour = {
      ...base,
      behaviours: [
        {
          kind: 'wind' as const,
          id: testId('bhv', 'WIND') as never,
          nodeId: base.nodes[0]!.id,
          enabled: true,
          seed: 1,
          weight: 1,
          hz: 0.3,
          amplitude: 0.25,
          gustiness: 0.4,
          direction: 0,
          tipBias: 0.7,
        },
      ],
      markers: [
        { id: testId('mrk', 'BEAT') as never, timeMs: 0, kind: 'beat' as const, label: 'in' },
      ],
    };

    expect([...detectFeatures(withBehaviour)].sort()).toEqual([...detectFeatures(base)].sort());
  });

  it('never invents a filter, because nothing in the IR can ask for one', () => {
    // `RENDER_FEATURES` lists a capability the IR has no vocabulary for. Mapping something
    // onto it to make the list look complete would route shots to the slow backend for a
    // shader nobody requested.
    for (const ir of [pure2dIr(), assetIr({ tint: '#ff0000' }), particlesIr()]) {
      expect(detectFeatures(ir).has('filter')).toBe(false);
    }
  });
});

describe('missingFeatures', () => {
  it('names what the canvas backend cannot do, in a stable order', () => {
    expect(missingFeatures(new Set(['particles', 'filter', 'shape']), CANVAS_FEATURES)).toEqual([
      'particles',
      'filter',
    ]);
  });

  it('finds nothing missing for the browser', () => {
    expect(missingFeatures(new Set(['particles', 'filter']), BROWSER_FEATURES)).toEqual([]);
  });
});

describe('selectBackend', () => {
  it('chooses the canvas for a pure 2D composition', () => {
    const decision = selectBackend(pure2dIr(), 'auto');
    expect(decision).toMatchObject({
      backend: 'napi-canvas',
      reason: 'canvas-sufficient',
      forcedBy: [],
    });
  });

  it('chooses the browser when something needs a GPU, and records why', () => {
    const decision = selectBackend(particlesIr(), 'auto');
    expect(decision).toMatchObject({ backend: 'pixi-playwright', reason: 'needs-browser' });
    expect(decision.forcedBy).toContain('particles');
  });

  it('honours an explicit request even when it cannot work', () => {
    // Overriding a deliberate `--backend canvas` would make the flag a suggestion, and
    // the RV-162 benchmark needs to be able to force the slow one. The *renderer*
    // refuses the composition at `open`; the selector does not second-guess the user.
    const decision = selectBackend(particlesIr(), 'napi-canvas');
    expect(decision).toMatchObject({ backend: 'napi-canvas', reason: 'requested' });
    expect(decision.forcedBy).toContain('particles');
  });

  it('reports the required set in a stable order', () => {
    expect(selectBackend(pure2dIr(), 'auto').required).toEqual(['shape', 'text']);
  });
});
