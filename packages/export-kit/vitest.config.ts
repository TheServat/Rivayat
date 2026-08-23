import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'export-kit',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
