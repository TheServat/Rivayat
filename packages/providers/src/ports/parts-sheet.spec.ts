import { describe, expect, it } from 'vitest';

import { supportsPartsSheet } from './parts-sheet';

/**
 * The guard is the whole declaration mechanism.
 *
 * `Capability` cannot carry parts-sheet support - the argument is in the module header -
 * so `CapabilityMatrix.register` never checks it and this function is the only thing
 * standing between a caller and a silent fallback. It is asked about arbitrary values
 * because callers hand it whatever the composition root wired, which on a misconfigured
 * run is `undefined`.
 */
describe('supportsPartsSheet', () => {
  it('says no to anything that is not an object', () => {
    for (const candidate of [undefined, null, 'comfyui', 42, true, Symbol('x')]) {
      expect(supportsPartsSheet(candidate)).toBe(false);
    }
  });

  it('says no to an object with neither the method nor the flag', () => {
    expect(supportsPartsSheet({})).toBe(false);
    expect(supportsPartsSheet({ generateImage: () => undefined })).toBe(false);
  });

  it('says no when the method is there but the instance declares it cannot serve', () => {
    // The deployment that never got the workflow file. Having the method is not a claim.
    expect(
      supportsPartsSheet({ generatePartsSheet: () => undefined, servesPartsSheet: false }),
    ).toBe(false);
  });

  it('says no when the flag is set but nothing implements it', () => {
    // A hand-built double that claims support would otherwise crash at the call site.
    expect(supportsPartsSheet({ servesPartsSheet: true })).toBe(false);
  });

  it('demands the flag be exactly true, not merely truthy', () => {
    expect(supportsPartsSheet({ generatePartsSheet: () => undefined, servesPartsSheet: 1 })).toBe(
      false,
    );
  });

  it('says yes only when both halves are present', () => {
    expect(
      supportsPartsSheet({ generatePartsSheet: () => undefined, servesPartsSheet: true }),
    ).toBe(true);
  });
});
