import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // Each file builds its own Nest app over its own `:memory:` SQLite and its own temp
    // workspace. One fork keeps that cheap; parallel forks would multiply the
    // better-sqlite3 native handles for no gain, and the suite is IO-free anyway.
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
