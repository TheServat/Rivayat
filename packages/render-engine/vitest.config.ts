import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'render-engine',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // The end-to-end suites spawn FFmpeg and encode seven 1080p+ deliverables; the
    // default 5 s ceiling is a timeout on the encoder, not on the test.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/__fixtures__/**', 'src/**/*.spec.ts'],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
