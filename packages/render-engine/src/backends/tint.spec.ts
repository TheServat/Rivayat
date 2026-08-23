import { describe, expect, it } from 'vitest';

import { applyTint, parseHexColour } from './tint';

describe('parseHexColour', () => {
  it('expands the short form', () => {
    expect(parseHexColour('#f80')).toEqual({ r: 255, g: 136, b: 0, a: 255 });
  });

  it('reads the long form', () => {
    expect(parseHexColour('#1a2b3c')).toEqual({ r: 26, g: 43, b: 60, a: 255 });
  });

  it('reads an alpha channel when there is one', () => {
    expect(parseHexColour('#1a2b3c80').a).toBe(128);
  });

  it('accepts a colour without the hash', () => {
    expect(parseHexColour('ffffff').r).toBe(255);
  });

  it.each(['#12', '#12345', 'not-a-colour', '#gggggg'])('refuses %s', (value) => {
    expect(() => parseHexColour(value)).toThrow();
  });
});

describe('applyTint', () => {
  const source = {
    width: 2,
    height: 1,
    data: new Uint8Array([255, 255, 255, 255, 128, 64, 32, 100]),
  };

  it('multiplies each colour channel', () => {
    const tinted = applyTint(source, '#ff8000');
    expect([...tinted.data.slice(0, 4)]).toEqual([255, 128, 0, 255]);
  });

  it('leaves alpha untouched', () => {
    // A tint says "bluer", never "fainter". Conflating the two makes a tinted node
    // mysteriously translucent, and opacity already has a home on the transform.
    const tinted = applyTint(source, '#000000');
    expect(tinted.data[3]).toBe(255);
    expect(tinted.data[7]).toBe(100);
  });

  it('does not mutate the source', () => {
    const before = Uint8Array.from(source.data);
    applyTint(source, '#00ff00');
    expect([...source.data]).toEqual([...before]);
  });

  it('is a no-op for white', () => {
    const tinted = applyTint(source, '#ffffff');
    expect([...tinted.data]).toEqual([...source.data]);
  });
});
