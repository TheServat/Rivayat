import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'render-engine',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
