import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'asset-registry',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
