import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The palette, measured.
 *
 * A colour is not accessible; a *pair* is. So this suite parses `tokens.css`, resolves
 * the two-layer `var()` chain the way a browser would, converts every OKLCH value to
 * sRGB, and computes the real WCAG 2.2 contrast ratio for each pair the interface
 * actually renders — in light and in dark.
 *
 * It exists because "checked the palette once" rots. Nudge a ramp step to make a
 * heading look better and the muted text under it can quietly drop to 4.2:1; nobody
 * notices by eye, and nobody re-runs a contrast tool on a colour they did not touch.
 * Here the whole matrix is re-measured on every commit.
 *
 * The maths is written out rather than pulled from a library: `apps/web` is allowed
 * exactly two workspace imports and no new runtime dependency was worth this.
 */

const TOKENS = join(__RV_SRC__, 'design', 'tokens.css');

// ── OKLCH → sRGB → relative luminance ───────────────────────────────────────

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** OKLab's LMS matrices, from Björn Ottosson's reference implementation. */
function oklchToLinearRgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const bb = c * Math.sin(h);
  const lCube = (l + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const sCube = (l - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return {
    r: 4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    g: -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    b: -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function encodeSrgb(value: number): number {
  const v = clamp01(value);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** The hex a browser would paint, for the failure message. */
function toHex(colour: Oklch): string {
  const lin = oklchToLinearRgb(colour.l, colour.c, colour.h);
  const channels = [lin.r, lin.g, lin.b].map((v) =>
    Math.round(encodeSrgb(v) * 255)
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${channels.join('')}`;
}

/**
 * WCAG relative luminance is defined on *linear-light* sRGB, so the gamma-encoded
 * round trip is skipped: the linear values are already what the formula wants, once
 * clamped into gamut.
 */
function luminance(colour: Oklch): number {
  const lin = oklchToLinearRgb(colour.l, colour.c, colour.h);
  return 0.2126 * clamp01(lin.r) + 0.7152 * clamp01(lin.g) + 0.0722 * clamp01(lin.b);
}

function contrast(a: Oklch, b: Oklch): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** True when the colour survives the trip to sRGB without a channel being clipped. */
function inGamut(colour: Oklch): boolean {
  const lin = oklchToLinearRgb(colour.l, colour.c, colour.h);
  return [lin.r, lin.g, lin.b].every((v) => v >= -0.0005 && v <= 1.0005);
}

// ── the stylesheet, parsed ──────────────────────────────────────────────────

interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

type Declarations = Readonly<Record<string, string>>;

/** Every `selector { … }` in the file, including the ones nested in an `@media`. */
function ruleBlocks(css: string): { selector: string; body: string }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: { selector: string; body: string }[] = [];
  let index = 0;
  while (index < clean.length) {
    const open = clean.indexOf('{', index);
    if (open === -1) break;
    const selector = clean
      .slice(index, open)
      .replace(/^[\s{}]*/, '')
      .trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < clean.length && depth > 0) {
      if (clean[cursor] === '{') depth += 1;
      else if (clean[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    const body = clean.slice(open + 1, cursor - 1);
    // An at-rule wraps other rules rather than declarations; descend into it.
    if (selector.startsWith('@')) blocks.push(...ruleBlocks(body));
    else blocks.push({ selector, body });
    index = cursor;
  }
  return blocks;
}

function declarations(body: string): Declarations {
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[match[1] ?? ''] = (match[2] ?? '').trim();
  }
  return out;
}

const CSS = readFileSync(TOKENS, 'utf8');
const BLOCKS = ruleBlocks(CSS);

function block(selector: string): Declarations {
  const found = BLOCKS.find((entry) => entry.selector === selector);
  if (found === undefined) throw new Error(`no rule block for ${selector}`);
  return declarations(found.body);
}

const BASE = block(':root');
const DARK_OS = block(":root:not([data-theme='light'])");
const DARK_EXPLICIT = block(":root[data-theme='dark']");
const REDUCED = BLOCKS.filter((entry) => entry.selector === ':root').map((entry) =>
  declarations(entry.body),
);

const LIGHT: Declarations = BASE;
const DARK: Declarations = { ...BASE, ...DARK_EXPLICIT };

/** Follows a `var(--x)` chain to the literal it ends at, within one theme. */
function resolve(theme: Declarations, name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`circular token: ${name}`);
  seen.add(name);
  const value = theme[name];
  if (value === undefined) throw new Error(`undefined token: ${name}`);
  const asVar = /^var\((--[\w-]+)\)$/.exec(value);
  return asVar === null ? value : resolve(theme, asVar[1] ?? '', seen);
}

/** `oklch(L C H)`. Values carrying an alpha channel are not colours we measure. */
function parseOklch(value: string): Oklch | null {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (match === null) return null;
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

function colour(theme: Declarations, name: string): Oklch {
  const literal = resolve(theme, name);
  const parsed = parseOklch(literal);
  if (parsed === null) throw new Error(`${name} is not a plain oklch colour: ${literal}`);
  return parsed;
}

const PRIMITIVES = Object.keys(BASE).filter((name) =>
  /^--rv-(slate|lapis|saffron|madder|verdigris|steel)-\d+$/.test(name),
);

// ── the pairs this interface actually renders ───────────────────────────────

/**
 * Foreground, background, and the minimum WCAG 2.2 ratio for what it is.
 *
 * 4.5:1 is body text. 3:1 is the visual boundary of a control, a focus indicator, and
 * a graphic that carries meaning (SC 1.4.11) — which is what `mark` is: registration
 * crosses and rails, never a letterform.
 *
 * Every row here is a combination some component puts on screen. A pair that is not
 * rendered is not asserted, because a rule nobody ships is a rule that only makes the
 * palette harder to tune.
 */
const PAIRS: readonly (readonly [string, string, number])[] = [
  // body and secondary text on each of the four planes
  ['--rv-color-text', '--rv-color-canvas', 4.5],
  ['--rv-color-text', '--rv-color-surface', 4.5],
  ['--rv-color-text', '--rv-color-surface-raised', 4.5],
  ['--rv-color-text', '--rv-color-surface-sunken', 4.5],
  ['--rv-color-text-muted', '--rv-color-canvas', 4.5],
  ['--rv-color-text-muted', '--rv-color-surface', 4.5],
  ['--rv-color-text-muted', '--rv-color-surface-raised', 4.5],
  ['--rv-color-text-muted', '--rv-color-surface-sunken', 4.5],
  ['--rv-color-text-faint', '--rv-color-canvas', 4.5],
  ['--rv-color-text-faint', '--rv-color-surface', 4.5],
  ['--rv-color-text-faint', '--rv-color-surface-raised', 4.5],

  // links, the active section, and the primary button's own label
  ['--rv-color-accent', '--rv-color-canvas', 4.5],
  ['--rv-color-accent', '--rv-color-surface', 4.5],
  ['--rv-color-accent', '--rv-color-surface-raised', 4.5],
  ['--rv-color-accent', '--rv-color-accent-soft', 4.5],
  ['--rv-color-accent-text', '--rv-color-accent', 4.5],
  ['--rv-color-accent-text', '--rv-color-accent-hover', 4.5],

  // badges: a tone is a soft fill with its own ink on top
  ['--rv-color-danger', '--rv-color-danger-soft', 4.5],
  ['--rv-color-warning', '--rv-color-warning-soft', 4.5],
  ['--rv-color-success', '--rv-color-success-soft', 4.5],
  ['--rv-color-info', '--rv-color-info-soft', 4.5],
  ['--rv-color-mark-strong', '--rv-color-mark-soft', 4.5],
  ['--rv-color-text-muted', '--rv-color-surface-sunken', 4.5],

  // the same inks directly on a page or a card — error text, the spend column
  ['--rv-color-danger', '--rv-color-surface', 4.5],
  ['--rv-color-danger', '--rv-color-canvas', 4.5],
  ['--rv-color-warning', '--rv-color-surface', 4.5],
  ['--rv-color-success', '--rv-color-surface', 4.5],
  ['--rv-color-info', '--rv-color-surface', 4.5],
  ['--rv-color-mark-strong', '--rv-color-canvas', 4.5],
  ['--rv-color-mark-strong', '--rv-color-surface', 4.5],

  // body text on top of a soft fill — the notice panels
  ['--rv-color-text', '--rv-color-danger-soft', 4.5],
  ['--rv-color-text-muted', '--rv-color-danger-soft', 4.5],
  ['--rv-color-text', '--rv-color-accent-soft', 4.5],
  ['--rv-color-text', '--rv-color-mark-soft', 4.5],
  ['--rv-color-text-faint', '--rv-color-danger-soft', 4.5],

  // non-text: control boundaries, the focus ring, the registration marks (SC 1.4.11)
  ['--rv-color-border-strong', '--rv-color-surface', 3],
  ['--rv-color-border-strong', '--rv-color-canvas', 3],
  ['--rv-color-border-strong', '--rv-color-surface-raised', 3],
  ['--rv-color-border-strong', '--rv-color-surface-sunken', 3],
  ['--rv-color-focus-ring', '--rv-color-canvas', 3],
  ['--rv-color-focus-ring', '--rv-color-surface', 3],
  ['--rv-color-focus-ring', '--rv-color-surface-sunken', 3],
  ['--rv-color-mark', '--rv-color-canvas', 3],
  ['--rv-color-mark', '--rv-color-surface', 3],
  ['--rv-color-mark', '--rv-color-surface-raised', 3],
  ['--rv-color-accent', '--rv-color-surface-sunken', 3],
];

const THEMES: readonly (readonly [string, Declarations])[] = [
  ['light', LIGHT],
  ['dark', DARK],
];

describe('the palette is inside sRGB', () => {
  it('clips no ramp step', () => {
    const clipped = PRIMITIVES.filter((name) => !inGamut(colour(BASE, name)));
    expect(clipped).toEqual([]);
  });

  it('lets chroma fall at both ends of every ramp', () => {
    // A ramp whose chroma peaks at the pale end is a ramp with a flat spot in it,
    // because the browser had to clip the top step back into gamut.
    const ramps = ['lapis', 'saffron', 'madder', 'verdigris', 'steel'];
    for (const ramp of ramps) {
      const steps = PRIMITIVES.filter((name) => name.startsWith(`--rv-${ramp}-`))
        .map((name) => ({ name, ...colour(BASE, name) }))
        .toSorted((a, b) => b.l - a.l);
      const peak = steps.reduce((best, step) => (step.c > best.c ? step : best), steps[0]!);
      expect(peak.name, `${ramp} peaks at its lightest step`).not.toBe(steps[0]?.name);
      expect(peak.name, `${ramp} peaks at its darkest step`).not.toBe(steps.at(-1)?.name);
    }
  });
});

describe('every rendered pair meets WCAG 2.2 AA', () => {
  for (const [themeName, theme] of THEMES) {
    for (const [foreground, background, minimum] of PAIRS) {
      it(`${themeName}: ${foreground} on ${background} ≥ ${String(minimum)}:1`, () => {
        const fg = colour(theme, foreground);
        const bg = colour(theme, background);
        const ratio = contrast(fg, bg);
        expect(
          Number(ratio.toFixed(2)),
          `${toHex(fg)} on ${toHex(bg)} measured ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(minimum);
      });
    }
  }
});

