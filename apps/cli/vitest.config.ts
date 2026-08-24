import { defineConfig } from 'vitest/config';

/**
 * `apps/cli` had no config of its own, so `vitest run` inside it resolved the *root*
 * workspace file, found no project matching its own directory, and failed at startup
 * with "No projects were found". A recursive `pnpm test` therefore stopped at the CLI
 * before reaching `apps/api` - the package with zero tests was also the package that
 * hid every package after it.
 */
export default defineConfig({
  test: {
    // Every package's config carries a name (CLAUDE.md section 3) so a failure in the
    // root run says which project it came from.
    name: '@rv/cli',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // The CLI shells out to FFmpeg and rasterises frames; a few seconds is normal.
    testTimeout: 30_000,
  },
});
