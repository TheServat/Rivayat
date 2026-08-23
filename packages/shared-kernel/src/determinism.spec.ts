/**
 * The determinism guard, as a test rather than as a habit.
 *
 * CLAUDE.md non-negotiable #1: no wall-clock reads and no unseeded randomness in domain
 * or application code. Renders must be bit-reproducible and pipeline runs replayable,
 * and both break the moment a `Date.now()` or a `Math.random()` lands anywhere the
 * pipeline can reach it. The failure mode is the worst kind - nothing throws, the
 * frames just stop matching, and the run that produced the good ones is gone.
 *
 * This lives in `shared-kernel` because `shared-kernel` is what makes determinism
 * possible: `Clock` and `SystemClock` here, `createRng(seed)` in `rng.ts`. The guard
 * belongs with the thing it guards. It scans every workspace package rather than only
 * this one, because a violation in `render-engine` is not `render-engine`'s private
 * business - it is a broken promise the whole product rests on.
 *
 * A **lint** rule would fail earlier and is what M0's exit criterion asks for; this
 * test is the backstop that an inline `eslint-disable` cannot switch off.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/** `<repo>/packages/shared-kernel/src` -> `<repo>`. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * The one legitimate wall-clock read in the codebase.
 *
 * `SystemClock` exists so that exactly one file has to do this, and everything else
 * takes a `Clock`. Listed by path rather than by an inline comment marker so that
 * adding a second exemption is a visible diff in this file.
 */
const CLOCK_EXEMPTION = 'packages/shared-kernel/src/clock.ts';

const BANNED: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'Date.now()', pattern: /\bDate\s*\.\s*now\s*\(/ },
  { name: 'Math.random()', pattern: /\bMath\s*\.\s*random\s*\(/ },
  // `new Date()` with no argument reads the wall clock. `new Date(value)` converts a
  // value we already have and is deterministic, so only the empty call is banned.
  { name: 'new Date()', pattern: /\bnew\s+Date\s*\(\s*\)/ },
  { name: 'performance.now()', pattern: /\bperformance\s*\.\s*now\s*\(/ },
  { name: 'crypto.randomUUID()', pattern: /\bcrypto\s*\.\s*randomUUID\s*\(/ },
];

/** Every shipped source file under `packages/*&#47;src` and `apps/*&#47;src`. */
function shippedSourceFiles(): string[] {
  const roots: string[] = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(REPO_ROOT, group);
    let entries: string[];
    try {
      entries = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const src = join(groupDir, entry, 'src');
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        continue;
      }
    }
  }

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '__fixtures__') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|vue|mts)$/.test(entry)) continue;
      // Tests are allowed to read the clock: `clock.spec.ts` has to prove `SystemClock`
      // actually advances, and nothing a test does reaches a render.
      if (/\.(spec|test)\.(ts|tsx|mts)$/.test(entry)) continue;
      files.push(full);
    }
  };
  for (const root of roots) walk(root);
  return files.sort();
}

/** Strips comments and string literals, so a `Date.now()` in prose is not a violation. */
function executableCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

function violations(): string[] {
  const found: string[] = [];
  for (const file of shippedSourceFiles()) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/');
    if (rel === CLOCK_EXEMPTION) continue;
    const code = executableCode(readFileSync(file, 'utf8'));
    const lines = code.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { name, pattern } of BANNED) {
        if (pattern.test(line)) found.push(`${rel}:${String(index + 1)} ${name}`);
      }
    });
  }
  return found;
}

describe('nothing shipped reads the wall clock or an unseeded random', () => {
  it('finds source to scan at all, so an empty pass cannot be mistaken for a clean one', () => {
    const files = shippedSourceFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.endsWith(`clock.ts`))).toBe(true);
  });

  it('reports no banned call anywhere under packages/*/src or apps/*/src', () => {
    expect(violations()).toEqual([]);
  });

  it('exempts exactly one file, and that file is the injectable clock', () => {
    const code = executableCode(readFileSync(join(REPO_ROOT, CLOCK_EXEMPTION), 'utf8'));
    expect(code).toMatch(/Date\s*\.\s*now\s*\(/);
    expect(code).toMatch(/class\s+SystemClock/);
  });

  it('would catch each banned call if one were planted', () => {
    // A scanner nobody has seen fail is a scanner nobody should trust. Same predicates,
    // run over planted lines, so a regex that stops matching fails here rather than
    // silently passing an empty scan.
    const planted: Readonly<Record<string, string>> = {
      'Date.now()': 'const at = Date.now();',
      'Math.random()': 'const jitter = Math.random() * 100;',
      'new Date()': 'const now = new Date();',
      'performance.now()': 'const t = performance.now();',
      'crypto.randomUUID()': 'const id = crypto.randomUUID();',
    };
    for (const { name, pattern } of BANNED) {
      expect(pattern.test(planted[name] ?? ''), name).toBe(true);
    }
  });

  it('leaves a deterministic date conversion alone, because it reads no clock', () => {
    const newDate = BANNED.find((entry) => entry.name === 'new Date()');
    expect(newDate?.pattern.test('return new Date(value).toISOString();')).toBe(false);
    expect(newDate?.pattern.test('new Date(  )')).toBe(true);
  });

  it('does not fire on a banned call named inside a comment or a string', () => {
    const prose = executableCode(
      [
        '/** Nothing may call Date.now() directly. */',
        "const message = 'Math.random() is banned';",
      ].join('\n'),
    );
    for (const { name, pattern } of BANNED) {
      expect(pattern.test(prose), name).toBe(false);
    }
  });
});
