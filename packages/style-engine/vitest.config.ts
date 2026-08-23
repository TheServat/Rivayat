import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'style-engine',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
