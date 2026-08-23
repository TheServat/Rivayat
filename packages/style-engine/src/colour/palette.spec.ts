import { describe, expect, it } from 'vitest';

import { stripedImage } from '../__fixtures__/fakes';
import { oklabDistance, parseHex, rgbToOklab, toHex } from './oklab';
import { PALETTE_TOLERANCE, extractPalette, measurePaletteAdherence } from './palette';

const MOSS = [0x4a, 0x6b, 0x3f] as const;
const BARK = [0x5a, 0x46, 0x32] as const;
const SKY = [0xcf, 0xe3, 0xef] as const;

describe('OKLab', () => {
  it('puts black and white a full unit apart, and matches itself exactly', () => {
    const black = rgbToOklab(0, 0, 0);
    const white = rgbToOklab(255, 255, 255);
    expect(black.l).toBeCloseTo(0, 5);
    expect(white.l).toBeCloseTo(1, 2);
    expect(oklabDistance(black, white)).toBeCloseTo(1, 2);
    expect(oklabDistance(black, black)).toBe(0);
  });

  it('ranks perceptual difference the way RGB distance does not', () => {
    // The failure this whole conversion exists to avoid: in raw RGB these two steps are
    // the same length, and to an eye they are nothing alike.
    const blueStep = oklabDistance(rgbToOklab(0, 0, 0), rgbToOklab(0, 0, 255));
    const greenStep = oklabDistance(rgbToOklab(0, 255, 0), rgbToOklab(0, 255, 255));
    expect(blueStep).toBeGreaterThan(greenStep);
  });

  it('parses every hex form and round-trips', () => {
    expect(parseHex('#4a6b3f')).toEqual({ r: 0x4a, g: 0x6b, b: 0x3f });
    expect(parseHex('4a6b3f')).toEqual({ r: 0x4a, g: 0x6b, b: 0x3f });
    expect(parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
    expect(parseHex('#4a6b3f80')).toEqual({ r: 0x4a, g: 0x6b, b: 0x3f });
    expect(toHex(0x4a, 0x6b, 0x3f)).toBe('#4a6b3f');
  });

  it('clamps out-of-range channels rather than emitting nonsense hex', () => {
    expect(toHex(-20, 300, 12.6)).toBe('#00ff0d');
  });
});

describe('extractPalette', () => {
  it('returns the colours that are actually in the image, with their real shares', () => {
    const image = stripedImage([MOSS, BARK, SKY]);
    const palette = extractPalette(image, { count: 3 });

    expect(palette.swatches.map((swatch) => swatch.hex).sort()).toEqual(
      ['#4a6b3f', '#5a4632', '#cfe3ef'].sort(),
    );
    for (const swatch of palette.swatches) expect(swatch.share).toBeCloseTo(1 / 3, 1);
    expect(palette.swatches.reduce((sum, swatch) => sum + swatch.share, 0)).toBeCloseTo(1, 6);
    expect(palette.sampled).toBe(image.width * image.height);
  });

  it('never invents a colour that is not in the image', () => {
    // The reason this is a histogram and not a median cut: an averaged swatch is a
    // colour the series would then be drawn in and that appears nowhere in the
    // references.
    const image = stripedImage([MOSS, SKY]);
    const present = new Set(['#4a6b3f', '#cfe3ef']);
    for (const swatch of extractPalette(image, { count: 6 }).swatches) {
      expect(present.has(swatch.hex)).toBe(true);
    }
  });

  it('folds near-duplicates into one swatch', () => {
    // One pixel off is antialiasing, not a colour the art director chose.
    const image = stripedImage([MOSS, [0x4b, 0x6c, 0x40], SKY]);
    expect(extractPalette(image, { count: 6 }).swatches).toHaveLength(2);
  });

  it('folds everything past the budget into the nearest swatch it kept', () => {
    const image = stripedImage([MOSS, BARK, SKY, [0xc2, 0x26, 0x2b]]);
    const palette = extractPalette(image, { count: 2 });
    expect(palette.swatches).toHaveLength(2);
    expect(palette.swatches.reduce((sum, swatch) => sum + swatch.share, 0)).toBeCloseTo(1, 6);
  });

  it('ignores transparent pixels entirely', () => {
    const transparent = stripedImage([MOSS, SKY], { alpha: 0 });
    expect(extractPalette(transparent)).toEqual({ swatches: [], sampled: 0 });
  });

  it('is deterministic and resolution-independent', () => {
    const small = extractPalette(stripedImage([MOSS, BARK, SKY], { width: 64, height: 64 }), {
      count: 3,
    });
    const large = extractPalette(stripedImage([MOSS, BARK, SKY], { width: 1024, height: 1024 }), {
      count: 3,
    });
    expect(small.swatches.map((swatch) => swatch.hex)).toEqual(
      large.swatches.map((swatch) => swatch.hex),
    );
    // Strided sampling, so the big image is not 256 times the work.
    expect(large.sampled).toBeLessThan(1024 * 1024);
  });

  it('handles a zero-pixel image without dividing by zero', () => {
    expect(extractPalette({ width: 0, height: 0, data: new Uint8Array(0) })).toEqual({
      swatches: [],
      sampled: 0,
    });
  });
});

describe('measurePaletteAdherence', () => {
  const palette = ['#4a6b3f', '#5a4632', '#cfe3ef'];

  it('scores a perfectly on-palette image at 1', () => {
    const measured = measurePaletteAdherence(stripedImage([MOSS, BARK, SKY]), palette);
    expect(measured.score).toBe(1);
    expect(measured.offPaletteShare).toBe(0);
    expect(measured.worstDistance).toBe(0);
  });

  it('scores an entirely off-palette image at 0', () => {
    const measured = measurePaletteAdherence(stripedImage([[0xff, 0x00, 0xff]]), palette);
    expect(measured.score).toBe(0);
    expect(measured.offPaletteShare).toBe(1);
    expect(measured.worstDistance).toBeGreaterThan(PALETTE_TOLERANCE);
  });

  it('grades a near miss rather than failing it outright', () => {
    // A cel-shaded edge legitimately lands between two palette entries; a hard
    // threshold would fail every antialiased asset in the library.
    const nearlyMoss = measurePaletteAdherence(stripedImage([[0x4e, 0x70, 0x44]]), palette);
    expect(nearlyMoss.score).toBeGreaterThan(0.5);
    expect(nearlyMoss.score).toBeLessThan(1);
    expect(nearlyMoss.offPaletteShare).toBe(0);
  });

  it('scores half an off-palette image around half', () => {
    const measured = measurePaletteAdherence(
      stripedImage([MOSS, [0xff, 0x00, 0xff]], { width: 64 }),
      palette,
    );
    expect(measured.offPaletteShare).toBeCloseTo(0.5, 1);
    expect(measured.score).toBeCloseTo(0.5, 1);
  });

  it('refuses to call an empty palette a perfect match', () => {
    // Returning 1 here would silently pass every asset generated under a malformed style.
    const measured = measurePaletteAdherence(stripedImage([MOSS]), []);
    expect(measured.score).toBe(0);
    expect(measured.offPaletteShare).toBe(1);
  });

  it('reports nothing sampled for a fully transparent image', () => {
    const measured = measurePaletteAdherence(stripedImage([MOSS], { alpha: 0 }), palette);
    expect(measured.sampled).toBe(0);
    expect(measured.score).toBe(0);
  });

  it('widens with an explicit tolerance', () => {
    const image = stripedImage([[0x6a, 0x8b, 0x5f]]);
    const strict = measurePaletteAdherence(image, palette, { tolerance: 0.02 });
    const loose = measurePaletteAdherence(image, palette, { tolerance: 0.5 });
    expect(loose.score).toBeGreaterThan(strict.score);
    expect(loose.offPaletteShare).toBeLessThan(strict.offPaletteShare);
  });
});
