import { describe, expect, it } from 'vitest';
import { isErr, unwrap } from '@rv/shared-kernel';

import { HASH_A, HASH_B, specFor, styleBible, threeBlobSpec } from '../__fixtures__/builders';
import { routeSubject } from './decomposition-policy';
import { composeGenerationRequest, requestFingerprint } from './request-composer';

describe('composeGenerationRequest', () => {
  it('refuses to generate against a style that is not locked', () => {
    const style = styleBible({ lockedAt: null });
    const spec = threeBlobSpec();
    const failed = composeGenerationRequest({ spec, style, route: routeSubject(spec) });

    expect(isErr(failed)).toBe(true);
    // The checksum is a dedup-key component; generating against a moving style writes
    // assets that can never be found again.
    if (isErr(failed)) expect(failed.error.message).toBe('style-not-locked');
  });

  it('is byte-identical when composed twice', () => {
    const style = styleBible();
    const spec = threeBlobSpec();
    const first = unwrap(composeGenerationRequest({ spec, style, route: routeSubject(spec) }));
    const second = unwrap(composeGenerationRequest({ spec, style, route: routeSubject(spec) }));

    expect(requestFingerprint(first)).toBe(requestFingerprint(second));
    expect(first.promptHash).toBe(second.promptHash);
  });

  it('carries the style clause, the subject clause and the negatives', () => {
    const style = styleBible();
    const spec = specFor('tree');
    const composed = unwrap(composeGenerationRequest({ spec, style, route: routeSubject(spec) }));

    expect(composed.prompt).toContain('layered paper cutout');
    expect(composed.prompt).toContain('torn paper edges');
    expect(composed.negativePrompt).toContain('photorealistic');
    expect(composed.negativePrompt).toContain('photorealism');
  });

  it('asks for a grid on the parts-sheet lane, and says the components must not touch', () => {
    const style = styleBible();
    const spec = threeBlobSpec();
    const composed = unwrap(composeGenerationRequest({ spec, style, route: routeSubject(spec) }));

    expect(composed.prompt).toContain('parts sheet');
    expect(composed.prompt).toContain('columns');
    expect(composed.prompt).toContain('no two components touching');
    for (const part of spec.parts) expect(composed.prompt).toContain(part.name);
  });

  it('puts the layout instruction first and trims the style for a 77-token encoder', () => {
    const style = styleBible();
    const spec = threeBlobSpec();
    const long = unwrap(composeGenerationRequest({ spec, style, route: routeSubject(spec) }));
    const clip = unwrap(
      composeGenerationRequest({ spec, style, route: routeSubject(spec), encoder: 'clip-77' }),
    );

    // Measured, not preferred: same graph, same seed, the long form produced one
    // assembled structure and the layout-first form produced separated components.
    expect(long.prompt.startsWith('layered paper cutout')).toBe(true);
    expect(clip.prompt.startsWith('Draw a parts sheet')).toBe(true);
    // The subject and every planned part still have to survive the reshuffle - it is
    // the adjectives that are expendable, never what the picture is of.
    expect(clip.prompt).toContain(spec.description);
    for (const part of spec.parts) expect(clip.prompt).toContain(part.name);
    // And the negatives are untouched: they are short and they are what stops the
    // model drawing a scene.
    expect(clip.negativePrompt).toBe(long.negativePrompt);
  });

  it('drops the tail of a long style preamble that a 77-token window cannot reach', () => {
    // The shipped paper-cutout preset compiles to nineteen clauses, most of them hex
    // codes. This is that shape, shortened enough to read.
    const style = styleBible({
      prompts: {
        positive: 'cut-paper, moss #4a6b3f, bark #5a4632, oat #e8ddc8, film grain, torn edges',
        negative: 'photorealistic',
        bySubject: {},
        byModel: {},
      },
    });
    const spec = threeBlobSpec();
    const clip = unwrap(
      composeGenerationRequest({ spec, style, route: routeSubject(spec), encoder: 'clip-77' }),
    );
    const long = unwrap(composeGenerationRequest({ spec, style, route: routeSubject(spec) }));

    expect(clip.prompt).toContain('cut-paper');
    expect(clip.prompt).toContain('#e8ddc8');
    expect(clip.prompt).not.toContain('film grain');
    expect(long.prompt).toContain('film grain');
    expect(clip.prompt.length).toBeLessThan(long.prompt.length);
  });

  it('keeps the repair clause last whichever encoder is asked for', () => {
    const style = styleBible();
    const spec = threeBlobSpec();
    const clip = unwrap(
      composeGenerationRequest({
        spec,
        style,
        route: routeSubject(spec),
        encoder: 'clip-77',
        repairClause: 'Correct the previous attempt: thicken the outline',
      }),
    );

    expect(clip.prompt.endsWith('thicken the outline')).toBe(true);
  });

  it('asks for a whole, unoccluded figure on the segmentation lane', () => {
    const style = styleBible();
    const spec = specFor('biped', { subjectClass: 'character' });
    const composed = unwrap(composeGenerationRequest({ spec, style, route: routeSubject(spec) }));

    expect(composed.prompt).not.toContain('parts sheet');
    expect(composed.prompt).toContain('unoccluded');
  });

  it('asks for one centred piece on the single-layer lane', () => {
    const style = styleBible();
    const spec = specFor('rigid-prop', { subjectClass: 'prop' });
    const composed = unwrap(composeGenerationRequest({ spec, style, route: routeSubject(spec) }));
    expect(composed.prompt).toContain('one piece');
  });

  it('puts identity anchors ahead of style anchors, so a truncating provider loses the right one', () => {
    const style = styleBible();
    const spec = threeBlobSpec();
    const composed = unwrap(
      composeGenerationRequest({
        spec,
        style,
        route: routeSubject(spec),
        extraReferences: [
          { imageHash: HASH_A, role: 'style-anchor', weight: 1 },
          { imageHash: HASH_B, role: 'identity-anchor', weight: 1 },
        ],
      }),
    );

    expect(composed.references.map((reference) => reference.role)).toEqual([
      'identity-anchor',
      'style-anchor',
    ]);
  });

  it('orders equal-role references by weight then by hash, so the order is total', () => {
    const style = styleBible();
    const spec = threeBlobSpec();
    const composed = unwrap(
      composeGenerationRequest({
        spec,
        style,
        route: routeSubject(spec),
        extraReferences: [
          { imageHash: HASH_B, role: 'style-anchor', weight: 0.5 },
          { imageHash: HASH_A, role: 'style-anchor', weight: 0.5 },
        ],
      }),
    );

    expect(composed.references.map((reference) => reference.imageHash)).toEqual([HASH_A, HASH_B]);
  });

  it('derives the seed from the style and the spec, not from a draw', () => {
    const spec = threeBlobSpec();
    const one = unwrap(
      composeGenerationRequest({ spec, style: styleBible(), route: routeSubject(spec) }),
    );
    const other = unwrap(
      composeGenerationRequest({
        spec,
        style: styleBible({ seed: 999 }),
        route: routeSubject(spec),
      }),
    );

    expect(one.seed).not.toBe(other.seed);
    expect(Number.isInteger(one.seed)).toBe(true);
  });

  it('keeps the seed steady across a quality promotion', () => {
    // RV-131 promotes a draft "with the same seed and prompt". Quality picks the canvas
    // and the provider tier; it must not re-roll the composition.
    const style = styleBible();
    const draft = specFor('tree', { quality: 'draft' });
    const final = specFor('tree', { quality: 'final' });

    expect(
      unwrap(composeGenerationRequest({ spec: draft, style, route: routeSubject(draft) })).seed,
    ).toBe(
      unwrap(composeGenerationRequest({ spec: final, style, route: routeSubject(final) })).seed,
    );
  });

  it('appends a repair clause verbatim', () => {
    const style = styleBible();
    const spec = threeBlobSpec();
    const composed = unwrap(
      composeGenerationRequest({
        spec,
        style,
        route: routeSubject(spec),
        repairClause: 'thicken the outline',
      }),
    );
    expect(composed.prompt.endsWith('thicken the outline')).toBe(true);
  });
});
