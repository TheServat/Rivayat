import { describe, expect, it } from 'vitest';

import { assetIr, particlesIr, pure2dIr, testId } from '../__fixtures__/ir';
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

  it('accepts features the IR has no way to declare', () => {
    // The IR carries no filter or shader field at all, so a caller that knows about a
    // post-process chain has to be able to say so rather than have this guess.
    expect(detectFeatures(pure2dIr(), ['filter']).has('filter')).toBe(true);
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
