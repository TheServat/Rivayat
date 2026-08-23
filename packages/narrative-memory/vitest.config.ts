import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'narrative-memory',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