describe('dark mode is a redefinition, not an inversion', () => {
  it('redefines only the semantic layer', () => {
    const primitives = Object.keys(DARK_EXPLICIT).filter((name) => PRIMITIVES.includes(name));
    expect(primitives).toEqual([]);
  });

  it('defines nothing the light theme has not already defined', () => {
    // An orphan in the dark block is a token no light-mode user ever gets.
    const orphans = Object.keys(DARK_EXPLICIT).filter((name) => !(name in BASE));
    expect(orphans).toEqual([]);
  });

  it('keeps the OS-preference block and the explicit toggle in step', () => {
    // Two blocks exist so an explicit choice can beat `prefers-color-scheme`. If they
    // ever drift, a user on a dark machine who picks "dark" gets a different palette
    // from a user on a light machine who picks the same thing.
    expect(DARK_EXPLICIT).toEqual(DARK_OS);
  });

  it('stacks surfaces the opposite way round', () => {
    const lightness = (theme: Declarations, name: string): number => colour(theme, name).l;
    // Light: the page is darkest and a card sits lighter on top of it.
    expect(lightness(LIGHT, '--rv-color-surface-sunken')).toBeLessThan(
      lightness(LIGHT, '--rv-color-canvas'),
    );
    expect(lightness(LIGHT, '--rv-color-surface')).toBeGreaterThan(
      lightness(LIGHT, '--rv-color-canvas'),
    );
    // Dark: the same order in L, but every plane sits below 0.3 — elevation is
    // lightness because a shadow on a near-black page cannot be seen.
    expect(lightness(DARK, '--rv-color-surface-raised')).toBeGreaterThan(
      lightness(DARK, '--rv-color-surface'),
    );
    expect(lightness(DARK, '--rv-color-surface')).toBeGreaterThan(
      lightness(DARK, '--rv-color-canvas'),
    );
    expect(lightness(DARK, '--rv-color-surface-raised')).toBeLessThan(0.3);
  });

  it('lifts every ink and holds its chroma off the ramp peak', () => {
    const inks = [
      '--rv-color-accent',
      '--rv-color-danger',
      '--rv-color-warning',
      '--rv-color-success',
      '--rv-color-info',
      '--rv-color-mark',
    ];
    const peak = (hue: number): number =>
      Math.max(
        ...PRIMITIVES.map((name) => colour(BASE, name))
          .filter((step) => step.h === hue)
          .map((step) => step.c),
      );
    for (const name of inks) {
      const light = colour(LIGHT, name);
      const dark = colour(DARK, name);
      // Dark mode is not an inversion of the numbers; it is the same role played by a
      // lighter step of the same ramp, because ink on a dark page has to be lighter
      // than the page.
      expect(dark.l, `${name} lightness`).toBeGreaterThan(light.l);
      // …and never by the ramp's most saturated step. A colour that reads as
      // confident on paper reads as radioactive on indigo.
      expect(dark.c, `${name} chroma`).toBeLessThan(peak(dark.h));
    }
    // The primary carries the whole interface, so it drops outright.
    expect(colour(DARK, '--rv-color-accent').c).toBeLessThan(colour(LIGHT, '--rv-color-accent').c);
  });

  it('uses neither pure black nor pure white for a page or its text', () => {
    for (const [themeName, theme] of THEMES) {
      for (const name of [
        '--rv-color-canvas',
        '--rv-color-surface',
        '--rv-color-surface-sunken',
        '--rv-color-text',
      ]) {
        const { l } = colour(theme, name);
        expect(l, `${themeName} ${name}`).toBeGreaterThan(0.05);
        expect(l, `${themeName} ${name}`).toBeLessThan(0.995);
      }
    }
  });
});

describe('the neutral belongs to the palette', () => {
  it('carries a trace of the primary hue rather than being flat grey', () => {
    const accentHue = colour(LIGHT, '--rv-color-accent').h;
    for (const name of PRIMITIVES.filter((step) => step.startsWith('--rv-slate-'))) {
      const step = colour(BASE, name);
      expect(step.c, `${name} chroma`).toBeGreaterThan(0);
      expect(Math.abs(step.h - accentHue), `${name} hue`).toBeLessThanOrEqual(12);
    }
  });
});

describe('reduced motion is a token-level decision', () => {
  it('collapses every duration when the OS asks for less motion', () => {
    // The last `:root` block in the file is the one inside the reduced-motion query.
    const reduced = REDUCED.at(-1) ?? {};
    const durations = Object.keys(BASE).filter((name) => name.startsWith('--rv-duration-'));
    expect(durations.length).toBeGreaterThan(0);
    for (const name of durations) {
      expect(reduced[name], name).toBe('1ms');
    }
  });
});
