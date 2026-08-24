/**
 * `pnpm --filter @rv/anim-engine bless:goldens` - the one way to move a blessed hash.
 *
 * A golden nobody can update is a golden people delete, so re-blessing has to be easy.
 * A golden that updates itself is worse than no golden at all, so it must never happen
 * as a side effect of running the suite. This script is the reconciliation: an explicit
 * command, run deliberately, whose entire output is a checked-in file that shows up in
 * the diff next to the change that justified it.
 *
 * It prints what moved before it writes, because "4 hashes changed" is the sentence that
 * should make somebody stop and check they meant it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  GOLDEN_FILE_URL,
  computeGoldens,
  serialiseGoldens,
} from '../src/__fixtures__/golden-clips';

const next = computeGoldens();
const serialised = serialiseGoldens(next);

const previous: Record<string, { clipHash?: string }> = existsSync(GOLDEN_FILE_URL)
  ? (JSON.parse(readFileSync(GOLDEN_FILE_URL, 'utf8')) as Record<string, { clipHash?: string }>)
  : {};

const changed: string[] = [];
for (const [name, golden] of Object.entries(next)) {
  const before = previous[name]?.clipHash;
  if (before === golden.clipHash) continue;
  changed.push(
    `  ${before === undefined ? 'new    ' : 'changed'} ${name}: ${before ?? '(none)'} -> ${golden.clipHash}`,
  );
}
const removed = Object.keys(previous).filter((name) => !name.startsWith('$') && !(name in next));

process.stdout.write(`Blessing ${String(Object.keys(next).length)} golden clip(s)\n`);
for (const line of changed) process.stdout.write(`${line}\n`);
for (const name of removed) process.stdout.write(`  removed ${name}\n`);
if (changed.length === 0 && removed.length === 0) {
  process.stdout.write('  nothing moved; the file is already correct\n');
}

writeFileSync(GOLDEN_FILE_URL, serialised, 'utf8');
process.stdout.write(`Wrote ${GOLDEN_FILE_URL.pathname}\n`);
