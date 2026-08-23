#!/usr/bin/env node
/**
 * Determinism fitness function — CLAUDE.md non-negotiable #1.
 *
 * "No `Date.now()`, no `Math.random()`, no wall-clock reads in domain or application
 * code." Renders must be bit-reproducible and pipeline runs replayable, and both break
 * the moment ambient time or ambient entropy leaks into logic.
 *
 * Why an AST walk and not `grep`: most matches for `Date.now()` in this repo are inside a
 * TSDoc block explaining why it is banned. A regex scan flags those, so it gets ignored
 * within a week. `ts.forEachChild` sees expressions only — comments, strings and template
 * literals are structurally invisible to it. This is also the concrete payoff of ADR-0005
 * (TypeScript 6, which still ships a compiler API).
 *
 * Why a script and not an ESLint rule: `pnpm lint` is type-aware and takes minutes; this
 * takes under a second, so it can also run on a pre-commit hook. It stays green while the
 * ESLint config is mid-edit, which matters in a repo several agents write to at once.
 *
 * Escaping it, in order of preference:
 *   1. Don't. Inject `Clock`, or `createRng(seed)` from `@rv/shared-kernel`.
 *   2. `// determinism-allow: <reason>` on the offending line or the line above it.
 *   3. An ALLOWLIST entry below, for the few files that *are* the boundary between the
 *      deterministic core and the ambient world.
 *
 * Usage:  node tools/scripts/determinism-scan.mjs [dir...]
 * Exit:   0 clean, 1 violations found, 2 the scanner itself failed.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

/**
 * Calls that read ambient time or ambient entropy, keyed by dotted callee. A bare
 * identifier is listed alongside the member form because
 * `import { randomUUID } from 'node:crypto'` makes `randomUUID()` the same hazard as
 * `crypto.randomUUID()`.
 */
const FORBIDDEN_CALLS = new Map([
  ['Date.now', 'reads the wall clock — inject `Clock` and call `clock.now()`'],
  ['Math.random', 'ambient entropy — use `createRng(seed)` from @rv/shared-kernel'],
  ['performance.now', 'reads a monotonic clock — inject `Clock`'],
  ['process.hrtime', 'reads a monotonic clock — inject `Clock`'],
  ['process.uptime', 'reads process wall time — inject `Clock`'],
  ['crypto.randomUUID', 'ambient entropy — mint ids through `IdGenerator`'],
  ['randomUUID', 'ambient entropy — mint ids through `IdGenerator`'],
  ['crypto.getRandomValues', 'ambient entropy — inject the byte source'],
  ['getRandomValues', 'ambient entropy — inject the byte source'],
  ['crypto.randomBytes', 'ambient entropy — inject the byte source'],
  ['randomBytes', 'ambient entropy — inject the byte source'],
  ['crypto.randomInt', 'ambient entropy — use `createRng(seed)`'],
  ['randomInt', 'ambient entropy — use `createRng(seed)`'],
  ['crypto.randomFillSync', 'ambient entropy — inject the byte source'],
  ['randomFillSync', 'ambient entropy — inject the byte source'],
]);

/** `new Date()` reads the clock; `new Date(iso)` parses its argument and is fine. */
const ZERO_ARG_CONSTRUCTORS = new Map([
  ['Date', 'reads the wall clock — inject `Clock`, then `toIso(clock.now())`'],
]);

/**
 * The boundary. Each of these files exists *so that* nothing else has to do this, and
 * each hands the ambient value to callers through an injectable seam. Entries are
 * symbol-scoped: an allowlisted file still fails on a different violation.
 */
const ALLOWLIST = [
  {
    file: 'packages/shared-kernel/src/clock.ts',
    symbols: ['Date.now'],
    reason: '`SystemClock` is the one sanctioned wall-clock read; everything else takes a `Clock`.',
  },
  {
    file: 'packages/shared-kernel/src/id.ts',
    symbols: ['getRandomValues'],
    reason:
      '`defaultRandomBytes` is the CSPRNG seam behind `IdGenerator`; tests and replays inject their own.',
  },
  {
    file: 'apps/web/src/shims/node-crypto.ts',
    symbols: ['crypto.getRandomValues'],
    reason: 'Browser shim for the seam above — the bundler needs a `node:crypto` stand-in.',
  },
];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cov',
  '.turbo',
  '.git',
  '__fixtures__',
  '__mocks__',
  '__snapshots__',
  'e2e',
  'e2e-live',
]);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.vue'];

/** Tests may fake time freely; that is what a fake is for. */
const SKIP_FILE = /(\.spec|\.test|\.e2e-spec|\.d|\.config)\.[cm]?tsx?$/;

/** Roots are directories, never an expanded file list: Windows caps a command line at ~32 767 chars. */
function defaultRoots() {
  const roots = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(REPO_ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(groupDir, entry.name, 'src');
      if (existsSync(src)) roots.push(src);
    }
  }
  return roots.sort();
}

function* walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    if (SKIP_FILE.test(entry.name)) continue;
    yield full;
  }
}

/** Repo-relative with forward slashes, so a report reads the same on Windows and Linux. */
function repoPath(absolute) {
  return relative(REPO_ROOT, absolute).split(sep).join(posix.sep);
}

/** `a.b.c` for a chain of plain identifiers; undefined for anything else (`this.#x`). */
function dottedName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const left = dottedName(node.expression);
    if (left === undefined) return undefined;
    return `${left}.${node.name.text}`;
  }
  return undefined;
}

