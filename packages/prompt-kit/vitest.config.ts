import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'prompt-kit',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
