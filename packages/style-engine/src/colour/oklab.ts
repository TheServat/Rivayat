/**
 * sRGB to OKLab.
 *
 * Palette work needs a distance that matches what an eye reports. In raw RGB, the step
 * from `#000000` to `#0000ff` and the step from `#00ff00` to `#00ffff` are the same
 * length; to a viewer they are nothing alike. Every "is this image on-palette" number
 * computed in RGB is therefore wrong in a specific direction: it is far too forgiving
 * about hue drift in the blues and far too harsh about it in the greens.
 *
 * OKLab is used rather than CIELAB because it needs no white-point argument, is a
 * closed-form polynomial (so it is fast enough to run over every sampled pixel of a
 * probe sheet), and behaves better for the saturated flat colours this pipeline
 * generates - which is precisely where CIELAB's hue lines bend.
 *
 * Björn Ottosson's coefficients, unmodified.
 */

export interface Oklab {
  /** Perceptual lightness, 0 (black) to ~1 (white). */
  readonly l: number;
  /** Green-red axis. */
  readonly a: number;
  /** Blue-yellow axis. */
  readonly b: number;
}

/** sRGB transfer function, inverted. Channel values are 0..1. */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Converts one 8-bit sRGB triple. */
export function rgbToOklab(red: number, green: number, blue: number): Oklab {
  const r = toLinear(red / 255);
  const g = toLinear(green / 255);
  const b = toLinear(blue / 255);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/**
 * Euclidean distance in OKLab.
 *
 * Roughly 0..1 for colours inside the sRGB gamut; black to white is 1.0 exactly, which
 * makes the tolerance in `palette.ts` interpretable as a fraction of the widest
 * possible perceptual gap rather than as an arbitrary constant.
 */
export function oklabDistance(left: Oklab, right: Oklab): number {
  const dl = left.l - right.l;
  const da = left.a - right.a;
  const db = left.b - right.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa` into 8-bit channels. Alpha is discarded. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  const body = hex.startsWith('#') ? hex.slice(1) : hex;
  const expanded =
    body.length === 3
      ? [...body].map((character) => `${character}${character}`).join('')
      : body.slice(0, 6);
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/** Formats 8-bit channels as lowercase `#rrggbb`. The canonical form everywhere here. */
export function toHex(red: number, green: number, blue: number): string {
  const clamp = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${clamp(red)}${clamp(green)}${clamp(blue)}`;
}
