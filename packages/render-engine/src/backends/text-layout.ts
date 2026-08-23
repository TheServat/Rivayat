/**
 * Line breaking and alignment, as pure arithmetic over a measuring function.
 *
 * Kept out of the painter for two reasons. It is the only part of text rendering that
 * has interesting behaviour - greedy wrapping, an unbreakable word wider than the box,
 * an explicit newline - and it is the part that must agree between the two backends. A
 * canvas that wrapped at a different word from the browser would produce two different
 * films from one IR, which is exactly the divergence ADR-0003 warns about.
 */

import type { TextStyleSpec } from '../frames/draw-list';

export interface TextLine {
  readonly text: string;
  readonly width: number;
  /** Baseline-independent: the offset of this line's top from the block's top. */
  readonly top: number;
}

export interface TextBlock {
  readonly lines: readonly TextLine[];
  readonly width: number;
  readonly height: number;
}

export type MeasureText = (text: string) => number;

/**
 * Greedy wrap at whitespace, honouring explicit newlines.
 *
 * Greedy rather than Knuth-Plass: a paragraph optimiser needs a hyphenation dictionary
 * per language and this pipeline is Persian-first, where the interesting text is short
 * (a title card, a subtitle) and the failure mode of greedy wrapping - a slightly short
 * penultimate line - is invisible at that length.
 */
export function layoutText(
  text: string,
  style: TextStyleSpec,
  maxWidth: number | null,
  measure: MeasureText,
): TextBlock {
  const paragraphs = text.split('\n');
  const wrapped: string[] = [];

  for (const paragraph of paragraphs) {
    if (maxWidth === null || maxWidth <= 0) {
      wrapped.push(paragraph);
      continue;
    }
    wrapped.push(...wrapParagraph(paragraph, maxWidth, measure));
  }

  let widest = 0;
  const lines = wrapped.map((line, index) => {
    const width = measure(line);
    if (width > widest) widest = width;
    return { text: line, width, top: index * style.lineHeightPx };
  });

  return { lines, width: widest, height: lines.length * style.lineHeightPx };
}

function wrapParagraph(paragraph: string, maxWidth: number, measure: MeasureText): string[] {
  const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (current !== '' && measure(candidate) > maxWidth) {
      lines.push(current);
      current = word;
      continue;
    }
    current = candidate;
  }
  lines.push(current);
  return lines;
}

/**
 * Horizontal offset of a line inside the block, from the block's left edge.
 *
 * `start` and `end` are resolved against the text direction here rather than by setting
 * `ctx.textAlign`, because the canvas conventions for `start`/`end` under an inherited
 * direction differ between implementations and this must not.
 */
export function lineOffsetX(
  align: 'start' | 'center' | 'end',
  direction: 'ltr' | 'rtl' | 'auto',
  lineWidth: number,
  blockWidth: number,
): number {
  const rtl = direction === 'rtl';
  const resolved =
    align === 'start'
      ? rtl
        ? 'end'
        : 'begin'
      : align === 'end'
        ? rtl
          ? 'begin'
          : 'end'
        : 'center';
  if (resolved === 'begin') return 0;
  if (resolved === 'end') return blockWidth - lineWidth;
  return (blockWidth - lineWidth) / 2;
}

/** The CSS `font` shorthand the canvas expects. */
export function fontShorthand(style: TextStyleSpec): string {
  return `${String(style.fontWeight)} ${String(style.fontSizePx)}px ${style.fontFamily}`;
}
