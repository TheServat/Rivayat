import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'providers',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