/** `globalThis.performance.now()` and `performance.now()` are the same hazard. */
function stripGlobalPrefix(name) {
  return name.replace(/^(?:globalThis|window|self)\./, '');
}

function hasAllowPragma(lines, lineIndex) {
  const here = lines[lineIndex] ?? '';
  const above = lineIndex > 0 ? (lines[lineIndex - 1] ?? '') : '';
  return /determinism-allow:\s*\S/.test(here) || /determinism-allow:\s*\S/.test(above);
}

/**
 * Vue SFCs are not valid TypeScript. Pull each `<script>` body out and remember the line
 * it starts on, so a report points at a line number in the `.vue` file.
 */
function scriptBlocks(source) {
  const blocks = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let match = re.exec(source);
  while (match !== null) {
    const body = match[1] ?? '';
    const bodyStart = match.index + match[0].indexOf(body);
    blocks.push({ body, lineOffset: source.slice(0, bodyStart).split('\n').length - 1 });
    match = re.exec(source);
  }
  return blocks;
}

function scanText(text, lineOffset, file, sourceLines, findings) {
  const sf = ts.createSourceFile(
    file.endsWith('.vue') ? `${file}.ts` : file,
    text,
    ts.ScriptTarget.ESNext,
    false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const report = (node, symbol, why) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const absoluteLine = line + lineOffset;
    if (hasAllowPragma(sourceLines, absoluteLine)) return;
    findings.push({ file, line: absoluteLine + 1, column: character + 1, symbol, why });
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = stripGlobalPrefix(dottedName(node.expression) ?? '');
      const why = FORBIDDEN_CALLS.get(name);
      if (why !== undefined) report(node, `${name}()`, why);
    } else if (ts.isNewExpression(node)) {
      const name = stripGlobalPrefix(dottedName(node.expression) ?? '');
      const why = ZERO_ARG_CONSTRUCTORS.get(name);
      const argc = node.arguments === undefined ? 0 : node.arguments.length;
      if (why !== undefined && argc === 0) report(node, `new ${name}()`, why);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
}

function scanFile(absolute) {
  const file = repoPath(absolute);
  const source = readFileSync(absolute, 'utf8');
  const sourceLines = source.split('\n');
  const findings = [];

  if (file.endsWith('.vue')) {
    for (const block of scriptBlocks(source)) {
      scanText(block.body, block.lineOffset, file, sourceLines, findings);
    }
  } else {
    scanText(source, 0, file, sourceLines, findings);
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const roots = args.length > 0 ? args.map((a) => resolve(a)) : defaultRoots();

  const missing = roots.filter((r) => !existsSync(r));
  if (missing.length > 0) {
    console.error(`determinism-scan: no such directory: ${missing.join(', ')}`);
    process.exit(2);
  }

  const usedAllowances = new Set();
  const violations = [];
  let scanned = 0;

  for (const root of roots) {
    for (const absolute of walk(root)) {
      scanned += 1;
      for (const finding of scanFile(absolute)) {
        const bare = finding.symbol.replace(/^new /, '').replace(/\(\)$/, '');
        const allowed = ALLOWLIST.find(
          (entry) => entry.file === finding.file && entry.symbols.includes(bare),
        );
        if (allowed !== undefined) {
          usedAllowances.add(`${allowed.file}::${bare}`);
          continue;
        }
        violations.push(finding);
      }
    }
  }

  // Only meaningful over the default scope: a hand-picked directory legitimately contains
  // none of the allowlisted files, and reporting all three as stale would be noise.
  const stale =
    args.length > 0
      ? []
      : ALLOWLIST.flatMap((entry) =>
          entry.symbols
            .filter((symbol) => !usedAllowances.has(`${entry.file}::${symbol}`))
            .map((symbol) => `${entry.file} :: ${symbol}`),
        );

  for (const v of violations) {
    if (IN_ACTIONS) {
      console.error(
        `::error file=${v.file},line=${v.line},col=${v.column},title=Determinism (CLAUDE.md #1)::${v.symbol} ${v.why}`,
      );
    }
    console.error(`  x ${v.file}:${v.line}:${v.column}  ${v.symbol} — ${v.why}`);
  }

  // A stale entry cannot let a violation through — entries are symbol-scoped — so this
  // warns rather than fails. Failing here would turn an unrelated refactor red.
  for (const entry of stale) {
    if (IN_ACTIONS) console.log(`::warning title=Stale determinism allowlist::${entry}`);
    console.warn(`  ! stale allowlist entry, delete it: ${entry}`);
  }

  const where =
    args.length > 0 ? roots.map(repoPath).join(', ') : `${roots.length} package sources`;

  if (violations.length > 0) {
    console.error(
      `\ndeterminism-scan: ${violations.length} violation(s) in ${scanned} files (${where}).`,
    );
    console.error('CLAUDE.md #1: inject `Clock`, or seed an `Rng`. See packages/shared-kernel.');
    process.exit(1);
  }

  console.log(
    `determinism-scan: clean — ${scanned} files, ${where}, ${ALLOWLIST.length} allowlisted boundary file(s).`,
  );
}

try {
  main();
} catch (error) {
  console.error('determinism-scan: failed to run');
  console.error(error);
  process.exit(2);
}
