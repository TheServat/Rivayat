import { describe, expect, it } from 'vitest';

import { specFor, threeBlobSpec } from '../__fixtures__/builders';
import {
  DEFAULT_DECOMPOSITION_POLICY,
  FREE_LANE_POLICY,
  routeSubject,
} from './decomposition-policy';

describe('subject routing - research §3 as a table', () => {
  it('sends a prop to the free local parts-sheet lane', () => {
    const route = routeSubject(threeBlobSpec());
    expect(route.lane).toBe('local-parts-sheet');
    expect(route.decomposition).toBe('parts-sheet');
  });

  it('sends a character to the multi-reference cloud lane and segments it afterwards', () => {
    // The finding: SD 1.5 collapses a character parts request into a turnaround. So the
    // character is never *asked* for parts - it is generated whole and cut up.
    const spec = specFor('biped', { subjectClass: 'character' });
    const route = routeSubject(spec);

    expect(route.lane).toBe('cloud-multi-reference');
    expect(route.decomposition).toBe('segmented');
    expect(route.fallbacks).toEqual(['single-layer']);
  });

  it('routes an unnamed subject class through the fallback entry', () => {
    const spec = specFor('tree', { subjectClass: 'foliage' });
    expect(
      routeSubject(spec, { bySubject: {}, fallback: DEFAULT_DECOMPOSITION_POLICY.fallback }).lane,
    ).toBe('local-parts-sheet');
  });

  it('never asks a single-part spec to decompose', () => {
    const spec = specFor('rigid-prop', { subjectClass: 'prop' });
    expect(spec.parts).toHaveLength(1);

    const route = routeSubject(spec);
    expect(route.decomposition).toBe('single-layer');
    expect(route.fallbacks).toHaveLength(0);
    expect(route.reason).toContain('single part');
  });

  it('treats sky, water and fx as one mass whatever their part count', () => {
    for (const subjectClass of ['sky', 'water', 'fx'] as const) {
      expect(routeSubject(specFor('cloud', { subjectClass })).decomposition).toBe('single-layer');
    }
  });

  it('the free-lane policy keeps characters local and says what that costs', () => {
    const spec = specFor('biped', { subjectClass: 'character' });
    const route = routeSubject(spec, FREE_LANE_POLICY);

    expect(route.lane).toBe('local-parts-sheet');
    expect(route.reason).toContain('free local lane');
  });

  it('is configurable without editing this package', () => {
    const custom = routeSubject(specFor('biped', { subjectClass: 'character' }), {
      bySubject: {
        character: {
          lane: 'local-parts-sheet',
          decomposition: 'parts-sheet',
          fallbacks: [],
          reason: 'The FLUX T5-XXL experiment came back positive.',
        },
      },
      fallback: DEFAULT_DECOMPOSITION_POLICY.fallback,
    });

    expect(custom.decomposition).toBe('parts-sheet');
  });
});
