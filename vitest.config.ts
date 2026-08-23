import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration.
 *
 * Vitest 4 replaced `vitest.workspace.ts` with the inline `projects` field.
 * Each package/app may still ship its own `vitest.config.ts`; those are picked
 * up by the glob below and merged with these defaults.
 *
 * The globs name the config file rather than the directory: a directory glob
 * also matches stray non-project entries (`apps/.gitkeep`) and Vitest 4 aborts
 * on those with a startup error instead of skipping them.
 */

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** CLAUDE.md §3: pure, no IO, no excuse. */
const PURE_LAYERS = new Set(['contracts', 'core-domain', 'anim-engine']);

const PERFECT = { lines: 100, branches: 100, functions: 100, statements: 100 } as const;

/** CLAUDE.md §3 for everything else: 90 % lines / 85 % branches. */
const FLOOR = { lines: 90, branches: 85, functions: 90, statements: 90 } as const;

/**
 * Packages that do not clear FLOOR today, pinned at the value measured on 2026-08-23 so
 * they can only go up. A ratchet, not a waiver: the number here is the number that was
 * actually achieved, and any regression fails the build the same way a breach of FLOOR
 * would. Delete an entry the moment its package reaches FLOOR.
 *
 * Both gaps are branch coverage, and both were invisible until this file started
 * measuring per package: the workspace-wide average was 89.5 % branches, comfortably
 * over the 85 % floor, because thirteen packages above 90 % were paying for these two.
 */
const RATCHET: Record<string, typeof FLOOR> = {
  // 78.32 % branches — the error and cancellation arms of the pipeline controllers.
  // docs/05-remaining-work.md W4 ("cancellation distinguishable from failure") is the
  // same hole seen from the other side.
  'apps/api': { ...FLOOR, branches: 78 },
  // 84.34 % branches — the repair/escalate ladder in StructuredCall. 0.7 pp short.
  'packages/prompt-kit': { ...FLOOR, branches: 84 },
};

/**
 * One floor per package, never one average over all of them.
 *
 * A single workspace-wide threshold lets a 100 %-covered package pay for an uncovered
 * one, which is the opposite of what a floor is for. Generated from the filesystem
 * rather than hand-listed so that a new package is enforced from its first commit
 * instead of silently inheriting the average.
 */
function perPackageThresholds(): Record<string, typeof FLOOR> {
  const thresholds: Record<string, typeof FLOOR> = {};
  for (const group of ['packages', 'apps']) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!existsSync(join(groupDir, entry.name, 'src'))) continue;
      const id = `${group}/${entry.name}`;
      thresholds[`${id}/src/**`] = PURE_LAYERS.has(entry.name)
        ? { ...PERFECT }
        : (RATCHET[id] ?? { ...FLOOR });
    }
  }
  return thresholds;
}

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        '**/*.config.*',
        '**/*.d.ts',
        '**/__fixtures__/**',
        '**/__mocks__/**',
        '**/test/**',
        '**/index.ts',
        // Needs a live Redis to exercise at all. The in-process queue driver - the one
        // the local-first constraint requires and the one that actually runs by
        // default - is covered normally. A Redis-gated integration suite is the real
        // answer; excluding it is honest in the meantime.
        'apps/api/src/queue/bullmq.queue.ts',
      ],
      thresholds: {
        // A backstop for source that no per-package glob claims. Every package gets its
        // own entry below, so in a healthy workspace this applies to nothing.
        ...FLOOR,
        ...perPackageThresholds(),
      },
    },
  },
});
