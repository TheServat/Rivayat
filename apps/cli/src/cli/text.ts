/**
 * Column arithmetic that survives Persian.
 *
 * `'شخصیت‌ها'.length` is 8 and the terminal draws 7 cells, because the zero-width
 * non-joiner between "شخصیت" and "ها" is a character with no glyph. Every Persian
 * plural in the settings registry contains one, so `padEnd` on `String.length` puts a
 * ragged edge on exactly the rows the Persian-first UI cares about. {@link displayWidth}
 * counts cells instead of code units.
 *
 * What this module deliberately does **not** do is emit bidi isolates (U+2068/U+2069)
 * around right-to-left cells. They are the correct fix for "the Persian column visually
 * swaps places with the column next to it", and on the terminals we checked they are
 * drawn as visible boxes rather than being consumed - a legibility regression traded
 * for an ordering one. So: mixed-direction rows are laid out left-to-right with correct
 * widths, single-direction cells are correct in both senses, and anything a script
 * consumes goes through `--json` where direction cannot bite.
 */

/** Marks and format characters that occupy no cell. */
function isZeroWidth(codePoint: number): boolean {
  return (
    // Arabic/Hebrew combining marks and the Persian ZWNJ/ZWJ family.
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0483 && codePoint <= 0x0489) ||
    (codePoint >= 0x0591 && codePoint <= 0x05bd) ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06dc) ||
    (codePoint >= 0x06df && codePoint <= 0x06e4) ||
    (codePoint >= 0x06e7 && codePoint <= 0x06e8) ||
    (codePoint >= 0x06ea && codePoint <= 0x06ed) ||
    codePoint === 0x00ad ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x206f) ||
    codePoint === 0xfeff
  );
}

/** CJK and emoji ranges a terminal draws two cells wide. */
function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** How many terminal cells `text` occupies. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isZeroWidth(codePoint)) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

/** Right-pads to `width` **cells**, not code units. Never truncates. */
export function padCells(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? text + ' '.repeat(missing) : text;
}

/** Left-pads to `width` cells. For numbers, which read better right-aligned. */
export function padCellsStart(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? ' '.repeat(missing) + text : text;
}

export type Align = 'left' | 'right';

export interface Column {
  readonly header: string;
  readonly align?: Align;
}

export interface TableOptions {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly string[])[];
  /** Two spaces reads better than a pipe when cells already contain punctuation. */
  readonly gap?: string;
  readonly indent?: string;
}

/**
 * A fixed-width table, header included, aligned by cell count.
 *
 * Returns lines rather than printing them so the caller decides the stream, and so a
 * test can assert on the shape without owning a writer.
 */
export function table(options: TableOptions): readonly string[] {
  const gap = options.gap ?? '  ';
  const indent = options.indent ?? '';
  const widths = options.columns.map((column, index) =>
    Math.max(
      displayWidth(column.header),
      ...options.rows.map((row) => displayWidth(row[index] ?? '')),
    ),
  );

  const render = (cells: readonly string[]): string =>
    indent +
    options.columns
      .map((column, index) => {
        const cell = cells[index] ?? '';
        const width = widths[index] ?? 0;
        return column.align === 'right' ? padCellsStart(cell, width) : padCells(cell, width);
      })
      .join(gap)
      .trimEnd();

  const header = render(options.columns.map((column) => column.header));
  const rule =
    indent +
    widths
      .map((width) => '-'.repeat(width))
      .join(gap)
      .trimEnd();

  return [header, rule, ...options.rows.map(render)];
}

/** A two-column `key  value` block, aligned. For a summary rather than a list. */
export function keyValues(
  pairs: readonly (readonly [string, string])[],
  indent = '  ',
): readonly string[] {
  const width = Math.max(0, ...pairs.map(([key]) => displayWidth(key)));
  return pairs.map(([key, value]) => `${indent}${padCells(key, width)}  ${value}`);
}
