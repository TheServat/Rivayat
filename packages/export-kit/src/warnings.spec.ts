import { describe, expect, it } from 'vitest';
import type { IrFeature, IrFeatureUse } from '@rv/contracts';

import {
  type FormatCapabilities,
  UnsupportedFeaturesError,
  diffFeatures,
  lossyWarnings,
} from './warnings';

function use(entries: readonly (readonly [IrFeature, readonly string[]])[]): IrFeatureUse {
  return new Map(entries);
}

const capabilities: FormatCapabilities = {
  exact: new Set<IrFeature>(['markers']),
  approximate: new Map([
    ['behaviour:wind', { disposition: 'approximated' as const, detail: 'sampled' }],
    ['node:hierarchy', { disposition: 'restructured' as const, detail: 'flattened' }],
  ]),
};

describe('diffFeatures', () => {
  it('says nothing about a feature the format carries exactly', () => {
    expect(diffFeatures(use([['markers', ['mrk_1']]]), capabilities)).toEqual([]);
  });

  it('carries the declared note and disposition for an approximated feature', () => {
    const [warning] = diffFeatures(use([['behaviour:wind', ['bhv_1']]]), capabilities);
    expect(warning).toMatchObject({
      feature: 'behaviour:wind',
      disposition: 'approximated',
      detail: 'sampled',
      ids: ['bhv_1'],
    });
  });

  it('treats an unclassified feature as dropped, so forgetting one fails loudly', () => {
    const [warning] = diffFeatures(use([['node:fx-emitter', ['nod_1']]]), capabilities);
    expect(warning?.disposition).toBe('dropped');
    expect(warning?.detail).toContain('no representation');
    expect(warning?.ids).toEqual(['nod_1']);
  });

  it('orders warnings by feature so two reports diff cleanly', () => {
    const warnings = diffFeatures(
      use([
        ['node:fx-emitter', []],
        ['behaviour:wind', []],
        ['node:hierarchy', []],
      ]),
      capabilities,
    );
    expect(warnings.map((warning) => warning.feature)).toEqual([
      'behaviour:wind',
      'node:fx-emitter',
      'node:hierarchy',
    ]);
  });
});

describe('lossyWarnings', () => {
  it('excludes restructured losses, because the numbers still match', () => {
    const warnings = diffFeatures(
      use([
        ['node:hierarchy', []],
        ['behaviour:wind', []],
      ]),
      capabilities,
    );
    expect(lossyWarnings(warnings).map((warning) => warning.feature)).toEqual(['behaviour:wind']);
  });
});

describe('UnsupportedFeaturesError', () => {
  it('carries the lost list as structured data, not only in the message', () => {
    const warnings = diffFeatures(use([['node:fx-emitter', ['nod_1']]]), capabilities);
    const error = new UnsupportedFeaturesError('lottie', warnings);

    expect(error.kind).toBe('unsupported');
    expect(error.retryable).toBe(false);
    expect(error.format).toBe('lottie');
    expect(error.lost.map((warning) => warning.feature)).toEqual(['node:fx-emitter']);
    expect(error.context.lost).toEqual([
      { feature: 'node:fx-emitter', disposition: 'dropped', ids: ['nod_1'] },
    ]);
  });
});
