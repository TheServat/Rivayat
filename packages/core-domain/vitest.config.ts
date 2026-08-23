import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core-domain',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
