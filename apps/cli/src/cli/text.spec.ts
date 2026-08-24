import { describe, expect, it } from 'vitest';

import { displayWidth, keyValues, padCells, padCellsStart, table } from './text';

/**
 * The Persian cases are the reason this module exists.
 *
 * `'شخصیت‌ها'` is eight code units and seven terminal cells, because U+200C (the
 * zero-width non-joiner between "شخصیت" and "ها") has no glyph. Every Persian plural in
 * the settings registry contains one, so a table padded on `String.length` is ragged on
 * exactly the rows the Persian-first product cares about.
 */
describe('displayWidth', () => {
  it('counts ASCII by character', () => {
    expect(displayWidth('models list')).toBe(11);
  });

  it('counts a plain Persian word by letter', () => {
    expect(displayWidth('داستان')).toBe(6);
  });

  it('does not count the zero-width non-joiner', () => {
    const withZwnj = 'شخصیت‌ها';
    expect(withZwnj.length).toBe(8);
    expect(displayWidth(withZwnj)).toBe(7);
  });

  it('does not count Arabic diacritics', () => {
    expect(displayWidth('کِتاب')).toBe(4);
  });

  it('counts a wide CJK character as two cells', () => {
    expect(displayWidth('東京')).toBe(4);
  });
});

describe('padCells', () => {
  it('pads to a cell count, not a code-unit count', () => {
    expect(padCells('شخصیت‌ها', 10)).toHaveLength(8 + 3);
    expect(displayWidth(padCells('شخصیت‌ها', 10))).toBe(10);
  });

  it('never truncates something already wider than the target', () => {
    expect(padCells('overlong', 3)).toBe('overlong');
    expect(padCellsStart('overlong', 3)).toBe('overlong');
  });

  it('left-pads for right alignment', () => {
    expect(padCellsStart('7', 4)).toBe('   7');
  });
});

describe('table', () => {
  it('starts the column after a Persian one at the same offset on every row', () => {
    const lines = table({
      columns: [{ header: 'stage' }, { header: 'label' }, { header: 'model' }],
      rows: [
        ['S2', 'داستان', 'ollama:qwen3.5'],
        ['S3', 'شخصیت‌ها', 'gemini:gemini-3-flash'],
      ],
    });
    // Header, rule, two rows.
    expect(lines).toHaveLength(4);

    // Where the last column *starts* is the assertion. It is the offset a zero-width
    // mark in the Persian cell would shift, and it is what a reader perceives as
    // alignment. Trailing padding is trimmed, so total line width is not comparable.
    const models = ['ollama:qwen3.5', 'gemini:gemini-3-flash'];
    const starts = lines
      .slice(2)
      .map((line, index) => displayWidth(line) - displayWidth(models[index] ?? ''));
    expect(starts[0]).toBe(starts[1]);
  });

  it('right-aligns a column that asks for it', () => {
    const lines = table({
      columns: [{ header: 'cost', align: 'right' }],
      rows: [['$1.0000'], ['$12.0000']],
    });
    expect(lines[2]).toBe(' $1.0000');
    expect(lines[3]).toBe('$12.0000');
  });

  it('tolerates a row with fewer cells than there are columns', () => {
    const lines = table({
      columns: [{ header: 'a' }, { header: 'b' }],
      rows: [['only']],
    });
    expect(lines[2]).toBe('only');
  });
});

describe('keyValues', () => {
  it('aligns the values against the widest key', () => {
    const lines = keyValues([
      ['id', 'prj_1'],
      ['language', 'fa'],
    ]);
    expect(lines[0]).toBe('  id        prj_1');
    expect(lines[1]).toBe('  language  fa');
  });

  it('is total on an empty list', () => {
    expect(keyValues([])).toEqual([]);
  });
});
