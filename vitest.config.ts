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
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
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
      ],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
        // The pure layers have no IO and therefore no excuse.
        // CLAUDE.md §3 names three of them; `contracts` was missing from this list, so
        // the 100 % it owes was never actually being measured - it sat at 97 % lines and
        // 86 % functions under a global 90/85 that it comfortably cleared.
        'packages/contracts/src/**': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'packages/core-domain/src/**': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'packages/anim-engine/src/**': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});
