import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'asset-engine',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
