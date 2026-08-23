import { describe, expect, it } from 'vitest';

import { DEFAULT_TEXT_STYLE } from '../frames/draw-list';
import { fontShorthand, layoutText, lineOffsetX } from './text-layout';

/** Ten pixels a character, so every expected width is arithmetic a reader can check. */
const measure = (text: string): number => text.length * 10;

describe('layoutText', () => {
  it('leaves a single line alone when there is no width limit', () => {
    const block = layoutText('hello world', DEFAULT_TEXT_STYLE, null, measure);
    expect(block.lines.map((line) => line.text)).toEqual(['hello world']);
    expect(block.width).toBe(110);
  });

  it('honours explicit newlines even without a limit', () => {
    const block = layoutText('one\ntwo', DEFAULT_TEXT_STYLE, null, measure);
    expect(block.lines.map((line) => line.text)).toEqual(['one', 'two']);
    expect(block.height).toBe(DEFAULT_TEXT_STYLE.lineHeightPx * 2);
  });

  it('wraps greedily at whitespace', () => {
    const block = layoutText('aaa bbb ccc', DEFAULT_TEXT_STYLE, 75, measure);
    expect(block.lines.map((line) => line.text)).toEqual(['aaa bbb', 'ccc']);
  });

  it('keeps an unbreakable word on its own line rather than losing it', () => {
    const block = layoutText('short enormouswordhere', DEFAULT_TEXT_STYLE, 60, measure);
    expect(block.lines.map((line) => line.text)).toEqual(['short', 'enormouswordhere']);
  });

  it('stacks lines by the style line height', () => {
    const block = layoutText('a\nb\nc', DEFAULT_TEXT_STYLE, null, measure);
    expect(block.lines.map((line) => line.top)).toEqual([0, 58, 116]);
  });

  it('reports an empty paragraph as one empty line rather than none', () => {
    const block = layoutText('', DEFAULT_TEXT_STYLE, 100, measure);
    expect(block.lines).toHaveLength(1);
    expect(block.height).toBe(DEFAULT_TEXT_STYLE.lineHeightPx);
  });

  it('ignores a non-positive limit instead of wrapping every character', () => {
    const block = layoutText('aaa bbb', DEFAULT_TEXT_STYLE, 0, measure);
    expect(block.lines).toHaveLength(1);
  });
});

describe('lineOffsetX', () => {
  it('puts start on the left in LTR and on the right in RTL', () => {
    // Persian is the default UI locale, so this is not a corner case - it is half the
    // content, and delegating it to `ctx.textAlign` is where the two backends diverge.
    expect(lineOffsetX('start', 'ltr', 40, 100)).toBe(0);
    expect(lineOffsetX('start', 'rtl', 40, 100)).toBe(60);
  });

  it('mirrors end the same way', () => {
    expect(lineOffsetX('end', 'ltr', 40, 100)).toBe(60);
    expect(lineOffsetX('end', 'rtl', 40, 100)).toBe(0);
  });

  it('centres regardless of direction', () => {
    expect(lineOffsetX('center', 'ltr', 40, 100)).toBe(30);
    expect(lineOffsetX('center', 'rtl', 40, 100)).toBe(30);
  });

  it('treats auto as LTR for placement', () => {
    expect(lineOffsetX('start', 'auto', 40, 100)).toBe(0);
  });
});

describe('fontShorthand', () => {
  it('produces the CSS the canvas expects', () => {
    expect(fontShorthand({ ...DEFAULT_TEXT_STYLE, fontWeight: 700, fontSizePx: 32 })).toBe(
      '700 32px sans-serif',
    );
  });
});
