import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'story-engine',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
